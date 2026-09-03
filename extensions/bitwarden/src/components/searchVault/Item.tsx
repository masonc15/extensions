import { List } from "@raycast/api";
import { memo, useMemo } from "react";
import VaultItemActionPanel from "~/components/searchVault/ItemActionPanel";
import VaultItemContext from "~/components/searchVault/context/vaultItem";
import { useItemAccessories } from "~/components/searchVault/utils/useItemAccessories";
import { useItemIcon } from "~/components/searchVault/utils/useItemIcon";
import { Folder, Item } from "~/types/vault";

export type VaultItemProps = {
  item: Item;
  folder: Folder | undefined;
};

const VaultItem = ({ item, folder }: VaultItemProps) => {
  const icon = useItemIcon(item);
  const accessories = useItemAccessories(item, folder);
  const keywords = useItemKeywords(item);

  return (
    <VaultItemContext.Provider value={item}>
      <List.Item
        id={item.id}
        title={item.name}
        accessories={accessories}
        icon={icon}
        subtitle={item.login?.username || undefined}
        keywords={keywords}
        actions={<VaultItemActionPanel />}
      />
    </VaultItemContext.Provider>
  );
};

/** Searchable strings for native List filtering (username, hosts, card brand, identity names). */
function useItemKeywords(item: Item): string[] {
  return useMemo(() => {
    const keywords: string[] = [];
    if (item.login?.username) keywords.push(item.login.username);
    for (const { uri } of item.login?.uris ?? []) {
      if (!uri) continue;
      keywords.push(uri);
      try {
        keywords.push(new URL(uri).hostname);
      } catch {
        // Not a parseable URL (e.g. bare domain or app scheme); raw uri above still matches.
      }
    }
    if (item.card?.brand) keywords.push(item.card.brand);
    const identity = item.identity;
    if (identity) {
      for (const value of [identity.firstName, identity.lastName, identity.email, identity.company]) {
        if (value) keywords.push(value);
      }
    }
    return keywords;
  }, [item]);
}

export default memo(VaultItem);
