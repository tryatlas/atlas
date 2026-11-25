// The inline permission card: what the agent wants to do, its preview, the
// numbered options, and the "tell the agent what to do instead" field.
//
// Props only. The container (`permission-modal.tsx`) reads the queue, answers
// on the wire, and owns the window keydown handler that maps digits, Enter and
// Esc onto these options — that handler is the card's safety logic, so it
// stays with the data, not here. The card takes no focus when it appears: the
// composer keeps it.

import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Button, Icon, Kbd, Spinner, Textarea } from "@tryatlas/design";
import { ToolGlyph } from "@tryatlas/design/session";
import { cn } from "@/lib/utils";
import { CONTENT_COLUMN } from "../../lib/row-metrics";
import type { PermissionDiff } from "../../lib/permission-diff";
import type { PermissionSummary } from "../../lib/permission-summary";
import type {
  OutwardApproval,
  OutwardPreparing,
} from "@/features/org-actions/lib/outward-approval";

/** One option as the card draws it: the wire's option, already relabelled. */
export interface PermissionOptionItem {
  optionId: string;
  label: string;
  tone: "allow" | "reject" | "other";
  /** The option Enter picks. Never set on an outward action's card. */
  isPrimary: boolean;
}

export type PermissionCardHeading =
  | { kind: "tool"; summary: PermissionSummary }
  | { kind: "outward"; approval: OutwardApproval }
  | { kind: "preparing"; preparing: OutwardPreparing };

export function PermissionCardView({
  heading,
  diffs = [],
  locations = [],
  options,
  queueNote,
  draft,
  onDraftChange,
  onSubmitDraft,
  draftRef,
  onSelect,
}: {
  heading: PermissionCardHeading;
  /** The edits the request proposes, from its own diff blocks. Drawn on a
   *  tool card only, above its input. */
  diffs?: readonly PermissionDiff[];
  /** The places the request names that no diff already shows. */
  locations?: readonly string[];
  options: PermissionOptionItem[];
  queueNote: string | null;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmitDraft: () => void;
  draftRef: Ref<HTMLTextAreaElement>;
  onSelect: (optionId: string) => void;
}) {
  return (
    <div className={cn(CONTENT_COLUMN, "pt-2")}>
      <div
        data-testid="permission-card"
        // A card resting in the composer stack, flat on its border like the
        // composer below it: no elevation, so it reads as part of the stack
        // rather than a menu floating over the transcript.
        className="w-full overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="flex items-start gap-2 px-3 pt-3">
          <div className="min-w-0 flex-1">
            {heading.kind === "preparing" ? (
              <OutwardPreparingHeading preparing={heading.preparing} />
            ) : heading.kind === "outward" ? (
              <OutwardActionHeading approval={heading.approval} />
            ) : (
              <ToolHeading summary={heading.summary} queueNote={queueNote} />
            )}
            {queueNote && heading.kind !== "tool" && <QueueNote note={queueNote} />}
          </div>
        </div>

        {heading.kind === "preparing" ? null : heading.kind === "outward" ? (
          <OutwardActionBody approval={heading.approval} />
        ) : (
          <>
            {locations.length > 0 && (
              <div className="mx-3 mt-1 break-all font-mono text-xs text-secondary-foreground">
                {locations.join(", ")}
              </div>
            )}
            {diffs.map((diff, i) => (
              <PermissionDiffView key={`${diff.path}:${i}`} diff={diff} />
            ))}
            {heading.kind === "tool" ? <ToolInput summary={heading.summary} /> : null}
          </>
        )}

        <div className="px-3 py-2.5">
          <PermissionOptionList options={options} onSelect={onSelect} />
        </div>

        <div className="atlas-permission-draft border-t border-border px-3 py-2.5">
          <Textarea
            ref={draftRef}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmitDraft();
              }
            }}
            rows={1}
            placeholder="Tell the agent what to do instead…"
            // One line until the user types more: the package field opens at
            // four lines, which would double the card for a fallback. It
            // grows with what is typed (the field sizes to its content) up to
            // a cap, then scrolls with no bar (`.atlas-permission-draft`).
            className="max-h-24 min-h-0 resize-none"
          />
        </div>
      </div>
    </div>
  );
}

/** The numbered option list — shared with the plan review. Every option the
 *  wire sent, in wire order, each with its digit. */
export function PermissionOptionList({
  options,
  onSelect,
}: {
  options: PermissionOptionItem[];
  onSelect: (optionId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {options.map((opt, i) => (
        <PermissionOption
          key={opt.optionId}
          index={i + 1}
          option={opt}
          onSelect={() => onSelect(opt.optionId)}
        />
      ))}
    </div>
  );
}

const TONE_GLYPH = { allow: CheckCircle2, reject: XCircle, other: AlertTriangle } as const;

function PermissionOption({
  index,
  option,
  onSelect,
}: {
  index: number;
  option: PermissionOptionItem;
  onSelect: () => void;
}) {
  const { isPrimary } = option;
  return (
    <Button
      // The filled button is the one Enter picks; a reject wears the error
      // outline; everything else is a plain outline.
      variant={isPrimary ? "default" : option.tone === "reject" ? "destructive-outline" : "outline"}
      size="lg"
      onClick={onSelect}
      // A row, not a chip: full width, left-aligned, and a label that wraps
      // rather than running off the card.
      className="h-auto min-h-9 w-full justify-start whitespace-normal text-left"
    >
      <Kbd variant={isPrimary ? "inverse" : "default"}>{index}</Kbd>
      <Icon icon={TONE_GLYPH[option.tone]} size="md" />
      <span className="min-w-0 flex-1 py-2 break-words">{option.label}</span>
      {isPrimary && <Kbd variant="inverse">↵</Kbd>}
    </Button>
  );
}

/**
 * An outward action's headline (ADR-0014): the act and whom it reaches, then
 * the recipient in full — in place of "The agent wants to run …?", which
 * reads wrongly for a message.
 */
export function OutwardActionHeading({ approval }: { approval: OutwardApproval }) {
  return (
    <>
      <div className="text-base font-medium leading-snug text-foreground">{approval.title}</div>
      <div className="mt-0.5 text-xs text-secondary-foreground">{approval.recipient}</div>
    </>
  );
}

/**
 * An outward action's card while the host is still describing it (ADR-0014):
 * a loading heading and what is being looked up. The only option below is
 * Decline; the described card replaces this one when it is ready.
 */
export function OutwardPreparingHeading({ preparing }: { preparing: OutwardPreparing }) {
  return (
    <div role="status" aria-live="polite" data-testid="outward-preparing">
      <div className="flex items-center gap-2 text-base font-medium leading-snug text-foreground">
        <Spinner size="lg" label="" />
        <span>{preparing.title}</span>
      </div>
      <div className="mt-0.5 text-xs text-secondary-foreground">{preparing.note}</div>
    </div>
  );
}

/**
 * One proposed edit, in the tool-call preview's box: the file, its counts in
 * the transcript's diff colours, and the changed lines with a little context.
 * Every line is drawn as text; a file too long for the card says how many
 * lines it left out rather than cutting silently.
 */
export function PermissionDiffView({ diff }: { diff: PermissionDiff }) {
  return (
    <div
      data-testid="permission-diff"
      className="mx-3 mt-2 overflow-hidden rounded-md border border-border bg-background"
    >
      <div className="flex items-start gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 break-all font-mono text-xs text-secondary-foreground">
          {diff.path}
        </span>
        <span
          role="group"
          aria-label={`${diff.added} added, ${diff.removed} removed`}
          className="inline-flex shrink-0 gap-1 font-mono text-xs tabular-nums"
        >
          <span aria-hidden className="text-[var(--diff-added-text)]">
            +{diff.added}
          </span>
          <span aria-hidden className="text-[var(--diff-removed-text)]">
            −{diff.removed}
          </span>
        </span>
      </div>
      <ScrollBox className="max-h-48 py-1 font-mono text-xs leading-snug">
        {diff.lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre px-3",
              line.sign === "+"
                ? "text-[var(--diff-added-text)]"
                : line.sign === "-"
                  ? "text-[var(--diff-removed-text)]"
                  : "text-secondary-foreground",
            )}
          >
            {line.sign}
            {line.text}
          </div>
        ))}
        {diff.more > 0 && (
          <div className="px-3 text-muted-foreground">
            {diff.more} more {diff.more === 1 ? "line" : "lines"} not shown
          </div>
        )}
      </ScrollBox>
    </div>
  );
}

/**
 * The exact words an outward action will post, in the tool-call preview's
 * box: the whole body, never truncated, scrolling inside the card when long.
 */
export function OutwardActionBody({ approval }: { approval: OutwardApproval }) {
  return (
    <div className="mx-3 mt-2 overflow-hidden rounded-md border border-border bg-background">
      <ScrollBox
        data-testid="outward-body"
        className="max-h-64 px-3 py-2 whitespace-pre-wrap text-sm leading-snug text-foreground"
      >
        {approval.body}
      </ScrollBox>
    </div>
  );
}

/**
 * A tool call's headline, in the transcript's words: the glyph its line will
 * wear, what it will do, and the agent's own account of why underneath. The
 * headline does not scroll, so the account is held to three lines; the whole
 * of it is on hover.
 */
function ToolHeading({
  summary,
  queueNote,
}: {
  summary: PermissionSummary;
  /** Drawn in the headline's column, past the glyph. */
  queueNote: string | null;
}) {
  return (
    <div className="flex items-start gap-2">
      <span aria-hidden className="mt-1 shrink-0 text-secondary-foreground">
        <ToolGlyph tool={summary.tool} failed={false} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-words text-base font-medium leading-snug text-foreground">
          {summary.action}
          {summary.source ? (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              · {summary.source}
            </span>
          ) : null}
        </div>
        {summary.description ? (
          <div
            title={summary.description}
            className="mt-0.5 line-clamp-3 break-words text-xs text-secondary-foreground"
          >
            {summary.description}
          </div>
        ) : null}
        {queueNote && <QueueNote note={queueNote} />}
      </div>
    </div>
  );
}

function QueueNote({ note }: { note: string }) {
  return <div className="mt-0.5 text-xs text-secondary-foreground">{note}</div>;
}

/**
 * What the call will be run with: the command as shell text, then any other
 * input as named rows. The one part of the card that grows with the request,
 * so it is the part that scrolls, and the options below stay on screen
 * whatever the agent sent.
 */
function ToolInput({ summary }: { summary: PermissionSummary }) {
  const { command, fields } = summary;
  if (command === null && fields.length === 0) return null;
  return (
    <div className="mx-3 mt-2 overflow-hidden rounded-md border border-border bg-background">
      <ScrollBox
        data-testid="permission-preview"
        className="max-h-40 px-3 py-2 font-mono text-xs leading-snug"
      >
        {command !== null ? (
          <pre className="whitespace-pre-wrap break-words text-foreground">{command}</pre>
        ) : null}
        {fields.length > 0 ? (
          <dl
            className={cn(
              "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1",
              command !== null && "mt-2 border-t border-border pt-2",
            )}
          >
            {fields.map((field, i) =>
              field.name ? (
                <div key={`${field.name}:${i}`} className="contents">
                  <dt className="text-muted-foreground">{field.name}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap break-words text-secondary-foreground">
                    {field.value}
                  </dd>
                </div>
              ) : (
                <div
                  key={i}
                  className="col-span-2 whitespace-pre-wrap break-words text-secondary-foreground"
                >
                  {field.value}
                </div>
              ),
            )}
          </dl>
        ) : null}
      </ScrollBox>
    </div>
  );
}

/**
 * A capped box that scrolls with no bar: the app's global scrollbar style
 * gives every overflowing box a bar of its own in WebKit, which in a card this
 * small reads as clutter. Without the bar, a fade along the bottom edge is
 * what says there is more — drawn only while the content runs past it.
 */
function ScrollBox({
  className,
  children,
  "data-testid": testId,
}: {
  className: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    if (el) setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);
  // After every render: new content can run past a box already at its cap,
  // which no resize reports. An unchanged answer re-renders nothing.
  useEffect(measure);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  return (
    <div
      ref={ref}
      data-testid={testId}
      onScroll={measure}
      className={cn("hide-scrollbar overflow-auto", more && "mask-b-from-75%", className)}
    >
      {children}
    </div>
  );
}
