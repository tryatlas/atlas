import { useEffect } from "react";
import { Menu, type MenuItemOptions, type PredefinedMenuItemOptions } from "@tauri-apps/api/menu";
import { toast } from "sonner";
import { isLinux } from "./platform";
import { deepActiveElement } from "./deep-active-element";
import { copyText, readClipboardText } from "./clipboard";

/**
 * The right-click menu anywhere nothing more specific claimed it: the
 * platform's own edit menu, popped by the shell.
 *
 * Native, not a React popup, for the selection's sake. A DOM menu takes focus
 * and a pointer press, and either one clears the selection the user
 * right-clicked to act on. The shell's menu touches neither, and its edit
 * items run the webview's own `copy:` / `paste:` actions, which the platform
 * enables against the live selection and the focused field.
 *
 * A row, a tab or a canvas with its own menu prevents the event first (Base
 * UI's `ContextMenu.Trigger` does), and this stands down for it.
 */
export function useNativeContextMenu() {
  useEffect(() => {
    // Outside the shell (`bun run dev` in a browser) the browser's own menu
    // is the native one.
    if (!(globalThis as { isTauri?: boolean }).isTauri) return;
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      void showEditMenu(linkAt(event.target));
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);
}

/** An http(s) link under the pointer: the one thing worth more than editing. */
function linkAt(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target : null;
  const href = element?.closest("a[href]")?.getAttribute("href");
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

async function showEditMenu(link: string | null) {
  const items: (MenuItemOptions | PredefinedMenuItemOptions)[] = [];
  if (link) {
    items.push({ text: "Copy Link", action: () => void copyText(link) }, { item: "Separator" });
  }
  if (isLinux) {
    // muda's predefined editing items require libxdo. Operate on the saved
    // webview selection instead, keeping text edits in the editor undo path.
    const focused = deepActiveElement();
    const input =
      focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
        ? focused
        : null;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const start = input?.selectionStart ?? 0;
    const end = input?.selectionEnd ?? 0;
    const text = input ? input.value.slice(start, end) : (selection?.toString() ?? "");
    const editable =
      (!!input && !input.readOnly && !input.disabled) ||
      (focused instanceof HTMLElement && focused.isContentEditable);
    const restore = () => {
      if (focused && !focused.isConnected) return false;
      if (focused instanceof HTMLElement) focused.focus();
      if (input) input.setSelectionRange(start, end);
      else if (range) {
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      return true;
    };
    const replace = (value: string) => {
      if (!restore()) return;
      if (document.execCommand("insertText", false, value)) return;
      if (input) {
        input.setRangeText(value, start, end, "end");
        input.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
        );
      } else throw new Error("The focused editor refused the edit");
    };
    const run = (work: () => Promise<void>) => {
      void work().catch((error) => toast.error(`Clipboard action failed: ${String(error)}`));
    };
    items.push(
      {
        text: "Cut",
        enabled: editable && !!text,
        action: () =>
          run(async () => {
            if (!(await copyText(text))) throw new Error("Could not copy selection");
            replace("");
          }),
      },
      {
        text: "Copy",
        enabled: !!text,
        action: () =>
          run(async () => {
            if (!(await copyText(text))) throw new Error("Could not copy selection");
          }),
      },
      {
        text: "Paste",
        enabled: editable,
        action: () => run(async () => replace(await readClipboardText())),
      },
      {
        text: "Select All",
        action: () => {
          if (!restore()) return;
          if (input) input.select();
          else document.execCommand("selectAll");
        },
      },
    );
  } else items.push({ item: "Cut" }, { item: "Copy" }, { item: "Paste" }, { item: "SelectAll" });
  const menu = await Menu.new({ items });
  await menu.popup();
}
