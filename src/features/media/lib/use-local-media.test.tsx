// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalMedia } from "./media-api";

const open = vi.hoisted(() => vi.fn());
vi.mock("./media-api", () => ({ openLocalMedia: open }));
import { useLocalMedia } from "./use-local-media";

const deferred = () => {
  let resolve!: (value: LocalMedia) => void;
  const promise = new Promise<LocalMedia>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => open.mockReset());
afterEach(cleanup);

it("revokes a late native lease after changing files and never displays it", async () => {
  const old = deferred();
  const closedOld = vi.fn(async () => {});
  const closedNew = vi.fn(async () => {});
  open
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ url: "http://localhost/new", close: closedNew });
  const { result, rerender, unmount } = renderHook(({ path }) => useLocalMedia(path, "video"), {
    initialProps: { path: "/old.mp4" },
  });
  rerender({ path: "/new.mp4" });
  await waitFor(() => expect(result.current.url).toBe("http://localhost/new?v=0"));
  await act(async () => old.resolve({ url: "http://localhost/old", close: closedOld }));
  expect(closedOld).toHaveBeenCalledOnce();
  expect(result.current.url).toBe("http://localhost/new?v=0");
  unmount();
  expect(closedNew).toHaveBeenCalledOnce();
});

it("opens a fresh lease for an edited file and surfaces authorization failures", async () => {
  const close = vi.fn(async () => {});
  open
    .mockResolvedValueOnce({ url: "asset://file", close })
    .mockRejectedValueOnce(new Error("access denied"));
  const { result, rerender } = renderHook(
    ({ revision }) => useLocalMedia("/file.png", "image", revision),
    { initialProps: { revision: 1 } },
  );
  await waitFor(() => expect(result.current.url).toBe("asset://file?v=1"));
  rerender({ revision: 2 });
  expect(result.current.url).toBeNull();
  await waitFor(() => expect(result.current.error).toContain("access denied"));
  expect(close).toHaveBeenCalledOnce();
});
