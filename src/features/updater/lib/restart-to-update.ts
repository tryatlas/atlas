import { useUpdaterStore } from "../stores/updater-store";
import { updater } from "./updater-api";
import { openSettingsSection } from "@/features/settings/lib/open-settings";

/** Swap the staged update in and relaunch. Shared by the "Restart to update"
 *  prompt and the update notification's Restart action. On success the app
 *  restarts; a failure lands in the updater store (and so in the prompt). */
export function restartToUpdate(): void {
  const { beginApply, setError } = useUpdaterStore.getState().actions;
  beginApply();
  void updater.apply().catch((e) => setError(String(e)));
}

/** Reopen the "Restart to update" prompt (a notification click). */
export async function openUpdatePrompt(): Promise<void> {
  const state = await updater.state();
  if (state.phase === "ready" && state.version) {
    useUpdaterStore.getState().actions.setReady(state.version);
  } else {
    openSettingsSection("updates");
  }
}
