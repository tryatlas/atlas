import { beforeEach, expect, it, vi } from "vitest";
import { useMemoryGraphStore } from "./memory-graph-store";
import { useMemoryStore } from "./memory-store";
import { memoryGraph } from "../lib/memory-graph-api";
import { memoryPolicy } from "../lib/memory-policy-api";
vi.mock("../lib/memory-graph-api", () => ({
  memoryGraph: { embedStatus: vi.fn(async () => ({ downloaded: true })), buildIndex: vi.fn() },
}));
vi.mock("../lib/memory-policy-api", () => ({ memoryPolicy: { list: vi.fn() } }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  useMemoryGraphStore.setState({ projectPath: null, graph: null, phase: "checking" });
  useMemoryStore.getState().actions.ensureProject(null);
});
it("ignores a slow graph build even after returning to its project", async () => {
  const first = deferred<Awaited<ReturnType<typeof memoryGraph.buildIndex>>>();
  vi.mocked(memoryGraph.buildIndex)
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue({ nodes: [], edges: [], dim: 1, doc_count: 8 });
  const old = useMemoryGraphStore.getState().actions.init("/a");
  await vi.waitFor(() => expect(memoryGraph.buildIndex).toHaveBeenCalledWith("/a"));
  await useMemoryGraphStore.getState().actions.init("/b");
  await useMemoryGraphStore.getState().actions.init("/a");
  first.resolve({ nodes: [], edges: [], dim: 1, doc_count: 99 });
  await old;
  expect(useMemoryGraphStore.getState()).toMatchObject({
    projectPath: "/a",
    docCount: 8,
    phase: "graph-ready",
  });
});
it("does not replace the incoming project's policy table or start a stale download callback load", async () => {
  const first = deferred<Awaited<ReturnType<typeof memoryPolicy.list>>>();
  vi.mocked(memoryPolicy.list).mockReturnValueOnce(first.promise).mockResolvedValue([]);
  const actions = useMemoryStore.getState().actions;
  actions.ensureProject("/a");
  const old = actions.loadPolicies("/a");
  actions.ensureProject("/b");
  await actions.loadPolicies("/b");
  await actions.loadPolicies("/a", true);
  expect(memoryPolicy.list).toHaveBeenCalledTimes(2);
  first.resolve([]);
  await old;
  expect(useMemoryStore.getState()).toMatchObject({
    project: "/b",
    policies: [],
    policyPhase: "ready",
  });
});
