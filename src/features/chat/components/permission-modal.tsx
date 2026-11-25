// The container for every permission prompt a session raises: it reads the
// head of the session's permission queue, answers on the wire, and picks one
// of three props-only views to draw it —
//
//   `PlanReviewView`      an ExitPlanMode plan, in a modal
//   `ApprovalCardView`    Claude's AskUserQuestion bridge, as the question card
//   `PermissionCardView`  everything else, as the inline card
//
// The window keydown handler below stays here, with the data: it is the
// prompt's safety logic (which keys may pick which option, ADR-0014), and the
// views only draw what it decides.

import { memo, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useChatStore } from "../stores/chat-store";
import { respondAndPopPermission, type PermissionAnswer } from "../lib/respond-permission";
import { isChatTabShown } from "../lib/chat-tab-session";
import { permissionDiffsOf, permissionLocationsOf } from "../lib/permission-diff";
import { permissionSummaryOf } from "../lib/permission-summary";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { deepActiveElement } from "@/lib/deep-active-element";
import { Markdown } from "@/lib/markdown";
import { extractPlanMarkdown } from "../lib/plans";
import { exitPlanOffersBypass } from "../lib/exit-plan-modes";
import { composeAnswers, extractQuestions } from "../lib/questions";
import { ApprovalCardView, type Answer } from "./views/approval-card-view";
import { PermissionCardView, type PermissionOptionItem } from "./views/permission-card-view";
import { PlanReviewView } from "./views/plan-review-view";
import { ComposerDrawer } from "./composer-drawer";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { isRecordingShortcut } from "@/features/keybindings/lib/recording";
import {
  keyMayPick,
  outwardApprovalOf,
  outwardPreparingOf,
} from "@/features/org-actions/lib/outward-approval";

function isAllow(kind: string) {
  return kind === "allow_once" || kind === "allow_always";
}
function isReject(kind: string) {
  return kind === "reject_once" || kind === "reject_always";
}

/** Focus there means a key is text for that element, not an answer. */
function takesTyping(el: Element): boolean {
  return (
    (el instanceof HTMLElement && el.isContentEditable) ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

/**
 * Whether a key may answer the card drawn at `anchor`: an approval is only
 * ever given by someone looking at it.
 *
 * Every chat tab's panel stays mounted behind the one on screen, and each
 * card listens on the whole window, so without this Enter typed in one tab
 * approved the command waiting in another, unseen. The tab has to be the one
 * shown (`tabId`), nothing may cover the card (a hidden tab, a destination
 * and Settings all mark what they hide `inert`), the window has to have focus,
 * and focus may not be in something else that takes typing — an editor or a
 * terminal beside the chat. The composer stacked under the card is not
 * "something else": it keeps focus while the card is up (the card takes none),
 * and the keys typed there are the card's.
 */
function keyReachesCard(tabId: string, anchor: HTMLElement | null): boolean {
  if (!isChatTabShown(useLayoutStore.getState(), tabId)) return false;
  if (!anchor || anchor.closest("[inert]")) return false;
  if (!document.hasFocus()) return false;
  const focused = deepActiveElement();
  if (!focused || !takesTyping(focused)) return true;
  return (anchor.closest("[data-chat-composer-stack]") ?? anchor).contains(focused);
}

// Some agents bake their own brand into permission-option labels (e.g.
// codex-acp emits "No, and tell Codex what to do differently"). Rewrite any
// OTHER agent's brand to the agent actually bound to this session so the card
// never names the wrong agent.
//
// One pass over one alternation, longest brand first: replacing brand by
// brand ran each pass over the last one's output, so "Codex" became "Claude
// Code" and the `Claude` pass then matched inside it — "Claude Code Code".
// Matching the bound agent's own brand rewrites it to itself.
const AGENT_BRANDS = /\b(?:Claude Code|OpenCode|Codex|Cursor|Claude)\b/g;
function relabelAgentBrand(label: string, display: string): string {
  // `display` is `agentMeta(agentType).label`, not a raw AGENT_LABEL read: that
  // table only covers first-party agents, so every external one rendered as
  // the anonymous "the agent".
  return label.replace(AGENT_BRANDS, display);
}

interface PermissionModalProps {
  tabId: string;
  /** Send a fresh message to the agent (used by the "tell the agent what to do
   *  instead" field, which cancels the request then sends the text). */
  onSendMessage?: (text: string) => void;
}

/**
 * Renders the head of the pending-permission queue for whichever ACP session
 * is bound to this tab. The standard case is an inline card (numbered options,
 * keyboard-selectable, with a free-text fallback) pinned above the composer;
 * plan reviews keep the richer two-panel modal.
 * Cancelled requests (ESC / click outside) resolve as `cancelled` on the wire
 * so the agent backs off correctly.
 */
// memo: ChatPanel re-renders per streaming rAF flush; tabId + the stable
// onSendMessage wrapper never change identity, so the permission card's own
// narrow store subscriptions decide when it actually re-renders.
export const PermissionModal = memo(PermissionModalImpl);

function PermissionModalImpl({ tabId, onSendMessage }: PermissionModalProps) {
  // Narrow subscription: only this tab's acpSessionId and the head of its
  // permission queue, so the card stays idle until a request actually arrives.
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId);
  const current = useChatStore((s) =>
    acpSessionId ? s.pendingPermissions[acpSessionId]?.[0] : undefined,
  );
  const queueLength = useChatStore((s) =>
    acpSessionId ? (s.pendingPermissions[acpSessionId]?.length ?? 0) : 0,
  );
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType ?? "atlas-agent");
  const { applyExitPlanSelection } = useChatStore((s) => s.actions);
  const shown = useLayoutStore((s) => isChatTabShown(s, tabId));

  const [draft, setDraft] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Where the card sits in the page, for `keyReachesCard`: which composer
  // stack is its own, and whether anything covers it.
  const anchorRef = useRef<HTMLDivElement>(null);

  // Reset the free-text field whenever the active request changes.
  const reqId = current?.requestId;
  useEffect(() => {
    setDraft("");
  }, [reqId]);

  // The option Enter picks, and the one drawn as primary: an `allow_once`,
  // never an `allow_always` — an agent may list "Always allow" first, and one
  // Enter would then approve every later call of its kind. None on a card
  // without one, and none on an outward action's card: its Allow is a click
  // (`keyMayPick`).
  const primaryId = current?.options.find(
    (o) => o.kind === "allow_once" && keyMayPick(current.toolCall, o.kind),
  )?.optionId;

  // Keyboard: digits 1–9 select, Enter = primary, Esc = cancel — except while
  // the free-text field is focused (there Enter submits text, Esc still cancels).
  useEffect(() => {
    if (!current) return;
    const send = (decision: PermissionAnswer) => {
      void respondAndPopPermission(current, decision, {
        // A plan approval picks a mode the adapter applies silently — see
        // `exit-plan-modes.ts`. Mirror it, or the pill lies from here on.
        onSent: () => {
          if (decision.kind === "selected" && extractPlanMarkdown(current.toolCall)) {
            applyExitPlanSelection(tabId, decision.option_id);
          }
        },
        onError: (e) => toast.error(`Permission send failed: ${e}`),
      });
    };
    const onKey = (e: KeyboardEvent) => {
      // A chord being recorded in Settings → Keybindings is not an answer.
      if (isRecordingShortcut()) return;
      // Nor is a key from someone not looking at this card. Read per key, not
      // per render: a tab switch must not leave a listener answering for the
      // tab it hid until the effect catches up.
      if (!keyReachesCard(tabId, anchorRef.current)) return;
      const inText = document.activeElement === textRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        // The plan review is a dialog whose own Esc dismiss also cancels:
        // stop the key here, or one Esc sends two cancels.
        if (extractPlanMarkdown(current.toolCall)) e.stopPropagation();
        send({ kind: "cancelled" });
        return;
      }
      // AskUserQuestion answers are picked by click (the card's button order
      // can differ from the raw ACP option order), so don't let digits/Enter
      // resolve a possibly-mismatched option here.
      if (extractQuestions(current.toolCall)) return;
      if (inText) return; // let the field handle digits / Enter
      // A key the card takes is the card's alone: it must not also reach the
      // composer, where Enter on an empty field is Stop.
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Enter") {
        // The plan review opens with Cancel focused: Enter on a focused
        // button in it is that button's, never a silent approve.
        const focused = document.activeElement;
        if (
          extractPlanMarkdown(current.toolCall) &&
          focused instanceof HTMLButtonElement &&
          focused.closest('[role="dialog"], [role="alertdialog"]')
        )
          return;
        // Taken even with nothing to pick — an outward action's card, or one
        // that offers no `allow_once`: it neither approves nor reaches the
        // composer under the card, where Enter on an empty field is Stop.
        consume();
        if (primaryId) send({ kind: "selected", option_id: primaryId });
        return;
      }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= current.options.length) {
        const picked = current.options[n - 1];
        consume();
        if (!keyMayPick(current.toolCall, picked.kind)) return;
        send({ kind: "selected", option_id: picked.optionId });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [current, primaryId, applyExitPlanSelection, tabId]);

  if (!current) return null;

  /** Answer with an option; for a plan approval also adopt the mode it
   *  selects (`override` = the mode Atlas's own "approve and bypass" action
   *  applies on top of the plain approval). */
  const resolve = (optId: string, override?: "bypassPermissions") => {
    const isPlan = !!extractPlanMarkdown(current.toolCall);
    void respondAndPopPermission(
      current,
      { kind: "selected", option_id: optId },
      {
        onSent: () => {
          if (isPlan) applyExitPlanSelection(tabId, optId, override);
        },
        onError: (e) => toast.error(`Permission send failed: ${e}`),
      },
    );
  };

  const cancel = () => {
    void respondAndPopPermission(
      current,
      { kind: "cancelled" },
      { onError: (e) => toast.error(`Permission cancel failed: ${e}`) },
    );
  };

  // Free-text: cancel the request, then send the typed instruction as a new
  // message (ACP has no text-response path for a permission).
  const submitText = () => {
    const text = draft.trim();
    if (!text) return;
    cancel();
    onSendMessage?.(text);
  };

  // Answers → the permission wire. A single single-select answer that names a
  // real ACP option resolves it properly, so the tool call completes with an
  // answer. Anything else (several questions, multiSelect, typed text, or the
  // adapter only offering generic allow/reject) cancels the request and sends
  // the composed answers as a message — the agent reads them from there.
  const submitQuestionAnswers = (answers: Answer[]) => {
    const specs = questions ?? [];
    if (specs.length === 1 && !specs[0].multiSelect) {
      const a = answers[0];
      if (a && !a.custom.trim() && a.selected.length === 1) {
        const want = a.selected[0].trim().toLowerCase();
        const match = current.options.find((o) => o.name.trim().toLowerCase() === want);
        if (match) {
          resolve(match.optionId);
          return;
        }
      }
    }
    const text = composeAnswers(specs, answers);
    if (!text) return;
    cancel();
    onSendMessage?.(text);
  };

  // The headline and the preview box's text: a title too long for a headline
  // moves to the box (`permission-summary.ts`).
  const summary = permissionSummaryOf(current.toolCall);
  const planMarkdown = extractPlanMarkdown(current.toolCall);
  const questions = extractQuestions(current.toolCall);
  const outward = outwardApprovalOf(current.toolCall);
  const preparing = outward ? null : outwardPreparingOf(current.toolCall, current.options);
  const queueNote = queueLength > 1 ? `${queueLength - 1} more pending after this` : null;
  // What the request changes and where, beside its input: an edit sent as a
  // diff block alone has nothing in `rawInput` to show.
  const diffs = permissionDiffsOf(current.toolCall);
  const locations = permissionLocationsOf(current.toolCall, diffs);

  // The options as the views draw them — wire order, relabelled, one primary
  // at most. Shared by the inline card and the plan review.
  const agentLabel = agentMeta(agentType).label;
  const optionItems: PermissionOptionItem[] = current.options.map((opt) => ({
    optionId: opt.optionId,
    label: relabelAgentBrand(opt.name, agentLabel),
    tone: isAllow(opt.kind) ? "allow" : isReject(opt.kind) ? "reject" : "other",
    isPrimary: opt.optionId === primaryId,
  }));

  // Plan review keeps the richer two-panel modal (with number-key support from
  // the keyboard effect above).
  //
  // The Claude adapter offers ONE elevated approval, and on a model that
  // supports auto mode that is "use auto mode" — which still prompts for risky
  // tools — with no bypass choice at all. Bypass is still in the session's
  // advertised modes, only the prompt omits it, so Atlas adds the action back:
  // approve plainly, then push `bypassPermissions`.
  const bypassOptionId =
    agentType === "claude-code" &&
    planMarkdown &&
    !exitPlanOffersBypass(current.options.map((o) => o.optionId))
      ? (current.options.find((o) => o.optionId === "exit-plan-default")?.optionId ??
        current.options.find((o) => isAllow(o.kind))?.optionId ??
        null)
      : null;
  // The plan review is a modal, portalled over the whole window: drawn for a
  // tab that is not on screen, it would cover the one that is and take its
  // focus, and the next Enter or Esc meant for that tab would answer it. It
  // opens when its own tab is shown.
  if (planMarkdown && !shown) return null;

  // In a `contents` box, so the anchor adds no layout of its own.
  return (
    <div ref={anchorRef} className="contents">
      {planMarkdown ? (
        <PlanReviewView
          plan={<Markdown>{planMarkdown}</Markdown>}
          options={optionItems}
          bypassOptionId={bypassOptionId}
          queueNote={queueNote}
          onSelect={resolve}
          onCancel={cancel}
        />
      ) : questions ? (
        // AskUserQuestion — the stepper card (one question per step, radio /
        // checkbox options, free text, progress dots). All questions are
        // answered, not just the first. Submit either resolves a matching ACP
        // option (single single-select answer) or cancels the request and sends
        // the composed answers as a user message — see the card's own header
        // for the contract. Esc still backs out via this modal's keyboard
        // handler.
        <ComposerDrawer>
          <ApprovalCardView
            key={current.requestId}
            questions={questions}
            queueNote={queueNote}
            onSubmit={submitQuestionAnswers}
          />
        </ComposerDrawer>
      ) : (
        // Standard case — inline card above the composer.
        <PermissionCardView
          heading={
            preparing
              ? { kind: "preparing", preparing }
              : outward
                ? { kind: "outward", approval: outward }
                : { kind: "tool", title: summary.title, generic: summary.generic }
          }
          preview={outward || preparing ? null : summary.preview}
          diffs={diffs}
          locations={locations}
          options={optionItems}
          queueNote={queueNote}
          draft={draft}
          onDraftChange={setDraft}
          onSubmitDraft={submitText}
          draftRef={textRef}
          onSelect={(optionId) => resolve(optionId)}
        />
      )}
    </div>
  );
}
