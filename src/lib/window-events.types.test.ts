// What `tsc` refuses at a window-event call site. Each `@ts-expect-error`
// fails `bun run typecheck` (this file is in `tsconfig.test.json`) the day
// the line under it starts to compile, which is the day the map stopped
// checking that mistake. Nothing here runs: the calls sit in a function that
// is never called.

import { describe, expect, it } from "vitest";
import { emitWindowEvent, onWindowEvent, useWindowEvent } from "./window-events";

// Named as a hook only because it calls one (`rules-of-hooks`).
function useRefused(): void {
  // ── A name that is not in the map ────────────────────────────────────────
  // @ts-expect-error not a window event
  emitWindowEvent("atlas:no-such-event");
  // @ts-expect-error not a window event
  onWindowEvent("atlas:no-such-event", () => {});
  // @ts-expect-error not a window event
  useWindowEvent("atlas:no-such-event", () => {});
  // @ts-expect-error a Tauri channel is not a window event
  onWindowEvent("atlas:git-changed", () => {});
  // @ts-expect-error a name must be one the compiler can check, not any string
  emitWindowEvent("atlas:chat-focus" as string, { tabId: "t" });

  // ── A wrong payload ──────────────────────────────────────────────────────
  // @ts-expect-error tabId is a string
  emitWindowEvent("atlas:chat-focus", { tabId: 1 });
  // @ts-expect-error the detail is a menu id, not an object
  emitWindowEvent("atlas:composer-menu-open", { menu: "add" });
  // @ts-expect-error another event's payload
  emitWindowEvent("atlas:org-agent-report", { tabId: "t" });
  // @ts-expect-error a field the payload does not have
  emitWindowEvent("atlas:chat-stop", { tabId: "t", force: true });
  // @ts-expect-error an event with no payload takes none
  emitWindowEvent("atlas:window-active", { tabId: "t" });

  // ── A missing payload ────────────────────────────────────────────────────
  // @ts-expect-error the detail is required
  emitWindowEvent("atlas:chat-focus");
  // @ts-expect-error required even when every field of it is optional
  emitWindowEvent("atlas:chat-send");
  // @ts-expect-error options do not stand in for the detail
  emitWindowEvent("atlas:chat-send", { cancelable: true });

  // ── A listener that misreads the detail ──────────────────────────────────
  // @ts-expect-error the handler's detail is the map's, not the caller's guess
  onWindowEvent("atlas:chat-focus", (detail: { tab: string }) => void detail);
  onWindowEvent("atlas:chat-focus", (detail) => {
    // @ts-expect-error no such field on this event's detail
    void detail.url;
  });
  useWindowEvent("atlas:composer-menu-open", (detail) => {
    // @ts-expect-error the detail is a string
    void detail.tabId;
  });
}

/** What does compile, so a regression in the other direction shows too. */
function accepted(): Array<() => unknown> {
  return [
    () => emitWindowEvent("atlas:window-active"),
    () => emitWindowEvent("atlas:chat-focus", { tabId: "t" }),
    () => emitWindowEvent("atlas:chat-send", { tabId: "t", text: "hi" }, { cancelable: true }),
    () => emitWindowEvent("atlas:chat-send", {}),
    () => onWindowEvent("atlas:chat-focus", (detail) => detail.tabId.length),
    () => onWindowEvent("atlas:chat-send", (_detail, event) => event.preventDefault()),
    () => onWindowEvent("atlas:window-active", () => {}),
  ];
}

describe("window event types", () => {
  it("are checked by tsc, not here", () => {
    expect(typeof useRefused).toBe("function");
    expect(accepted()).toHaveLength(7);
  });
});
