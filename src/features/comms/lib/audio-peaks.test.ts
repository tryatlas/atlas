import { afterEach, expect, it, vi } from "vitest";
import { decodePeaks } from "./audio-peaks";

afterEach(() => vi.unstubAllGlobals());

it("does not fetch or decode long recordings just to draw their waveform", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(await decodePeaks("long-recording", 3600)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("remembers decode failures across mounts", async () => {
  const fetch = vi.fn(async () => {
    throw new Error("unsupported media");
  });
  vi.stubGlobal("fetch", fetch);
  expect(await decodePeaks("bad-audio", 10)).toBeNull();
  expect(await decodePeaks("bad-audio", 10)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("cancels an unknown-length body before buffering more than the waveform budget", async () => {
  const cancel = vi.fn();
  const read = vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(5 * 1024 * 1024) });
  const context = vi.fn();
  vi.stubGlobal("AudioContext", context);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) },
    })),
  );
  expect(await decodePeaks("oversized", 10)).toBeNull();
  expect(read).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledOnce();
  expect(context).not.toHaveBeenCalled();
});
