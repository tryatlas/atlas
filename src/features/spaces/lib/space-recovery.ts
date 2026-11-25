import * as Y from "yjs";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toBase64 } from "@/features/comms/lib/draft-sync";
import { readNodes, readEdges, REMOTE } from "./space-doc";
import { spaceOutbox, type SavedSpacePage } from "./space-outbox";

export async function readSavedSpacePage(page: SavedSpacePage) {
  const journal = spaceOutbox(page);
  await journal.hydrate();
  const doc = new Y.Doc();
  try {
    if (journal.savedSnapshot) Y.applyUpdate(doc, journal.savedSnapshot, REMOTE);
    journal.applyTo(doc);
    const nodes = readNodes(doc);
    return {
      version: 1,
      page,
      nodes,
      edges: readEdges(doc),
      document: toBase64(Y.encodeStateAsUpdate(doc)),
      text: nodes
        .map((node) => [node.title, node.body, node.text].filter(Boolean).join("\n\n"))
        .join("\n\n---\n\n"),
    };
  } finally {
    doc.destroy();
  }
}
export type RecoveredSpacePage = Awaited<ReturnType<typeof readSavedSpacePage>>;
export async function exportSavedSpacePage(page: RecoveredSpacePage): Promise<boolean> {
  const path = await save({
    defaultPath: "saved-space.json",
    filters: [{ name: "Saved Space", extensions: ["json"] }],
  });
  if (!path) return false;
  await invoke("write_file_content", { path, content: JSON.stringify(page, null, 2) });
  return true;
}
