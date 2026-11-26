import { isMac } from "./platform";

/** WebKit may clear isComposing before the candidate-confirming Enter. */
export function isComposingKey(event: {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  const native = event.nativeEvent ?? event;
  return native.isComposing === true || native.keyCode === 229 || event.keyCode === 229;
}

export function isTypingElement(element: Element | null): boolean {
  return (
    element instanceof HTMLElement &&
    (element.isContentEditable ||
      element.matches("input,textarea,select") ||
      !!element.closest('[contenteditable="true"]'))
  );
}

/** Option letters and unshifted terminal Ctrl keys are text/shell input. */
export function preservesTextInput(event: KeyboardEvent): boolean {
  if (isComposingKey(event) || (!isMac && event.getModifierState?.("AltGraph"))) return true;
  const target = event.composedPath?.()[0] ?? event.target;
  if (!(target instanceof Element)) return false;
  if (
    !isMac &&
    target.closest(".xterm") &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  )
    return true;
  return (
    isMac &&
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    isTypingElement(target) &&
    (event.key.length === 1 || event.key === "Dead")
  );
}
