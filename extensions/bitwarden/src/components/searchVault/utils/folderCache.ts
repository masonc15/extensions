import { LocalStorage } from "@raycast/api";
import { FOLDER_CACHE_TTL_MS, LOCAL_STORAGE_KEY } from "~/constants/general";
import { Folder } from "~/types/vault";
import { captureException } from "~/utils/development";

/**
 * Folders change far less often than items, so they are cached in LocalStorage.
 * A fresh cache lets `loadItems` skip the `bw list folders` spawn (~1.5s) entirely.
 */
export async function getCachedFolders(): Promise<Folder[] | null> {
  try {
    const [serialized, timestamp] = await Promise.all([
      LocalStorage.getItem<string>(LOCAL_STORAGE_KEY.CACHED_FOLDERS),
      LocalStorage.getItem<number>(LOCAL_STORAGE_KEY.CACHED_FOLDERS_TIME),
    ]);
    if (!serialized || !timestamp) return null;
    if (Date.now() - timestamp > FOLDER_CACHE_TTL_MS) return null;
    return JSON.parse(serialized) as Folder[];
  } catch {
    return null;
  }
}

export async function cacheFolders(folders: Folder[]): Promise<void> {
  try {
    await LocalStorage.setItem(LOCAL_STORAGE_KEY.CACHED_FOLDERS, JSON.stringify(folders));
    await LocalStorage.setItem(LOCAL_STORAGE_KEY.CACHED_FOLDERS_TIME, Date.now());
  } catch (error) {
    captureException("Failed to cache folders", error);
  }
}
