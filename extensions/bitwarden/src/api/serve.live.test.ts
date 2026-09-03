import { existsSync } from "fs";
import { mkdtemp, readFile, copyFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ServeApiError, ServeDaemon, ServeTransportError } from "~/api/serve";

// Live integration against the real Bitwarden CLI (localhost only).
// The logged-out case needs no credentials. The logged-in case uses a vault
// state dir supplied via BW_SERVE_TEST_APPDATA (never committed).
const CLI_CANDIDATES = ["/opt/homebrew/bin/bw", "/usr/local/bin/bw", "C:\\ProgramData\\chocolatey\\bin\\bw.exe"];
const cliPath = CLI_CANDIDATES.find((candidate) => existsSync(candidate));
const describeLive = cliPath ? describe : describe.skip;

describeLive("ServeDaemon live (real bw CLI)", () => {
  test("fails fast when no login exists (server cannot run logged-out)", async () => {
    const supportPath = await mkdtemp(join(tmpdir(), "bw-serve-live-"));
    const startedAt = Date.now();
    await expect(
      ServeDaemon.ensure({
        cliPath: cliPath as string,
        env: { ...process.env, BITWARDENCLI_APPDATA_DIR: supportPath },
        supportPath,
      })
    ).rejects.toThrow(ServeTransportError);
    // Fast exit detection, not the 15s readiness timeout.
    expect(Date.now() - startedAt).toBeLessThan(14000);
  }, 30000);

  const loggedInAppData = process.env.BW_SERVE_TEST_APPDATA;
  (loggedInAppData ? describe : describe.skip)("with a logged-in vault", () => {
    test("serves status and locked reads, then stops cleanly", async () => {
      const supportPath = await mkdtemp(join(tmpdir(), "bw-serve-live-"));
      await copyFile(join(loggedInAppData as string, "data.json"), join(supportPath, "data.json"));
      const daemon = await ServeDaemon.ensure({
        cliPath: cliPath as string,
        env: { ...process.env, BITWARDENCLI_APPDATA_DIR: supportPath },
        supportPath,
      });
      try {
        const status = await daemon.get("/status");
        expect(status).toMatchObject({ success: true });
        await expect(daemon.get("/list/object/items")).rejects.toThrow(ServeApiError);
      } finally {
        await daemon.stop();
      }
      await expect(readFile(join(supportPath, "bw-serve.json"), "utf8")).rejects.toThrow();
    }, 30000);
  });
});
