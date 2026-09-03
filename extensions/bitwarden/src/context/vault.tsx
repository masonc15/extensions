import { getPreferenceValues, showToast, Toast } from "@raycast/api";
import { createContext, ReactNode, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import { useVaultItemPublisher } from "~/components/searchVault/context/vaultListeners";
import { cacheFolders, getCachedFolders } from "~/components/searchVault/utils/folderCache";
import { getVaultSignature } from "~/components/searchVault/utils/vaultSignature";
import { useBitwarden } from "~/context/bitwarden";
import { useSession } from "~/context/session";
import { Folder, Item, Vault } from "~/types/vault";
import { captureException } from "~/utils/development";
import useVaultCaching from "~/components/searchVault/utils/useVaultCaching";
import { FailedToLoadVaultItemsError, getDisplayableErrorMessage } from "~/utils/errors";
import useOnceEffect from "~/utils/hooks/useOnceEffect";
import { useCachedState } from "@raycast/utils";
import { CACHE_KEYS, FOLDER_OPTIONS } from "~/constants/general";

export type VaultState = Vault & {
  isLoading: boolean;
};

export type VaultContextType = VaultState & {
  isEmpty: boolean;
  syncItems: () => Promise<void>;
  loadItems: (options?: { suppressErrorToast?: boolean }) => Promise<void>;
  currentFolderId: Nullable<string>;
  setCurrentFolder: (folderOrId: Nullable<string | Folder>) => void;
  updateState: (next: React.SetStateAction<VaultState>) => void;
};

export const VaultContext = createContext<VaultContextType | null>(null);

function getInitialState(): VaultState {
  return { items: [], folders: [], isLoading: true };
}

export type VaultProviderProps = {
  children: ReactNode;
};

const { syncOnLaunch } = getPreferenceValues<AllPreferences>();

export function VaultProvider(props: VaultProviderProps) {
  const { children } = props;

  const session = useSession();
  const bitwarden = useBitwarden();
  const publishItems = useVaultItemPublisher();
  const { getCachedVault, cacheVault } = useVaultCaching();

  const [currentFolderId, setCurrentFolderId] = useCachedState<Nullable<string>>(CACHE_KEYS.CURRENT_FOLDER_ID, null);
  const [state, setState] = useReducer(
    (previous: VaultState, next: Partial<VaultState>) => ({ ...previous, ...next }),
    { ...getInitialState(), ...getCachedVault() }
  );

  // Guards fire-and-forget background work (sync/refresh) against setting state after unmount.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  // Latest state for async callbacks (change-detection compares against this).
  const stateRef = useRef(state);
  stateRef.current = state;

  useOnceEffect(() => {
    void initialLoad();
  }, session.active && session.token);

  /**
   * Launch path: load from the local vault first so the list (with real,
   * copyable passwords) is usable immediately, then sync in the background.
   * Previously this awaited `bw sync` before loading anything, blocking every
   * copy on a network round-trip plus a full vault re-decrypt.
   */
  async function initialLoad() {
    await loadItems();
    if (syncOnLaunch) void syncInBackground();
  }

  async function loadItems(options?: { suppressErrorToast?: boolean }) {
    try {
      setState({ isLoading: true });
      const { items, folders } = await fetchVault();
      applyVault(items, folders);
    } catch (error) {
      if (!options?.suppressErrorToast) {
        await showToast(Toast.Style.Failure, "Failed to load vault items", getDisplayableErrorMessage(error));
      }
      captureException("Failed to load vault items", error);
    } finally {
      setState({ isLoading: false });
    }
  }

  /** Reads items + folders from the local vault (one `bw list items` spawn, folders cached). */
  async function fetchVault(): Promise<Vault> {
    let items: Item[] = [];
    let folders: Folder[] = [];
    try {
      // Folders rarely change: a fresh LocalStorage cache skips the
      // `bw list folders` spawn (~1.5s) entirely.
      const cachedFolders = await getCachedFolders();
      const [itemsResult, foldersResult] = await Promise.all([
        bitwarden.listItems(),
        cachedFolders ? Promise.resolve(null) : bitwarden.listFolders(),
      ]);
      if (itemsResult.error) throw itemsResult.error;
      items = itemsResult.result;
      if (foldersResult) {
        if (foldersResult.error) throw foldersResult.error;
        folders = foldersResult.result;
        void cacheFolders(folders);
      } else {
        folders = cachedFolders ?? [];
        // Refresh the folder list without blocking the UI.
        void refreshFoldersInBackground();
      }
      items.sort(favoriteItemsFirstSorter);
    } catch (error) {
      publishItems(new FailedToLoadVaultItemsError());
      throw error;
    }
    return { items, folders };
  }

  /** Publishes a fetched vault to state, subscribers and the encrypted cache. */
  function applyVault(items: Item[], folders: Folder[]) {
    setState({ items, folders });
    publishItems(items);
    // Deferred past first paint: stringify+encrypt of a 2k-item vault costs
    // ~20MB of transient heap, which used to peak together with render. The
    // write is side-effect-only, so no unmount guard is needed.
    setTimeout(() => cacheVault(items, folders), 1500);
  }

  /**
   * Silent background refresh after `bw sync`. When the sync pulled no
   * changes, applying a second full vault would briefly double heap usage
   * (old state + new parse + new search index) for no benefit, so identical
   * snapshots are skipped. Never touches isLoading and never toasts.
   */
  async function reloadItemsIfChanged() {
    try {
      const { items, folders } = await fetchVault();
      const current = stateRef.current;
      if (getVaultSignature(items, folders) === getVaultSignature(current.items, current.folders)) return;
      if (!mountedRef.current) return;
      applyVault(items, folders);
    } catch (error) {
      captureException("Failed to reload vault items", error);
    }
  }

  async function refreshFoldersInBackground() {
    try {
      const { error, result } = await bitwarden.listFolders();
      if (error) throw error;
      if (!mountedRef.current) return;
      setState({ folders: result });
      void cacheFolders(result);
    } catch (error) {
      captureException("Failed to refresh folders", error);
    }
  }

  /** Manual sync action (⌥R): blocking, with progress toast. */
  async function syncItems() {
    const toast = await showToast({
      title: "Syncing vault...",
      style: Toast.Style.Animated,
    });
    try {
      const { error } = await bitwarden.sync();
      if (error) {
        toast.style = Toast.Style.Failure;
        toast.title = "Failed to sync vault";
        toast.message = getDisplayableErrorMessage(error);
      }
      await loadItems({ suppressErrorToast: !!error });
      if (!error) await toast.hide();
    } catch (error) {
      await bitwarden.logout();
      toast.style = Toast.Style.Failure;
      toast.title = "Failed to sync vault";
      toast.message = getDisplayableErrorMessage(error);
    }
  }

  /** Launch-time sync: never blocks the UI; failures surface as a toast. */
  async function syncInBackground() {
    const toast = await showToast({
      title: "Syncing vault...",
      message: "Background task",
      style: Toast.Style.Animated,
    });
    try {
      const { error } = await bitwarden.sync();
      if (error) {
        toast.style = Toast.Style.Failure;
        toast.title = "Failed to sync vault";
        toast.message = getDisplayableErrorMessage(error);
        return;
      }
      if (!mountedRef.current) {
        await toast.hide();
        return;
      }
      await reloadItemsIfChanged();
      await toast.hide();
    } catch (error) {
      await bitwarden.logout();
      toast.style = Toast.Style.Failure;
      toast.title = "Failed to sync vault";
      toast.message = getDisplayableErrorMessage(error);
    }
  }

  function setCurrentFolder(folderOrId: Nullable<string | Folder>) {
    setCurrentFolderId(typeof folderOrId === "string" ? folderOrId : folderOrId?.id);
  }

  function updateState(next: React.SetStateAction<VaultState>) {
    const newState = typeof next === "function" ? next(state) : next;
    setState(newState);
    cacheVault(newState.items, newState.folders);
  }

  // Memoized so the fuzzy-search index downstream isn't rebuilt on every render.
  const visibleItems = useMemo(
    () => filterItemsByFolderId(state.items, currentFolderId),
    [state.items, currentFolderId]
  );

  const memoizedValue: VaultContextType = useMemo(
    () => ({
      ...state,
      items: visibleItems,
      isEmpty: state.items.length == 0,
      isLoading: state.isLoading || session.isLoading,
      currentFolderId,
      syncItems,
      loadItems,
      setCurrentFolder,
      updateState,
    }),
    [state, visibleItems, session.isLoading, currentFolderId, syncItems, loadItems, setCurrentFolder, updateState]
  );

  return <VaultContext.Provider value={memoizedValue}>{children}</VaultContext.Provider>;
}

function filterItemsByFolderId(items: Item[], folderId: Nullable<string>) {
  if (!folderId || folderId === FOLDER_OPTIONS.ALL) return items;
  if (folderId === FOLDER_OPTIONS.NO_FOLDER) return items.filter((item) => item.folderId === null);
  return items.filter((item) => item.folderId === folderId);
}

function favoriteItemsFirstSorter(a: Item, b: Item) {
  if (a.favorite && b.favorite) return 0;
  return a.favorite ? -1 : 1;
}

export const useVaultContext = () => {
  const context = useContext(VaultContext);
  if (context == null) {
    throw new Error("useVault must be used within a VaultProvider");
  }

  return context;
};
