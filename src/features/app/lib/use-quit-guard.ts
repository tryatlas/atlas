import { useEffect } from "react";
import { toast } from "sonner";
import { confirm } from "@/lib/confirm";
import { busySessions } from "@/features/projects/lib/stop-agents-confirm";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { captureSnapshot } from "@/features/projects/lib/project-snapshot";
import { flushAll } from "@/features/projects/lib/flush-registry";
import { confirmCloseFileTabs, dirtyFileTabs } from "@/features/editor/lib/dirty-close";
import { onQuitRequested, quitGuardAnswer, quitGuardReady } from "./quit-guard-api";

/** Agent confirmation is optional; acknowledging durable user edits is not. */
export function useQuitGuard() {
  useEffect(() => {
    let disposed = false;
    let answering = false;
    const answer = async () => {
      if (answering || disposed) return;
      answering = true;
      try {
        const running = busySessions().length;
        const settings = useSettingsStore.getState().settings;
        if (running > 0 && settings.confirmQuitWhileRunning) {
          const them = running === 1 ? "it" : "them";
          const quit = await confirm({
            title:
              running === 1 ? "An agent is still running" : `${running} agents are still running`,
            body: settings.continueSessionsAfterRestart
              ? `Quitting stops ${them} for now. When Atlas opens again, ${running === 1 ? "its session continues" : "their sessions continue"} where ${running === 1 ? "it" : "they"} left off.`
              : `Quitting stops ${them}. The conversation${running === 1 ? " stays" : "s stay"} in history, but the work in progress is lost.`,
            confirmLabel: "Quit",
            destructive: true,
          });
          if (!quit) {
            await quitGuardAnswer(false);
            return;
          }
        }
        // Every mounted project's unsaved file tabs, not only the visible
        // one's: an editor's edits live only in its view until saved.
        const unsaved = dirtyFileTabs();
        if (unsaved.length > 0 && !(await confirmCloseFileTabs(unsaved, "Quitting"))) {
          await quitGuardAnswer(false);
          return;
        }
        const projectId = useProjectStore.getState().activeProjectId;
        const path = useAppStore.getState().currentProject?.path ?? null;
        if (projectId) captureSnapshot(projectId);
        await flushAll({ projectId, path, reason: "quit" });
        await quitGuardAnswer(true);
      } catch (error) {
        toast.error(
          `Atlas could not save all edits. Retry quitting after saving: ${String(error)}`,
        );
        await quitGuardAnswer(false).catch((failure) =>
          console.error("Could not release the quit request", failure),
        );
      } finally {
        answering = false;
      }
    };
    const unlisten = onQuitRequested(() => {
      void answer();
    });
    void unlisten
      .then(() => {
        if (!disposed) void quitGuardReady();
      })
      .catch((error) => console.error("Could not install the quit save barrier", error));
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);
}
