import { Folder, Item } from "~/types/vault";

const FIELD_SEPARATOR = "\x1f";
const ENTRY_SEPARATOR = "\n";

/**
 * Cheap change-detection signature for a vault snapshot.
 *
 * A full vault (2k+ items) costs ~50MB+ of transient heap to parse, re-index
 * and re-cache. Background reloads use this to skip the expensive apply step
 * when `bw sync` pulled no changes, keeping peak memory near a single load.
 * Order-insensitive: CLI row order doesn't affect the result.
 */
export function getVaultSignature(
  items: Pick<Item, "id" | "revisionDate" | "favorite" | "folderId">[],
  folders: Pick<Folder, "id" | "name">[]
): string {
  const parts = items.map((item) =>
    ["i", item.id, item.revisionDate, String(item.favorite), item.folderId].join(FIELD_SEPARATOR)
  );
  for (const folder of folders) {
    parts.push(["f", folder.id, folder.name].join(FIELD_SEPARATOR));
  }
  parts.sort();
  return fnv1aHex(parts.join(ENTRY_SEPARATOR));
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
