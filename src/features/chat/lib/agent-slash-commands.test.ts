// The slash picker's catalogue: what the agent advertised, plus Atlas's own
// commands. ADR-0005 makes the agent's list the authority, so nothing it
// advertises may be dropped or answered by Atlas instead (#44).

import { beforeEach, describe, expect, it, vi } from "vitest";

const agent = vi.hoisted(() => ({ signIn: true, fork: true }));

vi.mock("@/features/agents/lib/agent-meta", () => ({
  agentMeta: () => ({ label: "Test Agent" }),
  catalogEntry: () => ({ supportsFork: agent.fork }),
}));
vi.mock("./agent-signin", () => ({ canSignIn: () => agent.signIn }));

import { atlasCommandNames, buildAgentSlashCommands } from "./agent-slash-commands";

const advertised = (...names: string[]) => names.map((name) => ({ name, description: name }));
const rows = (agentType: string, commands: unknown[]) =>
  buildAgentSlashCommands(agentType, commands).map((c) => [c.name, c.handler]);

beforeEach(() => {
  agent.signIn = true;
  agent.fork = true;
});

describe("buildAgentSlashCommands", () => {
  it("lists Atlas's own commands under their plain names when the agent has none of them", () => {
    expect(rows("codex", advertised("review"))).toEqual([
      ["login", "agent-login"],
      ["review", "passthrough"],
      ["fork", "fork"],
      ["queue", "queue"],
    ]);
  });

  it("keeps every command the agent advertises, `/login` included", () => {
    const names = buildAgentSlashCommands("codex", advertised("login", "fork", "queue")).filter(
      (c) => c.handler === "passthrough",
    );
    expect(names.map((c) => c.name)).toEqual(["login", "fork", "queue"]);
  });

  it("names Atlas's own command apart when the agent advertises the same name", () => {
    expect(rows("codex", advertised("login", "fork", "queue"))).toEqual([
      ["atlas:login", "agent-login"],
      ["login", "passthrough"],
      ["fork", "passthrough"],
      ["queue", "passthrough"],
      ["atlas:fork", "fork"],
      ["atlas:queue", "queue"],
    ]);
    const queue = buildAgentSlashCommands("codex", advertised("queue")).find(
      (c) => c.handler === "queue",
    );
    expect(queue?.signature).toBe("/atlas:queue <message>");
  });

  it("every row has its own name, so a typed name reaches exactly one of them", () => {
    const all = buildAgentSlashCommands(
      "codex",
      advertised("login", "atlas:login", "fork", "queue"),
    );
    const names = all.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    // Both of the sign-in's names are the agent's: Atlas's gives way.
    expect(all.filter((c) => c.handler === "agent-login")).toEqual([]);
  });

  it("offers /fork and /login only where the agent can do them", () => {
    agent.signIn = false;
    agent.fork = false;
    expect(rows("codex", [])).toEqual([["queue", "queue"]]);
  });
});

describe("atlasCommandNames", () => {
  it("is what typing reaches Atlas's fork and queue by", () => {
    expect(atlasCommandNames(buildAgentSlashCommands("codex", []))).toEqual({
      fork: "fork",
      queue: "queue",
    });
    expect(
      atlasCommandNames(buildAgentSlashCommands("codex", advertised("fork", "queue"))),
    ).toEqual({ fork: "atlas:fork", queue: "atlas:queue" });
    agent.fork = false;
    expect(atlasCommandNames(buildAgentSlashCommands("codex", [])).fork).toBeNull();
  });
});
