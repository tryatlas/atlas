import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useKnowledgeGraphStore } from "./knowledge-graph-store";
import { useKnowledgeLinksStore } from "./knowledge-links-store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

/** Makes the next `listen` call hang until the returned `resolve` is called. */
function deferNextListen() {
  let resolve!: (off: () => void) => void;
  vi.mocked(listen).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  return (off: () => void) => resolve(off);
}

beforeEach(() => {
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (_command, args) => {
      const { projectPath } = args as { projectPath: string };
      return { nodes: [{ id: projectPath }], edges: [] };
    });
});
afterEach(() => {
  useKnowledgeGraphStore.getState().actions.unbind();
  useKnowledgeLinksStore.getState().actions.unbind();
});

describe("knowledge graph store binding", () => {
  it("disposes a listener that resolves after a different project was bound", async () => {
    const resolveOld = deferNextListen();
    const staleOff = vi.fn();
    const old = useKnowledgeGraphStore.getState().actions.bind("/a");
    await useKnowledgeGraphStore.getState().actions.bind("/b");
    resolveOld(staleOff);
    await old;
    expect(staleOff).toHaveBeenCalledTimes(1);
    expect(useKnowledgeGraphStore.getState().projectPath).toBe("/b");
    expect(useKnowledgeGraphStore.getState().graph?.nodes[0]?.id).toBe("/b");
  });

  it("disposes a listener that resolves after unbind", async () => {
    const resolveOld = deferNextListen();
    const staleOff = vi.fn();
    const old = useKnowledgeGraphStore.getState().actions.bind("/a");
    useKnowledgeGraphStore.getState().actions.unbind();
    resolveOld(staleOff);
    await old;
    expect(staleOff).toHaveBeenCalledTimes(1);
    expect(useKnowledgeGraphStore.getState().projectPath).toBeNull();
    expect(useKnowledgeGraphStore.getState().graph).toBeNull();
  });
});

describe("knowledge links store binding", () => {
  it("disposes a listener that resolves after a different project was bound", async () => {
    const resolveOld = deferNextListen();
    const staleOff = vi.fn();
    const old = useKnowledgeLinksStore.getState().actions.bind("/a");
    await useKnowledgeLinksStore.getState().actions.bind("/b");
    resolveOld(staleOff);
    await old;
    expect(staleOff).toHaveBeenCalledTimes(1);
    expect(useKnowledgeLinksStore.getState().projectPath).toBe("/b");
  });

  it("disposes a listener that resolves after unbind", async () => {
    const resolveOld = deferNextListen();
    const staleOff = vi.fn();
    const old = useKnowledgeLinksStore.getState().actions.bind("/a");
    useKnowledgeLinksStore.getState().actions.unbind();
    resolveOld(staleOff);
    await old;
    expect(staleOff).toHaveBeenCalledTimes(1);
    expect(useKnowledgeLinksStore.getState().projectPath).toBeNull();
  });
});
