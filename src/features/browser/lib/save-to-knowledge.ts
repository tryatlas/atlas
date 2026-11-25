import { toast } from "sonner";
import { saveKnowledgeNote } from "./browser-api";

/** Longest page text kept in a saved note. */
const MAX_TEXT = 50000;

/**
 * Reader mode's "Save to knowledge": write the page as a note in the
 * project's knowledge base, then refresh the notes list. A failed write is
 * said on screen (it used to be swallowed, so the user believed the page
 * saved); a failed refresh is not, since the note is already on disk.
 * Resolves whether the note was written.
 */
export async function savePageToKnowledge(
  projectPath: string,
  page: { title: string; url: string },
  text: string,
): Promise<boolean> {
  try {
    await saveKnowledgeNote(
      projectPath,
      `web-${Date.now()}`,
      `# ${page.title}\n\nSource: ${page.url}\n\n${text.slice(0, MAX_TEXT)}`,
    );
  } catch (error) {
    toast.error(`Page could not be saved to knowledge: ${String(error)}`);
    return false;
  }
  const { useKnowledgeStore } = await import("@/features/knowledge/stores/knowledge-store");
  void useKnowledgeStore
    .getState()
    .actions.loadEntries(projectPath)
    .catch((error) => console.warn("Notes list could not refresh after saving a page", error));
  return true;
}
