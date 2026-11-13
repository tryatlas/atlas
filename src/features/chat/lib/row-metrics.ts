// Layout constants the composer stack and the turn rail share with the
// transcript. The rows' own numbers (the user bubble's clamp, the column) live
// with the rows, in `@tryatlas/design/session`.

/**
 * The turn rail shows at rest in a left gutter at least this wide; a narrower
 * one shows it only while hovered (`turn-rail.ts`). Here so the session
 * context dock (`context-dock.ts`), which slides the column left to clear its
 * card, can stop short of this gutter without importing the rail's chunk.
 */
export const TURN_RAIL_PERSISTENT_GUTTER = 48;

/**
 * The conversation's content frame: centred, `chatWidth` at most (760px unless
 * the user widened it, `--atlas-chat-column` in globals.css), padded the same on
 * both sides.
 *
 * Shared because the composer stack has to line up with the transcript text at
 * every width, not just the wide one. It used to be `px-4` around a 720px box,
 * which coincides with this frame only when the column is at least 760px wide;
 * a docked card's room (or a narrow window or split) put the composer's
 * left edge 7px outside the text above it. This string frames the
 * composer, the cards tucked above it and the banners over it; the rows use
 * the package's `TRANSCRIPT_COLUMN`, the same frame on `--transcript-column`,
 * which `globals.css` keeps equal to `--atlas-chat-column`.
 */
export const CONTENT_COLUMN = "mx-auto w-full max-w-(--atlas-chat-column) px-6";
