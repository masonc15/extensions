import { LocalStorage as _LocalStorage } from "@raycast/api";
import { cacheFolders, getCachedFolders } from "~/components/searchVault/utils/folderCache";
import { FOLDER_CACHE_TTL_MS, LOCAL_STORAGE_KEY } from "~/constants/general";
import { getMockFolders } from "~/utils/testing/mocks";

const LocalStorage = _LocalStorage as jest.Mocked<typeof _LocalStorage>;

const MOCK_FOLDERS = getMockFolders(2);

describe("folderCache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns cached folders when the cache is fresh", async () => {
    LocalStorage.getItem.mockImplementation((key: string) => {
      if (key === LOCAL_STORAGE_KEY.CACHED_FOLDERS) return Promise.resolve(JSON.stringify(MOCK_FOLDERS));
      if (key === LOCAL_STORAGE_KEY.CACHED_FOLDERS_TIME) return Promise.resolve(Date.now());
      return Promise.resolve(undefined);
    });

    await expect(getCachedFolders()).resolves.toEqual(MOCK_FOLDERS);
  });

  test("returns null when the cache is stale", async () => {
    LocalStorage.getItem.mockImplementation((key: string) => {
      if (key === LOCAL_STORAGE_KEY.CACHED_FOLDERS) return Promise.resolve(JSON.stringify(MOCK_FOLDERS));
      if (key === LOCAL_STORAGE_KEY.CACHED_FOLDERS_TIME)
        return Promise.resolve(Date.now() - FOLDER_CACHE_TTL_MS - 1000);
      return Promise.resolve(undefined);
    });

    await expect(getCachedFolders()).resolves.toBeNull();
  });

  test("returns null when the cache is missing or corrupt", async () => {
    LocalStorage.getItem.mockImplementation(() => Promise.resolve(undefined));
    await expect(getCachedFolders()).resolves.toBeNull();

    LocalStorage.getItem.mockImplementation((key: string) => {
      if (key === LOCAL_STORAGE_KEY.CACHED_FOLDERS) return Promise.resolve("not-json{{{");
      if (key === LOCAL_STORAGE_KEY.CACHED_FOLDERS_TIME) return Promise.resolve(Date.now());
      return Promise.resolve(undefined);
    });
    await expect(getCachedFolders()).resolves.toBeNull();
  });

  test("stores folders with a timestamp", async () => {
    await cacheFolders(MOCK_FOLDERS);

    expect(LocalStorage.setItem).toHaveBeenCalledWith(LOCAL_STORAGE_KEY.CACHED_FOLDERS, JSON.stringify(MOCK_FOLDERS));
    expect(LocalStorage.setItem).toHaveBeenCalledWith(LOCAL_STORAGE_KEY.CACHED_FOLDERS_TIME, expect.any(Number));
  });
});
