import type { Scenario } from "../types";
import { MOCK_PROJECT } from "../project";

/** Real Mermaid rendering and PNG export, including WebKit's canvas rules. */
export const chatMermaid: Scenario = {
  name: "chat-mermaid",
  description: "A recorded Session chat with a flowchart ready to export.",
  setup: async () => {
    const [{ useLayoutStore }, { useArtifactsStore }, { useSessionChatStore }] = await Promise.all([
      import("@/features/layout/stores/layout-store"),
      import("@/features/artifacts/stores/artifacts-store"),
      import("@/features/artifacts/stores/session-chat-store"),
    ]);
    // Reuse the persisted conversation and diagram in fixtures/artifacts.ts.
    await useSessionChatStore.getState().actions.select("sess-8f21ac", "chat-9a41");
    useArtifactsStore.getState().actions.openSession({
      sessionId: "sess-8f21ac",
      projectPath: MOCK_PROJECT.path,
    });
    useLayoutStore.getState().actions.addTab({
      id: "artifacts",
      type: "artifacts",
      title: "Timeline",
      closable: true,
      dirty: false,
      data: {},
    });
  },
};
