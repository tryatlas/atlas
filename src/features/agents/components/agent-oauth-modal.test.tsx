// @vitest-environment happy-dom
//
// #67: an agent's `authenticate` has no deadline, so dismissing the sign-in
// while one is in flight has to end it on the agent too
// (`agents_cancel_authentication`). Dismissing anything else asks for nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

const cancelAuthentication = vi.hoisted(() => vi.fn(async (_agentId: string) => undefined));
vi.mock("@/features/agents/lib/agent-auth-api", () => ({ cancelAuthentication }));

// The sign-in itself never answers: the user is still in their browser.
const runSignInMethod = vi.hoisted(() => vi.fn(() => new Promise<void>(() => {})));
vi.mock("@/features/chat/lib/agent-signin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/chat/lib/agent-signin")>()),
  runSignInMethod,
}));

const BROWSER = {
  id: "browser",
  name: "Sign in with a browser",
  description: null,
  kind: "agent",
  link: null,
  terminalCommand: null,
  terminalArgs: null,
  terminalLabel: null,
  apiKeyProvider: null,
} as const;
const OTHER = { ...BROWSER, id: "other", name: "Another way" } as const;

vi.mock("@/features/chat/lib/agents-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/chat/lib/agents-api")>();
  return {
    ...actual,
    ensureAgent: vi.fn(async () => ({ agent_id: "agent-1" })),
    listenAuthEnvUpdated: vi.fn(async () => () => {}),
    listenAuthRunProgress: vi.fn(async () => () => {}),
    agents: {
      ...actual.agents,
      listAuthMethods: vi.fn(async () => [BROWSER, OTHER]),
      authEnvStatus: vi.fn(async () => []),
    },
  };
});

import { emitWindowEvent } from "@/lib/window-events";
import { AgentOAuthModalHost } from "./agent-oauth-modal";

async function openSignIn() {
  render(<AgentOAuthModalHost />);
  act(() => emitWindowEvent("atlas:agent-signin", { agentType: "demo-agent", requestId: 1 }));
  return screen.findByText("Sign in with a browser");
}

beforeEach(() => {
  cancelAuthentication.mockClear();
  runSignInMethod.mockClear();
});
afterEach(cleanup);

describe("dismissing the sign-in", () => {
  it("cancels the authenticate still in flight", async () => {
    fireEvent.click(await openSignIn());
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(runSignInMethod).toHaveBeenCalledOnce();
    expect(cancelAuthentication).toHaveBeenCalledWith("agent-1");
  });

  it("asks for nothing when no sign-in is running", async () => {
    await openSignIn();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(cancelAuthentication).not.toHaveBeenCalled();
  });
});
