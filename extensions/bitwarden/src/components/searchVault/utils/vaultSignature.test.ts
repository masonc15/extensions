import { getVaultSignature } from "~/components/searchVault/utils/vaultSignature";
import { getMockFolders, getMockItems } from "~/utils/testing/mocks";

describe("getVaultSignature", () => {
  test("is stable for identical snapshots", () => {
    const items = getMockItems(5);
    const folders = getMockFolders(2);
    const clone: { items: typeof items; folders: typeof folders } = JSON.parse(JSON.stringify({ items, folders }));
    expect(getVaultSignature(clone.items, clone.folders)).toBe(getVaultSignature(items, folders));
  });

  test("ignores row order", () => {
    const items = getMockItems(5);
    const folders = getMockFolders(2);
    expect(getVaultSignature(items, folders)).toBe(getVaultSignature([...items].reverse(), [...folders].reverse()));
  });

  test("changes when an item revision, favorite, folder or name changes", () => {
    const items = getMockItems(5);
    const folders = getMockFolders(2);
    const baseline = getVaultSignature(items, folders);

    expect(
      getVaultSignature(
        items.map((item) => ({ ...item, revisionDate: "2030-01-01T00:00:00.000Z" })),
        folders
      )
    ).not.toBe(baseline);
    expect(
      getVaultSignature(
        items.map((item) => ({ ...item, favorite: !item.favorite })),
        folders
      )
    ).not.toBe(baseline);
    expect(
      getVaultSignature(
        items.map((item) => ({ ...item, folderId: "other-folder" })),
        folders
      )
    ).not.toBe(baseline);
    expect(
      getVaultSignature(
        items,
        folders.map((folder) => ({ ...folder, name: "renamed" }))
      )
    ).not.toBe(baseline);
  });

  test("changes when items or folders are added or removed", () => {
    const items = getMockItems(5);
    const folders = getMockFolders(2);
    const baseline = getVaultSignature(items, folders);

    expect(getVaultSignature(items.slice(1), folders)).not.toBe(baseline);
    expect(getVaultSignature([...items, ...getMockItems(1)], folders)).not.toBe(baseline);
    expect(getVaultSignature(items, folders.slice(1))).not.toBe(baseline);
  });
});
