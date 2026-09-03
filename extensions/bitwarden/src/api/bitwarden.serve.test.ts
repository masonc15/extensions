import { getPreferenceValues as _getPreferenceValues } from "@raycast/api";
import { execa as _execa } from "execa";
import { Bitwarden } from "~/api/bitwarden";
import { VaultIsLockedError } from "~/utils/errors";

jest.mock("execa", () => ({
  execa: jest.fn(),
  ExecaChildProcess: Object,
  ExecaError: class extends Error {},
  ExecaReturnValue: Object,
}));

jest.mock("~/api/serve", () => {
  const actual = jest.requireActual<typeof import("~/api/serve")>("~/api/serve");
  return { ...actual, ServeDaemon: { ensure: jest.fn() } };
});

jest.mock("~/utils/platform", () => ({
  get platform() {
    return process.platform === "darwin" ? "macos" : "windows";
  },
}));

import { ServeDaemon } from "~/api/serve";

const execa = _execa as jest.MockedFunction<typeof _execa>;
const getPreferenceValues = _getPreferenceValues as jest.MockedFunction<typeof _getPreferenceValues>;
const mockEnsure = ServeDaemon.ensure as unknown as jest.Mock;

const MOCK_PREFS = {
  cliPath: process.execPath,
  clientId: "client-id",
  clientSecret: "client-secret",
  fetchFavicons: true,
  serverUrl: "",
  serverCertsPath: "",
  repromptIgnoreDuration: "0",
  generatePasswordQuickAction: "copyAndPaste",
  transientCopySearch: "always",
  transientCopyGeneratePassword: "always",
  transientCopyGeneratePasswordQuick: "always",
  shouldCacheVaultItems: true,
  windowActionOnCopy: "close",
  primaryAction: "copy",
  syncOnLaunch: true,
  serveDaemon: true,
};

const MOCK_ITEM = {
  object: "item",
  id: "item-id",
  name: "example.com",
  login: { username: "user", password: "secret" },
};

function mockDaemon(overrides?: { get?: jest.Mock; post?: jest.Mock; stop?: jest.Mock }) {
  return {
    baseUrl: "http://localhost:8087",
    port: 8087,
    get: jest.fn(),
    post: jest.fn(),
    stop: jest.fn(),
    ...overrides,
  };
}

describe("Bitwarden serve fast path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPreferenceValues.mockReturnValue(MOCK_PREFS);
    execa.mockResolvedValue({ stdout: "", stderr: "" } as never);
  });

  async function unlockedBitwarden(): Promise<Bitwarden> {
    const bitwarden = new Bitwarden();
    // Drain the background init (CLI checks) so per-test execa assertions only see the action under test.
    await bitwarden.initialize();
    execa.mockClear();
    bitwarden.setSessionToken("session-token");
    return bitwarden;
  }

  test("serves listItems without spawning the CLI", async () => {
    const daemon = mockDaemon({
      get: jest.fn(() => Promise.resolve({ success: true, data: [MOCK_ITEM] })),
    });
    mockEnsure.mockResolvedValue(daemon);

    const bitwarden = await unlockedBitwarden();
    const { error, result } = await bitwarden.listItems();

    expect(error).toBeUndefined();
    expect(result).toEqual([MOCK_ITEM]);
    expect(daemon.get).toHaveBeenCalledWith("/list/object/items");
    expect(execa).not.toHaveBeenCalledWith(expect.anything(), ["list", "items"], expect.anything());
  });

  test("unwraps template-wrapped status responses", async () => {
    const daemon = mockDaemon({
      get: jest.fn(() =>
        Promise.resolve({
          success: true,
          data: { object: "template", template: { status: "unlocked", userEmail: "u@e.c" } },
        })
      ),
    });
    mockEnsure.mockResolvedValue(daemon);

    const bitwarden = await unlockedBitwarden();
    const { error, result } = await bitwarden.status();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ status: "unlocked" });
    expect(execa).not.toHaveBeenCalledWith(expect.anything(), ["status"], expect.anything());
  });

  test("falls back to the CLI when the server is unreachable", async () => {
    mockEnsure.mockRejectedValue(new Error("no server"));
    execa.mockResolvedValue({ stdout: JSON.stringify([MOCK_ITEM]), stderr: "" } as never);

    const bitwarden = await unlockedBitwarden();
    const { error, result } = await bitwarden.listItems();

    expect(error).toBeUndefined();
    expect(result).toEqual([MOCK_ITEM]);
    expect(execa).toHaveBeenCalledWith(process.execPath, ["list", "items"], expect.anything());
  });

  test("maps locked-vault server errors without a CLI round trip", async () => {
    const daemon = mockDaemon({
      get: jest.fn(() => Promise.resolve({ success: false, message: "Vault is locked." })),
    });
    mockEnsure.mockResolvedValue(daemon);

    const bitwarden = await unlockedBitwarden();
    const { error } = await bitwarden.listItems();

    expect(error).toBeInstanceOf(VaultIsLockedError);
    expect(execa).toHaveBeenCalledWith(process.execPath, ["lock"], expect.anything());
    expect(execa).not.toHaveBeenCalledWith(process.execPath, ["list", "items"], expect.anything());
    expect(daemon.stop).toHaveBeenCalled();
  });

  test("skips the server for one-off session tokens", async () => {
    const daemon = mockDaemon({
      get: jest.fn(() => Promise.resolve({ success: true, data: MOCK_ITEM })),
    });
    mockEnsure.mockResolvedValue(daemon);
    execa.mockResolvedValue({ stdout: JSON.stringify(MOCK_ITEM), stderr: "" } as never);

    const bitwarden = await unlockedBitwarden();
    const { error, result } = await bitwarden.withSession("one-off-token").getItem("item-id");

    expect(error).toBeUndefined();
    expect(result).toEqual(MOCK_ITEM);
    expect(daemon.get).not.toHaveBeenCalled();
    expect(execa).toHaveBeenCalledWith(process.execPath, ["get", "item", "item-id"], expect.anything());
  });

  test("stops the server on lock", async () => {
    const daemon = mockDaemon({
      get: jest.fn(() => Promise.resolve({ success: true, data: [] })),
    });
    mockEnsure.mockResolvedValue(daemon);

    const bitwarden = await unlockedBitwarden();
    await bitwarden.listItems();
    await bitwarden.lock();

    expect(daemon.stop).toHaveBeenCalled();
    expect(execa).toHaveBeenCalledWith(process.execPath, ["lock"], expect.anything());
  });
});
