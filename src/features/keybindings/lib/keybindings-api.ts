import { invoke } from "@tauri-apps/api/core";
import type { KeybindingsFile } from "./types";

/** Thin IPC wrapper over `src-tauri/src/commands/keybindings.rs`. Components
 *  never call these directly — the store owns every write. */

export interface KeybindingsLoadResult {
  file: KeybindingsFile;
  path: string;
  /** False until the file has been written once — the first-run signal. */
  exists: boolean;
  warnings: string[];
  /** Existing unreadable files use defaults for dispatch only. */
  writable?: boolean;
}

export function loadKeybindings(): Promise<KeybindingsLoadResult> {
  return invoke<KeybindingsLoadResult>("keybindings_load");
}

export function saveKeybindings(file: KeybindingsFile): Promise<KeybindingsFile> {
  return invoke<KeybindingsFile>("keybindings_save", { file });
}

export function openKeybindingsFile(): Promise<void> {
  return invoke("keybindings_open");
}
