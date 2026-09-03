import { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  ServeApiError,
  ServeDaemon,
  ServeTransportError,
  isPidAlive,
  unwrapServeList,
  unwrapServeObject,
  unwrapServeTotp,
} from "~/api/serve";

type FakeResponse = { status: number; json: () => Promise<unknown> };
const okResponse = (data: unknown): FakeResponse => ({ status: 200, json: () => Promise.resolve(data) });

const UNLOCKED_STATUS = {
  success: true,
  data: {
    object: "template",
    template: {
      serverUrl: null,
      lastSync: "2026-09-03T00:00:00.000Z",
      userEmail: "user@example.com",
      userId: "user-id",
      status: "unlocked",
    },
  },
};

class FakeChild extends EventEmitter {
  pid: number | undefined = 12345;
  exitCode: number | null = null;
  killed = false;
  kill = jest.fn(() => {
    this.killed = true;
    return true;
  });

  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

type FakeSpawn = () => ChildProcess;
const fakeSpawn = (child: FakeChild): FakeSpawn => (() => child) as unknown as FakeSpawn;

type SpawnCall = [command: string, args: string[], options: unknown];
function spawnedPort(spawnImpl: jest.Mock, callIndex: number): number {
  const call = (spawnImpl.mock.calls as unknown as SpawnCall[])[callIndex];
  if (!call) throw new Error(`spawn call ${callIndex} missing`);
  return Number(call[1][2]);
}

describe("unwrapServeList", () => {
  test("accepts a bare array", () => {
    expect(unwrapServeList([{ id: 1 }])).toEqual([{ id: 1 }]);
  });

  test("unwraps the nested list envelope", () => {
    expect(unwrapServeList({ success: true, data: { object: "list", data: [{ id: 1 }] } })).toEqual([{ id: 1 }]);
  });

  test("throws ServeApiError for vault errors", () => {
    expect(() => unwrapServeList({ success: false, message: "Vault is locked." })).toThrow(ServeApiError);
  });

  test("throws ServeTransportError for malformed responses", () => {
    expect(() => unwrapServeList(null)).toThrow(ServeTransportError);
    expect(() => unwrapServeList({ success: true, data: { object: "list" } })).toThrow(ServeTransportError);
  });
});

describe("unwrapServeObject", () => {
  test("passes bare objects through", () => {
    expect(unwrapServeObject({ id: "a" })).toEqual({ id: "a" });
  });

  test("unwraps template-wrapped payloads (status endpoint)", () => {
    expect(unwrapServeObject(UNLOCKED_STATUS)).toEqual(UNLOCKED_STATUS.data.template);
  });

  test("unwraps nested data payloads", () => {
    expect(unwrapServeObject({ success: true, data: { object: "item", data: { id: "a" } } })).toEqual({ id: "a" });
  });

  test("throws ServeApiError for vault errors", () => {
    expect(() => unwrapServeObject({ success: false, message: "Vault is locked." })).toThrow(ServeApiError);
  });
});

describe("unwrapServeTotp", () => {
  test("accepts a bare string", () => {
    expect(unwrapServeTotp({ success: true, data: "123456" })).toBe("123456");
  });

  test("unwraps nested string payloads", () => {
    expect(unwrapServeTotp({ success: true, data: { object: "string", data: "123456" } })).toBe("123456");
  });

  test("throws for non-string payloads", () => {
    expect(() => unwrapServeTotp({ success: true, data: { object: "item" } })).toThrow(ServeTransportError);
  });
});

describe("isPidAlive", () => {
  test("detects live and dead pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2147483647)).toBe(false);
  });
});

describe("ServeDaemon.ensure", () => {
  let supportPath: string;

  beforeEach(async () => {
    supportPath = await mkdtemp(join(tmpdir(), "bw-serve-test-"));
  });

  test("spawns on the default port and records a pidfile", async () => {
    const child = new FakeChild();
    const spawnImpl = jest.fn(fakeSpawn(child));
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockImplementation(() => Promise.resolve(okResponse(UNLOCKED_STATUS)));

    const daemon = await ServeDaemon.ensure({
      cliPath: "/usr/local/bin/bw",
      env: { BW_SESSION: "token" },
      supportPath,
      deps: { spawnImpl, fetchImpl },
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith("/usr/local/bin/bw", ["serve", "--port", "8087"], expect.anything());
    expect(daemon.baseUrl).toBe("http://localhost:8087");
    const pidfile = JSON.parse(await readFile(join(supportPath, "bw-serve.json"), "utf8"));
    expect(pidfile).toMatchObject({ pid: 12345, port: 8087 });
  });

  test("adopts a healthy same-install daemon without spawning", async () => {
    const killSpy = jest.spyOn(process, "kill").mockImplementation(() => undefined as never);
    try {
      const { writeFile } = await import("fs/promises");
      await writeFile(join(supportPath, "bw-serve.json"), JSON.stringify({ pid: 424242, port: 9999 }));
      const spawnImpl = jest.fn(fakeSpawn(new FakeChild()));
      const fetchImpl = jest.fn(() => Promise.resolve(okResponse(UNLOCKED_STATUS)));

      const daemon = await ServeDaemon.ensure({
        cliPath: "/usr/local/bin/bw",
        env: { BW_SESSION: "token" },
        supportPath,
        deps: { spawnImpl, fetchImpl },
      });

      expect(spawnImpl).not.toHaveBeenCalled();
      expect(daemon.baseUrl).toBe("http://localhost:9999");

      await daemon.stop();
      expect(killSpy).toHaveBeenCalledWith(424242, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });

  test("moves to an ephemeral port when the default is occupied", async () => {
    const liveChild = new FakeChild();
    const spawnImpl = jest.fn(fakeSpawn(liveChild));
    // A healthy foreign occupant answers probes, so the default port is skipped.
    const fetchImpl = jest.fn(() => Promise.resolve(okResponse(UNLOCKED_STATUS)));

    const daemon = await ServeDaemon.ensure({
      cliPath: "/usr/local/bin/bw",
      env: { BW_SESSION: "token" },
      supportPath,
      deps: { spawnImpl, fetchImpl },
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const usedPort = spawnedPort(spawnImpl, 0);
    expect(usedPort).not.toBe(8087);
    expect(daemon.port).toBe(usedPort);
    expect(daemon.baseUrl).toBe(`http://localhost:${usedPort}`);
  });

  test("retries when a spawned server exits immediately", async () => {
    const deadChild = new FakeChild();
    const liveChild = new FakeChild();
    const spawnImpl = jest
      .fn()
      .mockReturnValueOnce(deadChild as unknown as ChildProcess)
      .mockReturnValue(liveChild as unknown as ChildProcess);
    setTimeout(() => deadChild.exit(1), 10);
    let probes = 0;
    const fetchImpl = jest.fn(() => {
      probes++;
      // Nothing healthy until the second spawn is probed.
      if (probes <= 2) return Promise.reject(new Error("connect ECONNREFUSED"));
      return Promise.resolve(okResponse(UNLOCKED_STATUS));
    });

    const daemon = await ServeDaemon.ensure({
      cliPath: "/usr/local/bin/bw",
      env: { BW_SESSION: "token" },
      supportPath,
      deps: { spawnImpl, fetchImpl },
    });

    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(daemon.port).toBe(spawnedPort(spawnImpl, 1));
  });

  test("request failures surface as transport errors, vault errors as API errors", async () => {
    const child = new FakeChild();
    const fetchImpl = jest.fn(() => Promise.resolve(okResponse(UNLOCKED_STATUS)));
    const daemon = await ServeDaemon.ensure({
      cliPath: "/usr/local/bin/bw",
      env: {},
      supportPath,
      deps: { spawnImpl: jest.fn(fakeSpawn(child)), fetchImpl },
    });

    fetchImpl.mockImplementationOnce(() => {
      throw new Error("socket hang up");
    });
    await expect(daemon.get("/list/object/items")).rejects.toThrow(ServeTransportError);

    fetchImpl.mockImplementationOnce(() =>
      Promise.resolve(okResponse({ success: false, message: "Vault is locked." }))
    );
    const apiError = await daemon.get("/list/object/items").catch((error) => error);
    expect(apiError).toBeInstanceOf(ServeApiError);
    expect((apiError as ServeApiError).message).toBe("Vault is locked.");
  });
});
