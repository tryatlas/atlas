import type { RefObject } from "react";
import { PanelSkeleton } from "@/components/panel-skeleton";

/** The chat panel before its session exists. Normally a single frame; on a
 *  first-ever launch it also covers the brief wait for the probe that decides
 *  which agent this chat starts on. */
export function ChatPanelSkeleton({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  return (
    // The same flat surface as the live chat, so the tab does not change
    // shape when the session lands a frame later.
    <div ref={rootRef} className="h-full min-h-0 overflow-hidden bg-[var(--background)]">
      <div className="mx-auto w-full max-w-(--atlas-chat-column) pt-[46px]">
        <PanelSkeleton rows={6} />
      </div>
    </div>
  );
}
