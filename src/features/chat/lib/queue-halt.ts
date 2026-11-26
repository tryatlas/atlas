// When the queue is paused by a failed turn (ACP audit finding 77).
//
// The turn controller in Rust (`turn_returned` in
// `src-tauri/src/commands/agent_host/steering.rs`) halts a non-empty queue
// when the turn it ran failed, instead of draining it into an agent that just
// errored, refused or ran out of tokens; `agents_queue_resume` lifts the halt.
// The halt itself is not on the wire, so the window derives it from the same
// facts the controller decides on: how the turn ended, and whether anything
// was queued behind it.

/** The stop reasons the controller counts as a failed turn (`turn_failed` in
 *  `steering.rs`), besides a turn that errored outright. */
const HALTING_STOP_REASONS: ReadonlySet<string> = new Set([
  "refusal",
  "max_tokens",
  "max_turn_requests",
]);

/** Whether a turn that ended with `stopReason` halts the queue behind it. */
export function stopReasonHaltsQueue(stopReason: string): boolean {
  return HALTING_STOP_REASONS.has(stopReason);
}

/** "Queue paused — Resume" shows exactly while a failed turn's halt stands
 *  and there is something queued to resume. */
export function queuePausedByFailure(halted: boolean | undefined, queueLength: number): boolean {
  return halted === true && queueLength > 0;
}
