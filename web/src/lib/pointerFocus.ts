/**
 * Safari doesn't move focus to a button or link when it's clicked, and by default its Tab key skips links. So after a
 * click, document.activeElement is <body> and a field's blur has no relatedTarget, and a focus trap that only wraps
 * when the last item is focused lets Tab escape. These helpers make dialogs, drawers and forms behave the same in
 * every browser.
 */

const CONTROL = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
/** A press counts as "now" for this long (pointerdown → blur → click is far shorter). */
const PRESS_MS = 1000;

let last: { el: HTMLElement; at: number } | null = null;

if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (e) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>(CONTROL) : null;
      last = el ? { el, at: Date.now() } : null;
    },
    true,
  );
}

/** The control the pointer is pressing right now, or null. */
export function pressedControl(): HTMLElement | null {
  return last && Date.now() - last.at < PRESS_MS && last.el.isConnected ? last.el : null;
}

/**
 * Where focus should return when a dialog closes: the control just clicked to open it (Safari leaves focus wherever it
 * was, e.g. the page heading), else the focused element.
 */
export function focusOrigin(): HTMLElement | null {
  const pressed = pressedControl();
  if (pressed) return pressed;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/** The elements Tab visits inside `node`, in order: visible matches of `selector`, one per radio group. */
export function tabbables(node: HTMLElement, selector: string): HTMLElement[] {
  const all = Array.from(node.querySelectorAll<HTMLElement>(selector)).filter((el) => el.offsetParent !== null);
  return all.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name) return true;
    const group = all.filter((o): o is HTMLInputElement => o instanceof HTMLInputElement && o.type === "radio" && o.name === el.name);
    return el === (group.find((o) => o.checked) ?? group[0]);
  });
}

/**
 * Moves focus to the next (Shift: previous) item itself and wraps at the ends, so Tab never leaves the trap, even in
 * a browser that would skip some of the items. Focus outside the items (e.g. a title with tabindex -1) goes to the
 * first (Shift: last) item.
 */
export function trapTab(e: KeyboardEvent, items: HTMLElement[]) {
  e.preventDefault();
  if (items.length === 0) return;
  const active = document.activeElement;
  let i = items.findIndex((el) => el === active);
  if (i === -1 && active instanceof HTMLInputElement && active.type === "radio" && active.name)
    i = items.findIndex((el) => el instanceof HTMLInputElement && el.type === "radio" && el.name === active.name);
  const next = i === -1 ? (e.shiftKey ? items.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + items.length) % items.length;
  items[next].focus();
}
