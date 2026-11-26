// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
const respondPermission = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lib/agents-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/agents-api")>();
  return { agents: { ...real.agents, respondPermission } };
});

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import { PermissionModal } from "./permission-modal";

const OPTIONS = [
  { optionId: "allow-once", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Decline", kind: "reject_once" },
];

function pending(toolName: string, title: string, options = OPTIONS) {
  useChatStore.setState({
    sessions: {
      "chat-1": { acpSessionId: "sess-1", agentType: "atlas-agent", messages: [] },
    } as never,
    pendingPermissions: {
      "sess-1": [
        {
          agentId: "atlas-agent",
          acpSessionId: "sess-1",
          requestId: "req-1",
          toolCall: {
            toolCallId: "call-1",
            title,
            kind: "other",
            toolName,
            rawInput: { to: "general", body: "deploy is green" },
            content: ["#general, a channel", "deploy is green"],
          },
          options,
        },
      ],
    } as never,
  });
  render(<PermissionModal tabId="chat-1" />);
}

/** The card and the composer under it, as the chat panel stacks them
 *  (`data-chat-composer-stack`): the composer keeps focus while a card is
 *  up, so the keys typed there are the card's. */
function pendingAboveComposer(toolName: string, title: string, options = OPTIONS) {
  pending(toolName, title, options);
  cleanup();
  render(
    <div data-chat-composer-stack>
      <PermissionModal tabId="chat-1" />
      <div className="atlas-composer">
        <textarea aria-label="composer" />
      </div>
    </div>,
  );
  const composer = screen.getByLabelText("composer");
  composer.focus();
  return composer;
}

const picked = () =>
  (
    respondPermission.mock.calls as unknown as [unknown, unknown, unknown, { option_id?: string }][]
  ).map((call) => call[3].option_id ?? "cancelled");

const answeredRequests = () =>
  (respondPermission.mock.calls as unknown as [unknown, string, string, unknown][]).map(
    (call) => `${call[1]}/${call[2]}`,
  );

beforeEach(() => respondPermission.mockClear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useLayoutStore.setState({ tabs: [], activeByGroup: {}, activeTabId: null, viewsByWs: {} });
});

describe("keys on the permission card", () => {
  /// L7: the keys listen on the whole window, so an Enter meant for the
  /// composer as an outward card appeared would have posted in the user's
  /// name. Allow on that card is a click.
  it("an outward card is never allowed by Enter or its digit", () => {
    pending("atlas_org.org_send", "Message #general");
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "1" });
    expect(respondPermission).not.toHaveBeenCalled();
    expect(screen.queryByText("↵")).toBeNull();
  });

  /// Found in the live run: with Enter no longer taken as Allow, it fell
  /// through to the composer, where Enter on an empty field is Stop — the
  /// card was cancelled and the turn ended. The card keeps its keys.
  it("an outward card's Enter and Allow digit never reach the composer", () => {
    const composer = pendingAboveComposer("atlas_org.org_send", "Message #general");
    const reached = vi.fn();
    composer.addEventListener("keydown", reached);
    expect(fireEvent.keyDown(composer, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(composer, { key: "1" })).toBe(false);
    expect(reached).not.toHaveBeenCalled();
    expect(respondPermission).not.toHaveBeenCalled();
  });

  it("an outward card is allowed by a click, and declined by its digit", () => {
    pending("atlas_org.org_send", "Message #general");
    fireEvent.keyDown(window, { key: "2" });
    expect(picked()).toEqual(["reject"]);
  });

  it("an outward card's Allow button still works", () => {
    pending("atlas_org.org_send", "Message #general");
    fireEvent.click(screen.getByText("Allow"));
    expect(picked()).toEqual(["allow-once"]);
  });

  /// The window handler steps aside only while the "tell the agent" field
  /// holds focus, which it knows by the ref the view forwards to its
  /// textarea. Lose that ref and typing "1" there would approve option 1.
  it("digits and Enter typed into the instruction field never pick an option", () => {
    pending("shell", "rm -rf build");
    const field = screen.getByPlaceholderText(/what to do instead/);
    field.focus();
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "1" });
    fireEvent.keyDown(field, { key: "2" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(respondPermission).not.toHaveBeenCalled();
  });

  it("any other card keeps Enter for Allow", () => {
    pending("shell", "rm -rf build");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(picked()).toEqual(["allow-once"]);
  });

  /// Esc on the plan review reached both the window handler and the dialog's
  /// own dismiss, so the agent was sent two cancels for one request.
  it("Esc on the plan review cancels once", () => {
    pendingPlan();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(picked()).toEqual(["cancelled"]);
  });

  /// The plan review opens with Cancel focused. Enter there belongs to the
  /// button; the window handler must not turn it into an approve.
  it("Enter on the plan review's focused Cancel never approves", async () => {
    pendingPlan();
    const cancel = screen.getByText("Cancel").closest("button");
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.keyDown(cancel!, { key: "Enter" });
    expect(picked()).not.toContain("allow-once");
  });
});

// ── Who may answer (#1) ─────────────────────────────────────────────────────
//
// Every chat tab's panel stays mounted behind the one on screen, and each
// card listened on the whole window. So Enter typed into tab A's composer
// approved the command waiting in tab B, unseen; a digit picked B's option and
// Esc cancelled B's turn. A key is an answer only from someone looking at the
// card: its tab on screen, the window focused, and the key not typed into
// something else.

const chatTab = (id: string) =>
  ({ id, type: "chat", title: "Session", closable: true, dirty: false, data: {} }) as never;

/** `shown` on screen, `hidden` mounted behind it, as the column keeps them. */
function twoTabs(shown: string, hidden: string) {
  useLayoutStore.setState({
    tabs: [chatTab(shown), chatTab(hidden)],
    activeByGroup: { main: shown },
    activeTabId: shown,
  });
}

function request(sessionId: string, requestId: string, title: string) {
  return {
    agentId: "atlas-agent",
    acpSessionId: sessionId,
    requestId,
    toolCall: { toolCallId: `call-${requestId}`, title, kind: "execute", rawInput: {} },
    options: OPTIONS,
  };
}

/** Two chat tabs' cards, mounted together as two panels are; `requests` is
 *  what each session is waiting on. */
function twoCards(requests: Record<string, ReturnType<typeof request>[]>) {
  useChatStore.setState({
    sessions: {
      "chat-1": { acpSessionId: "sess-1", agentType: "atlas-agent", messages: [] },
      "chat-2": { acpSessionId: "sess-2", agentType: "atlas-agent", messages: [] },
    } as never,
    pendingPermissions: requests as never,
  });
  render(
    <>
      <div data-chat-composer-stack>
        <PermissionModal tabId="chat-1" />
        <div className="atlas-composer">
          <textarea aria-label="composer 1" />
        </div>
      </div>
      <div data-chat-composer-stack>
        <PermissionModal tabId="chat-2" />
        <div className="atlas-composer">
          <textarea aria-label="composer 2" />
        </div>
      </div>
    </>,
  );
}

describe("a key answers only the card someone is looking at", () => {
  it("a hidden tab's request is not answered by Enter, a digit or Esc", () => {
    twoTabs("chat-1", "chat-2");
    twoCards({ "sess-2": [request("sess-2", "req-b", "rm -rf build")] });
    const composer = screen.getByLabelText("composer 1");
    composer.focus();
    for (const key of ["Enter", "1", "2", "Escape"]) {
      fireEvent.keyDown(composer, { key });
      fireEvent.keyDown(window, { key });
    }
    expect(respondPermission).not.toHaveBeenCalled();
  });

  it("the shown tab's card still answers, and only for its own request", () => {
    twoTabs("chat-1", "chat-2");
    twoCards({
      "sess-1": [request("sess-1", "req-a", "npm test")],
      "sess-2": [request("sess-2", "req-b", "rm -rf build")],
    });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(answeredRequests()).toEqual(["sess-1/req-a"]);
    expect(picked()).toEqual(["allow-once"]);
  });

  it("a background project's tab answers nothing", () => {
    useLayoutStore.setState({
      tabs: [chatTab("chat-1")],
      activeByGroup: { main: "chat-1" },
      viewsByWs: {
        elsewhere: { tabs: [chatTab("chat-2")], activeByGroup: { main: "chat-2" } } as never,
      },
    });
    twoCards({ "sess-2": [request("sess-2", "req-b", "rm -rf build")] });
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(respondPermission).not.toHaveBeenCalled();
  });

  it("a card under a cover (a destination, Settings) answers nothing", () => {
    pending("shell", "rm -rf build");
    cleanup();
    render(
      <div inert>
        <PermissionModal tabId="chat-1" />
      </div>,
    );
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "1" });
    expect(respondPermission).not.toHaveBeenCalled();
  });

  it("keys typed into something else that takes text are that thing's", () => {
    pendingAboveComposer("shell", "rm -rf build");
    // An editor in the column beside the chat.
    const editor = document.createElement("textarea");
    document.body.appendChild(editor);
    editor.focus();
    for (const key of ["Enter", "1", "Escape"]) {
      // Not taken: the editor gets its own keystroke.
      expect(fireEvent.keyDown(editor, { key })).toBe(true);
    }
    expect(respondPermission).not.toHaveBeenCalled();
    editor.remove();
  });

  it("no key answers while the window does not have focus", () => {
    pending("shell", "rm -rf build");
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(respondPermission).not.toHaveBeenCalled();
  });

  it("the composer under the card is the card's: Enter there approves", () => {
    const composer = pendingAboveComposer("shell", "rm -rf build");
    expect(fireEvent.keyDown(composer, { key: "Enter" })).toBe(false);
    expect(picked()).toEqual(["allow-once"]);
  });

  /// The plan review is a modal: drawn for a hidden tab it covered the tab on
  /// screen and took its focus, so the next Enter or Esc meant for that tab
  /// answered it.
  it("a hidden tab's plan review stays closed until its tab is shown", async () => {
    twoTabs("chat-1", "chat-2");
    useChatStore.setState({
      sessions: {
        "chat-1": { acpSessionId: "sess-1", agentType: "atlas-agent", messages: [] },
        "chat-2": { acpSessionId: "sess-2", agentType: "atlas-agent", messages: [] },
      } as never,
      pendingPermissions: {
        "sess-2": [
          {
            ...request("sess-2", "req-plan", "Ready to code?"),
            toolCall: {
              toolCallId: "call-plan",
              title: "Ready to code?",
              kind: "switch_mode",
              toolName: "ExitPlanMode",
              rawInput: { plan: "1. Do the thing" },
            },
          },
        ],
      } as never,
    });
    render(
      <>
        <PermissionModal tabId="chat-1" />
        <PermissionModal tabId="chat-2" />
      </>,
    );
    expect(screen.queryByTestId("plan-review")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(respondPermission).not.toHaveBeenCalled();

    act(() =>
      useLayoutStore.setState({ activeByGroup: { main: "chat-2" }, activeTabId: "chat-2" }),
    );
    await waitFor(() => expect(screen.getByTestId("plan-review")).toBeTruthy());
  });
});

// ── Enter is "allow once" (#30) ─────────────────────────────────────────────
//
// Enter took the first allow option in wire order, and an agent may list
// "Always allow" first: one Enter then approved every future call of that
// kind. Enter is never "always": it picks an `allow_once`, and with none on
// the card it does nothing — not even fall through to the composer, where
// Enter on an empty field is Stop.

describe("Enter on a permission card", () => {
  const ALWAYS_FIRST = [
    { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
    { optionId: "allow-once", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Decline", kind: "reject_once" },
  ];
  const NO_ONCE = [
    { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject", name: "Decline", kind: "reject_once" },
  ];

  it("picks allow_once even when allow_always comes first", () => {
    pending("shell", "rm -rf build", ALWAYS_FIRST);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(picked()).toEqual(["allow-once"]);
  });

  it("draws allow_once as the option Enter picks", () => {
    pending("shell", "rm -rf build", ALWAYS_FIRST);
    expect(screen.getAllByText("↵")).toHaveLength(1);
    expect(screen.getByText("Allow").closest("button")?.textContent).toContain("↵");
  });

  it("answers nothing when the card offers no allow_once", () => {
    const composer = pendingAboveComposer("shell", "rm -rf build", NO_ONCE);
    const reached = vi.fn();
    composer.addEventListener("keydown", reached);
    expect(fireEvent.keyDown(composer, { key: "Enter" })).toBe(false);
    expect(reached).not.toHaveBeenCalled();
    expect(respondPermission).not.toHaveBeenCalled();
    expect(screen.queryByText("↵")).toBeNull();
  });

  it("still lets a digit pick allow_always deliberately", () => {
    pending("shell", "rm -rf build", NO_ONCE);
    fireEvent.keyDown(window, { key: "1" });
    expect(picked()).toEqual(["allow-always"]);
  });
});

function pendingPlan() {
  useChatStore.setState({
    sessions: {
      "chat-1": { acpSessionId: "sess-1", agentType: "atlas-agent", messages: [] },
    } as never,
    pendingPermissions: {
      "sess-1": [
        {
          agentId: "atlas-agent",
          acpSessionId: "sess-1",
          requestId: "req-plan",
          toolCall: {
            toolCallId: "call-plan",
            title: "Ready to code?",
            kind: "switch_mode",
            toolName: "ExitPlanMode",
            rawInput: { plan: "1. Do the thing" },
          },
          options: OPTIONS,
        },
      ],
    } as never,
  });
  render(<PermissionModal tabId="chat-1" />);
}

it("does not turn model search input or modified digits into permission answers", () => {
  pendingAboveComposer("Bash", "npm test");
  const search = document.createElement("input");
  screen.getByLabelText("composer").closest("[data-chat-composer-stack]")!.appendChild(search);
  search.focus();
  for (const key of ["1", "Enter", "Escape"]) fireEvent.keyDown(search, { key });
  expect(respondPermission).not.toHaveBeenCalled();
  screen.getByLabelText("composer").focus();
  fireEvent.keyDown(window, { key: "1", metaKey: true });
  fireEvent.keyDown(window, { key: "1", ctrlKey: true });
  fireEvent.keyDown(window, { key: "Enter", keyCode: 229 });
  expect(respondPermission).not.toHaveBeenCalled();
});
