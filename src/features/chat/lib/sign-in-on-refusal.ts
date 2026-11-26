/**
 * Offering sign-in when opening a session was refused for want of it.
 *
 * A new session's bind (`session-bind.ts`) has always routed an auth refusal
 * to the sign-in dialog. The paths that put an EXISTING session back did not:
 * a history open, a saved tab's restore (both `loadThreadIntoTab`), a restart
 * after the agent died (`agent-rebind.ts`) and `openAgentSession` each showed
 * the agent's raw "authentication required" and stopped (ACP audit finding
 * 64). They decide the same way the bind does (`bindFailureAction`), and open
 * the same dialog (`promptSignIn`), so one sign-in serves whichever path asked.
 *
 * The retry runs once the user has signed in, and is told so (`attempted`), so
 * an agent that still refuses after a sign-in gets its own words said rather
 * than the dialog again: the loop `session-bind.ts`'s `signInAttempted` stops.
 */
import { bindFailureAction, errInfo, promptSignIn } from "./agent-signin";
import { promptAtlasSignIn } from "./atlas-sign-in-prompt";

/**
 * When `err` is an auth refusal, offer sign-in and answer true: the caller
 * says nothing more, since the dialog is the message. `retry` runs once the
 * user has signed in. `attempted`: the caller is that retry, so a second
 * refusal is reported rather than offered again.
 */
export function offerSignInOnRefusal(
  agentType: string | undefined,
  err: unknown,
  retry: () => void,
  attempted = false,
): boolean {
  const action = bindFailureAction({ agentType, err, alreadyAttempted: attempted });
  if (action === "sign-in" && agentType) {
    promptSignIn(agentType, { reason: errInfo(err).message, onSignedIn: retry });
    return true;
  }
  if (action === "atlas-sign-in") {
    promptAtlasSignIn();
    return true;
  }
  return false;
}
