import { beforeEach, describe, expect, it, vi } from "vitest";

// A restart of one project's session: `<project>/.atlas/session.json`.
//
// Rust stores that file as the string it was handed and returns the same
// bytes (`a_session_is_returned_byte_for_byte_after_a_restart` in
// `commands/project_session.rs`), so the shape is this store's alone. The
// fake below is that pass-through.
vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
import { tauri } from "@/test/tauri-fake";

import { useSessionStore } from "./session-store";

type ProjectSession = ReturnType<typeof useSessionStore.getState>["session"];

const PROJECT = "/Users/dev/atlas";
const actions = () => useSessionStore.getState().actions;

/** Every field set to something that is not its default. Typed, so a field
 *  added to the session does not compile until it is given a value here. */
const FULL: ProjectSession = {
  lastOpenedFiles: ["src/main.rs", "README.md"],
  knowledgeActiveNoteId: "note-42",
  chatContext: "the migration plan",
  searchHistory: ["fn main", "TODO"],
};

let onDisk: string | null;

beforeEach(async () => {
  tauri.reset();
  onDisk = null;
  tauri.handleRaw({
    save_project_session: (args) => {
      const { projectPath, sessionData } = args as { projectPath: string; sessionData: string };
      expect(projectPath).toBe(PROJECT);
      onDisk = sessionData;
      return null;
    },
    load_project_session: () => onDisk ?? "{}",
  });
  // A project with no file loads the defaults: the clean slate.
  await actions().loadSession(PROJECT);
});

describe("a project's session across a restart", () => {
  it("starts from the defaults when nothing was saved", () => {
    const defaults = useSessionStore.getState().session;

    expect(Object.keys(defaults).sort()).toEqual(Object.keys(FULL).sort());
    for (const key of Object.keys(FULL) as Array<keyof ProjectSession>) {
      expect(defaults[key], key).not.toEqual(FULL[key]);
    }
  });

  it("comes back field for field", async () => {
    useSessionStore.setState({ session: FULL });
    await actions().saveSession(PROJECT);
    expect(JSON.parse(onDisk!)).toEqual(FULL);

    useSessionStore.setState({ session: { ...FULL, chatContext: "", searchHistory: [] } });
    await actions().loadSession(PROJECT);

    expect(useSessionStore.getState().session).toEqual(FULL);
  });

  it("gives a field missing from an older file its default", async () => {
    onDisk = JSON.stringify({ chatContext: "kept" });

    await actions().loadSession(PROJECT);

    expect(useSessionStore.getState().session).toEqual({
      lastOpenedFiles: [],
      knowledgeActiveNoteId: null,
      chatContext: "kept",
      searchHistory: [],
    });
  });

  it("falls back to the defaults when the file does not parse", async () => {
    useSessionStore.setState({ session: FULL });
    onDisk = "{ not json";

    await actions().loadSession(PROJECT);

    expect(useSessionStore.getState().session.searchHistory).toEqual([]);
  });
});

describe("a project's search history across a switch", () => {
  const OTHER = "/Users/dev/other";
  const disks = new Map<string, string>();

  beforeEach(() => {
    disks.clear();
    tauri.handleRaw({
      save_project_session: (args) => {
        const { projectPath, sessionData } = args as { projectPath: string; sessionData: string };
        disks.set(projectPath, sessionData);
        return null;
      },
      load_project_session: (args) =>
        disks.get((args as { projectPath: string }).projectPath) ?? "{}",
    });
  });

  it("drops a search that finishes after the project changed", async () => {
    disks.set(PROJECT, JSON.stringify({ searchHistory: ["mine"] }));
    await actions().loadSession(PROJECT);
    await actions().loadSession(OTHER);

    actions().addSearchHistory(PROJECT, "late query");
    await actions().saveSession(PROJECT);

    expect(useSessionStore.getState().session.searchHistory).toEqual([]);
    expect(JSON.parse(disks.get(PROJECT)!).searchHistory).toEqual(["mine"]);
    expect(disks.has(OTHER)).toBe(false);
  });

  it("never shows or saves the previous project's history while the next one loads", async () => {
    disks.set(PROJECT, JSON.stringify({ searchHistory: ["from project"] }));
    await actions().loadSession(PROJECT);
    let release!: () => void;
    tauri.handleRaw({
      load_project_session: () =>
        new Promise<string>((done) => {
          release = () => done(JSON.stringify({ searchHistory: ["from other"] }));
        }),
    });
    const loading = actions().loadSession(OTHER);
    expect(useSessionStore.getState().session.searchHistory).toEqual([]);

    actions().addSearchHistory(OTHER, "typed while loading");
    const saving = actions().saveSession(OTHER);
    release();
    await loading;
    await saving;

    expect(useSessionStore.getState().session.searchHistory).toEqual([
      "typed while loading",
      "from other",
    ]);
    expect(JSON.parse(disks.get(OTHER)!).searchHistory).toEqual([
      "typed while loading",
      "from other",
    ]);
  });

  it("ignores a load that resolves after a newer one", async () => {
    let releaseOld!: () => void;
    tauri.handleRaw({
      load_project_session: (args) =>
        (args as { projectPath: string }).projectPath === PROJECT
          ? new Promise<string>((done) => {
              releaseOld = () => done(JSON.stringify({ searchHistory: ["stale"] }));
            })
          : JSON.stringify({ searchHistory: ["current"] }),
    });
    const old = actions().loadSession(PROJECT);
    await actions().loadSession(OTHER);
    releaseOld();
    await old;
    expect(useSessionStore.getState().projectPath).toBe(OTHER);
    expect(useSessionStore.getState().session.searchHistory).toEqual(["current"]);
  });
});
