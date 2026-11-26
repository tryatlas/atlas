// Ending a sign-in the user walked away from. An agent's `authenticate`
// (`agents_authenticate`) has no deadline of its own — a browser sign-in takes
// as long as the user takes — so dismissing the dialog has to end it, or the
// request stays open on the agent and a retry starts a second flow (#67).

import { invoke } from "@tauri-apps/api/core";

/** End the `authenticate` in flight for this agent; the pending
 *  `agents_authenticate` then rejects. A no-op when nothing is in flight. */
export function cancelAuthentication(agentId: string): Promise<void> {
  return invoke<void>("agents_cancel_authentication", { agentId });
}
