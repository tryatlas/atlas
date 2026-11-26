import { withContextsInline } from "@/features/ask-agent/lib/agent-context";
import type { ImageAttachment } from "@/types/agents";
import { withCitesInline } from "./cited-text";
import type { MentionData } from "./mentions";
import { withPastesInline } from "./pasted-text";
import { withReviewCommentsInline } from "./review-comments";

/**
 * A queued prompt as it was sent: what was typed, the mentions it was typed
 * with and the images it carried. A queued message is the same message a
 * direct send would have been (ACP audit finding 80), so this is what the agent is sent
 * for it — composed the way a direct send is — and what an agent switch or a
 * restart onto a new session hands on. The strip shows `inlineQueuedText` of
 * it.
 */
export interface QueuedContent {
  text: string;
  mentions: MentionData[];
  attachments?: ImageAttachment[];
}

/** A queued prompt's text with its pastes', cites', review comments' and
 *  surface contexts' text written in: what the queue strip shows, and what an
 *  Edit hands back to the composer (which folds the pastes and cites back
 *  into chips). Appends — call it once per prompt. */
export function inlineQueuedText(text: string, mentions: readonly MentionData[]): string {
  return withContextsInline(
    withReviewCommentsInline(withCitesInline(withPastesInline(text, mentions), mentions), mentions),
    mentions,
  );
}
