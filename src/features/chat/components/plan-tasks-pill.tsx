import { memo } from "react";
import { useChatStore } from "../stores/chat-store";
import { isBusyAgentStatus } from "@/types/agent";
import { ComposerDropup, useComposerDropup } from "./composer-dropup";
import { PlanTasksListView, PlanTasksTriggerView } from "./views/plan-tasks-pill-view";

/**
 * The live plan as a composer-footer pill + its own morphing dropup panel —
 * replaces the old PlanDock strip above the composer. The pill carries a
 * determinate arc ring (completed/total) and the count; the panel is the
 * beui-style "Implementation plan" list: circled-check + strikethrough for
 * done, a spinning arc for the in-progress step, a faint circle for pending.
 *
 * The plan is the agent's and stands until the agent replaces or clears it:
 * a turn ending does not hide it, so a plan the agent is working through
 * across several prompts stays in reach between them (ACP audit finding 102). It hides
 * when there is none, and once every step is done and the session is idle —
 * a finished plan lives on in the thread, not as composer chrome. `livePlan`
 * resets on every (re)bind.
 *
 * Same interaction grammar as the composer's other menus: height-morph panel
 * (ResizeObserver → height tween), Esc/outside closes, and it participates in
 * the `atlas:composer-menu-open` mutual-exclusion signal.
 */

export const PlanTasksPill = memo(function PlanTasksPill({ tabId }: { tabId: string }) {
  const plan = useChatStore((s) => s.sessions[tabId]?.livePlan);
  const status = useChatStore((s) => s.sessions[tabId]?.status);
  const { open, toggle, ref, contentRef, panelHeight } = useComposerDropup("plan", {
    measureKey: plan?.length,
  });

  if (!plan || plan.length === 0) return null;
  const completed = plan.filter((s) => s.status === "completed").length;
  // See the module docs: only a finished plan on an idle session is hidden.
  if (completed === plan.length && !isBusyAgentStatus(status ?? "idle")) return null;

  return (
    <div ref={ref} className="relative">
      {/* Morphing panel — right-anchored dropup, shared with the options and
          usage pills. */}
      <ComposerDropup open={open} panelHeight={panelHeight} contentRef={contentRef} width={320}>
        <PlanTasksListView steps={plan} open={open} />
      </ComposerDropup>
      <PlanTasksTriggerView
        completed={completed}
        total={plan.length}
        open={open}
        onToggle={toggle}
      />
    </div>
  );
});
