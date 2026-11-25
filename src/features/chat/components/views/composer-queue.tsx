// Queued messages above the composer's input. Props-only.

import { Pencil, X } from "lucide-react";
import { Button, Hint, Icon, Pill } from "@tryatlas/design";

export function ComposerQueue({
  queue,
  remoteDriving,
  paused = false,
  onResume,
  onEdit,
  onRemove,
}: {
  queue: readonly string[];
  remoteDriving: boolean;
  /** A failed turn halted the queue (ACP audit finding 77): nothing runs
   *  until the user resumes it. */
  paused?: boolean;
  onResume?: () => void;
  onEdit: (text: string, index: number) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="mb-2 flex flex-col gap-1">
      <div className="flex items-center gap-2 px-1">
        <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          Queued · {queue.length}
          {/* The owner's queued prompts wait while someone else drives
              (R4): Rust's drain skips them until the seat is back. */}
          {remoteDriving && " · runs when you take over"}
        </div>
        {paused && (
          <div data-slot="queue-paused" className="ml-auto flex items-center gap-1.5">
            <span className="text-2xs text-warning">Queue paused — the last turn failed</span>
            <Button variant="warning-outline" size="xs" onClick={onResume}>
              Resume
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {queue.map((q, i) => (
          <QueueChip key={i} text={q} onEdit={() => onEdit(q, i)} onRemove={() => onRemove(i)} />
        ))}
      </div>
    </div>
  );
}

function QueueChip({
  text,
  onEdit,
  onRemove,
}: {
  text: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <Pill render={<div />} className="group max-w-[260px]">
      <button
        type="button"
        onClick={onEdit}
        className="flex items-center gap-1 min-w-0 cursor-pointer hover:text-foreground"
        title="Edit / merge into input"
      >
        <Icon icon={Pencil} size="xs" className="shrink-0 text-muted-foreground" />
        <span className="truncate">{text.replace(/\s+/g, " ")}</span>
      </button>
      <Hint label="Remove from queue" side="top">
        <button
          type="button"
          onClick={onRemove}
          className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-element-hover hover:text-error"
        >
          <Icon icon={X} size="xs" />
        </button>
      </Hint>
    </Pill>
  );
}
