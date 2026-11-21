// Calls for one key share at most two runs: the one in flight and one fresh
// run queued behind it. Guards the editor's blame and change bars, where one
// git process per caller is what froze large repositories.

import { describe, expect, it, vi } from "vitest";
import { coalesceByKey } from "./coalesce-by-key";

/** A read whose runs resolve or reject only when the test says so. */
function controlledRead() {
  const runs: { key: string; resolve: (v: string) => void; reject: (e: Error) => void }[] = [];
  const run = vi.fn(
    (key: string) =>
      new Promise<string>((resolve, reject) => {
        runs.push({ key, resolve, reject });
      }),
  );
  const read = coalesceByKey((key: string) => key, run);
  return { read, run, runs };
}

describe("coalesceByKey", () => {
  it("runs a lone call at once", async () => {
    const { read, run, runs } = controlledRead();
    const result = read("a");
    expect(run).toHaveBeenCalledExactlyOnceWith("a");
    runs[0].resolve("a1");
    await expect(result).resolves.toBe("a1");
  });

  it("queues one fresh run behind a running one, shared by every later caller", async () => {
    const { read, run, runs } = controlledRead();
    const first = read("a");
    const second = read("a");
    const third = read("a");
    expect(run).toHaveBeenCalledTimes(1);

    runs[0].resolve("old");
    await expect(first).resolves.toBe("old");
    // The callers that arrived mid-flight get a read that started after it.
    expect(run).toHaveBeenCalledTimes(2);
    runs[1].resolve("new");
    await expect(second).resolves.toBe("new");
    await expect(third).resolves.toBe("new");
    expect(second).toBe(third);
  });

  it("keeps keys apart", () => {
    const { read, run } = controlledRead();
    void read("a");
    void read("b");
    expect(run.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("starts afresh once a key's reads have settled", async () => {
    const { read, run, runs } = controlledRead();
    const first = read("a");
    runs[0].resolve("a1");
    await first;
    const again = read("a");
    expect(run).toHaveBeenCalledTimes(2);
    runs[1].resolve("a2");
    await expect(again).resolves.toBe("a2");
  });

  it("still runs the queued read when the running one fails", async () => {
    const { read, run, runs } = controlledRead();
    const first = read("a");
    const second = read("a");
    runs[0].reject(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    expect(run).toHaveBeenCalledTimes(2);
    runs[1].resolve("ok");
    await expect(second).resolves.toBe("ok");
  });

  it("hands a failure of the queued read to its callers only", async () => {
    const { read, runs } = controlledRead();
    const first = read("a");
    const second = read("a");
    runs[0].resolve("a1");
    await expect(first).resolves.toBe("a1");
    runs[1].reject(new Error("gone"));
    await expect(second).rejects.toThrow("gone");
  });
});
