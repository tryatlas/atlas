// The Memory surface's history rail, props-only: a hairline in a 32px gutter
// with a round node per row, the shape the package's old `SessionTimeline`
// drew before the transcript replaced it. The geometry (gutter, gap, node
// size, the hairline stopping at the end nodes' centres) is memory's own.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Centre of a node from the top of its row: the hairline starts and stops there. */
const NODE_CENTRE = 16;

/** One row on the rail: its node in the gutter and its slice of the
 *  hairline, half-height at the ends. */
export function RailRow({
  node,
  first = false,
  last = false,
  className,
  style,
  children,
}: {
  node: ReactNode;
  first?: boolean;
  last?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className={cn("grid grid-cols-[32px_minmax(0,1fr)] gap-3.5", className)} style={style}>
      <div className="relative flex justify-center">
        <span
          aria-hidden
          className="absolute left-1/2 -ml-px w-px bg-border-subtle"
          style={{
            top: first ? NODE_CENTRE : 0,
            bottom: last ? `calc(100% - ${NODE_CENTRE}px)` : 0,
          }}
        />
        {node}
      </div>
      <div className="min-w-0 pb-5">{children}</div>
    </div>
  );
}

/** The round node a rail row hangs from. Opaque, so the hairline behind it
 *  does not cross the glyph. */
export function RailNode({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full border border-border-strong/50 bg-card text-secondary-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
