// What the composer says about a turn something cut into, and what its
// Continue sends. The transcript row's own line is `interruptionHeadline` in
// `@tryatlas/design/session`, beside the `formatSlept` this shares.

import { formatSlept } from "@tryatlas/design/session";

/** The composer pill while the turn is still going after the wake. */
export function wokePillLabel(sleptSecs: number): string {
  return `Woke after ${formatSlept(sleptSecs)}`;
}

/** What Continue sends. In the user's voice, since it goes out as their
 *  message, and it names why, so the agent resumes rather than restarts. */
export const CONTINUE_AFTER_SLEEP =
  "Please continue — my computer went to sleep and your last reply may have been cut off.";
