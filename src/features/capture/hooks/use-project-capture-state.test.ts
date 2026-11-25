// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { tauri } from "@/test/tauri-fake";
import { useProjectCaptureState } from "./use-project-capture-state";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

const binding = (project: string) => ({ enabled: true, project }) as never;

beforeEach(() => tauri.reset());

it("drops the previous project's binding as soon as the project changes", async () => {
  tauri.handleRaw({
    capture_binding: (args) => {
      const { projectPath } = args as { projectPath: string };
      return projectPath === "/a" ? binding("/a") : new Promise(() => {});
    },
    capture_health: () => null,
  });
  const { result, rerender } = renderHook(({ path }) => useProjectCaptureState(path), {
    initialProps: { path: "/a" as string | undefined },
  });
  await waitFor(() => expect(result.current.binding).toEqual(binding("/a")));
  rerender({ path: "/b" });
  expect(result.current.binding).toBeNull();
  expect(result.current.health).toBeNull();
});

it("ignores an answer that lands after the project changed", async () => {
  let releaseA!: () => void;
  tauri.handleRaw({
    capture_binding: (args) => {
      const { projectPath } = args as { projectPath: string };
      return projectPath === "/a"
        ? new Promise((done) => {
            releaseA = () => done(binding("/a"));
          })
        : binding("/b");
    },
    capture_health: () => null,
  });
  const { result, rerender } = renderHook(({ path }) => useProjectCaptureState(path), {
    initialProps: { path: "/a" as string | undefined },
  });
  rerender({ path: "/b" });
  await waitFor(() => expect(result.current.binding).toEqual(binding("/b")));
  await act(async () => releaseA());
  expect(result.current.binding).toEqual(binding("/b"));
});
