import { ChildProcess, spawn } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { AddressInfo, createServer } from "net";

export const SERVE_DEFAULT_PORT = 8087;

const SERVE_PID_FILENAME = "bw-serve.json";
const SERVE_READY_TIMEOUT_MS = 15000;
const SERVE_POLL_INTERVAL_MS = 250;
const SERVE_REQUEST_TIMEOUT_MS = 10000;
const SERVE_MAX_SPAWN_ATTEMPTS = 3;

/** Vault-level error reported by the API server (e.g. locked vault). */
export class ServeApiError extends Error {
  constructor(message: string, readonly httpStatus: number) {
    super(message);
    this.name = "ServeApiError";
  }
}

/** Transport failure: server unreachable, timeout, or malformed response. Callers fall back to the CLI. */
export class ServeTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeTransportError";
  }
}

export type ServeStatus = {
  serverUrl: string | null;
  lastSync: string;
  userEmail: string;
  userId: string;
  status: "unlocked" | "locked" | "unauthenticated";
};

export type FetchImpl = (
  url: string,
  init?: { method?: string; signal?: AbortSignal }
) => Promise<{ status: number; json(): Promise<unknown> }>;

export type SpawnImpl = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: "ignore" }
) => ChildProcess;

export type ServeDeps = {
  spawnImpl?: SpawnImpl;
  fetchImpl?: FetchImpl;
};

type ResolvedDeps = {
  spawnImpl: SpawnImpl;
  fetchImpl: FetchImpl;
};

function resolveDeps(deps?: ServeDeps): ResolvedDeps {
  return {
    spawnImpl: deps?.spawnImpl ?? ((command, args, options) => spawn(command, args, options)),
    fetchImpl: deps?.fetchImpl ?? ((url, init) => fetch(url, init)),
  };
}

type ServeEnvelope = {
  success?: boolean;
  message?: string;
  data?: unknown;
};

function readEnvelope(json: unknown): ServeEnvelope {
  if (!json || typeof json !== "object") throw new ServeTransportError("Invalid API server response");
  const envelope = json as ServeEnvelope;
  if (envelope.success === false) {
    throw new ServeApiError(String(envelope.message ?? "Request failed"), 0);
  }
  return envelope;
}

/** Unwraps `{"success":true,"data":[...]}` or a bare array (list endpoints). */
export function unwrapServeList<T>(json: unknown): T[] {
  if (Array.isArray(json)) return json as T[];
  const { data } = readEnvelope(json);
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)) {
    return (data as { data: T[] }).data;
  }
  throw new ServeTransportError("Unexpected API server list response");
}

/**
 * Unwraps single-object responses: bare objects, `{object:"template",template:{...}}`
 * (status endpoint) and `{object:...,data:{...}}` shapes.
 */
export function unwrapServeObject<T>(json: unknown): T {
  if (typeof json === "string") return json as unknown as T;
  const envelope = readEnvelope(json);
  if (envelope.success === undefined && envelope.data === undefined) return json as T;
  const { data } = envelope;
  if (typeof data === "string") return data as unknown as T;
  if (data && typeof data === "object") {
    const record = data as { data?: unknown; template?: unknown };
    if (record.data && typeof record.data === "object" && "id" in (record.data as object)) {
      return record.data as T;
    }
    if (record.template && typeof record.template === "object") return record.template as T;
    return data as T;
  }
  throw new ServeTransportError("Unexpected API server response");
}

/** Unwraps TOTP responses: a bare string or `{...data:"123456"}`. */
export function unwrapServeTotp(json: unknown): string {
  const value = unwrapServeObject<unknown>(json);
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const inner = (value as { data?: unknown }).data;
    if (typeof inner === "string") return inner;
  }
  throw new ServeTransportError("Unexpected API server TOTP response");
}

type PidFile = { pid: number; port: number; startedAt: string };

function pidFilePath(supportPath: string): string {
  return join(supportPath, SERVE_PID_FILENAME);
}

async function readPidFile(supportPath: string): Promise<PidFile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(pidFilePath(supportPath), "utf8")) as Partial<PidFile>;
    // pid must be positive: process.kill(0, ...) signals the whole process group.
    if (typeof parsed.pid !== "number" || parsed.pid <= 0 || typeof parsed.port !== "number") return null;
    return { pid: parsed.pid, port: parsed.port, startedAt: String(parsed.startedAt ?? "") };
  } catch {
    return null;
  }
}

async function writePidFile(supportPath: string, info: PidFile): Promise<void> {
  try {
    await fs.writeFile(pidFilePath(supportPath), JSON.stringify(info));
  } catch {
    // Best effort: lifecycle tracking must never break vault access.
  }
}

async function deletePidFile(supportPath: string): Promise<void> {
  try {
    await fs.unlink(pidFilePath(supportPath));
  } catch {
    // Already gone.
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probeStatus(port: number, fetchImpl: FetchImpl): Promise<ServeStatus | null> {
  try {
    const response = await fetchImpl(`http://localhost:${port}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.status !== 200) return null;
    return unwrapServeObject<ServeStatus>(await response.json());
  } catch {
    return null;
  }
}

function ephemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lifecycle-managed `bw serve` daemon. The server keeps the decrypted vault in
 * memory, so reads answer in milliseconds instead of paying ~1.5s of CLI
 * startup per call. Ownership is tracked via a pidfile in the extension's own
 * support dir (shared by every view of this install), so orphans from crashed
 * workers are adopted and everything is stopped on lock/logout.
 */
export class ServeDaemon {
  private constructor(
    readonly baseUrl: string,
    readonly port: number,
    private child: ChildProcess | null,
    private supportPath: string,
    private deps: ResolvedDeps
  ) {}

  static async ensure(options: {
    cliPath: string;
    env: NodeJS.ProcessEnv;
    supportPath: string;
    deps?: ServeDeps;
  }): Promise<ServeDaemon> {
    const deps = resolveDeps(options.deps);

    // Adopt an orphan from a crashed worker: same support dir proves ownership.
    const previous = await readPidFile(options.supportPath);
    if (previous && isPidAlive(previous.pid)) {
      const status = await probeStatus(previous.port, deps.fetchImpl);
      if (status?.status === "unlocked") {
        return new ServeDaemon(`http://localhost:${previous.port}`, previous.port, null, options.supportPath, deps);
      }
    }

    // A healthy occupant answers probes long before our spawn would fail to bind,
    // so skip the default port up front instead of racing it.
    const defaultOccupied = (await probeStatus(SERVE_DEFAULT_PORT, deps.fetchImpl)) !== null;
    const ports: number[] = defaultOccupied ? [] : [SERVE_DEFAULT_PORT];
    while (ports.length < SERVE_MAX_SPAWN_ATTEMPTS) ports.push(await ephemeralPort());

    let lastError: unknown = null;
    for (const port of ports) {
      try {
        const child = await ServeDaemon.spawnReady({
          ...options,
          port,
          spawnImpl: deps.spawnImpl,
          fetchImpl: deps.fetchImpl,
        });
        // Without a pid there is no safe ownership record; the daemon still works,
        // it just won't be adoptable/killable after a worker crash.
        if (child.pid) {
          await writePidFile(options.supportPath, {
            pid: child.pid,
            port,
            startedAt: new Date().toISOString(),
          });
        }
        return new ServeDaemon(`http://localhost:${port}`, port, child, options.supportPath, deps);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new ServeTransportError("Failed to start API server");
  }

  private static async spawnReady(options: {
    cliPath: string;
    env: NodeJS.ProcessEnv;
    port: number;
    spawnImpl: SpawnImpl;
    fetchImpl: FetchImpl;
  }): Promise<ChildProcess> {
    let child: ChildProcess;
    try {
      child = options.spawnImpl(options.cliPath, ["serve", "--port", String(options.port)], {
        env: options.env,
        stdio: "ignore",
      });
    } catch (error) {
      throw new ServeTransportError(`Failed to spawn API server: ${String(error)}`);
    }
    // Avoid an unhandled 'error' crash; liveness is determined by probing below.
    child.on("error", () => undefined);

    const deadline = Date.now() + SERVE_READY_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new ServeTransportError(`API server exited during startup (code ${child.exitCode})`);
        }
        const status = await probeStatus(options.port, options.fetchImpl);
        if (status) return child;
        await sleep(SERVE_POLL_INTERVAL_MS);
      }
    } catch (error) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      throw error;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    throw new ServeTransportError("API server did not become ready in time");
  }

  get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  post(path: string): Promise<unknown> {
    return this.request("POST", path);
  }

  private async request(method: string, path: string): Promise<unknown> {
    let response: { status: number; json(): Promise<unknown> };
    try {
      response = await this.deps.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(SERVE_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ServeTransportError(
        `API server unreachable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ServeTransportError("Invalid API server response");
    }
    const envelope = json as ServeEnvelope;
    if (envelope && typeof envelope === "object" && envelope.success === false) {
      throw new ServeApiError(String(envelope.message ?? "Request failed"), response.status);
    }
    return json;
  }

  /** Stops the daemon: own child, plus any same-install orphan via the pidfile. Never throws. */
  async stop(): Promise<void> {
    try {
      if (this.child && this.child.exitCode === null) {
        try {
          this.child.kill("SIGTERM");
        } catch {
          // Already gone.
        }
      }
      const info = await readPidFile(this.supportPath);
      if (info) {
        try {
          process.kill(info.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
        await deletePidFile(this.supportPath);
      }
    } catch {
      // Stopping must never break lock/logout flows.
    } finally {
      this.child = null;
    }
  }
}
