"""In-page reads for the accessibility check (P5-02): the axe run and the Tab/Shift+Tab keyboard pass.

Only `page.evaluate` reads and the Tab and Shift+Tab keys are used. Never Enter, Space, clicks, typing or form
submission. axe runs from the pinned source (`app/automation/axe.py`) through `page.evaluate`, so the page's CSP
can't block it.
"""

from __future__ import annotations

import contextlib
from typing import Any

from playwright.async_api import Error, Page

from app.automation.axe import TAGS, AxeScript

MAX_PRESSES = 60
OUTLINE_JS = """(targets) => {
  const boxes = [];
  targets.forEach((sel, i) => {
    let el = null;
    try { el = document.querySelector(sel); } catch (e) { el = null; }
    if (!el) return;
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.setAttribute('data-ata-outline', String(i + 1));
    box.style.cssText = `position:absolute;left:${r.left + window.scrollX - 4}px;top:${r.top + window.scrollY - 4}px;` +
      `width:${r.width + 8}px;height:${r.height + 8}px;outline:3px solid #b91c1c;box-shadow:inset 0 0 0 2px #fff;` +
      'z-index:2147483647;pointer-events:none';
    const badge = document.createElement('span');
    badge.textContent = String(i + 1);
    badge.style.cssText = 'position:absolute;left:-14px;top:-14px;min-width:24px;height:24px;border-radius:12px;' +
      'background:#b91c1c;color:#fff;font:bold 14px/24px system-ui;text-align:center;border:2px solid #fff';
    box.appendChild(badge);
    document.body.appendChild(box);
    boxes.push(i + 1);
  });
  return boxes;
}"""
CLEAR_OUTLINES_JS = "() => document.querySelectorAll('[data-ata-outline]').forEach((e) => e.remove())"

_DESCRIBE = """
  const w = window; w.__ata = w.__ata || { ids: new WeakMap(), n: 0 };
  const idOf = (el) => { let id = w.__ata.ids.get(el); if (!id) { id = ++w.__ata.n; w.__ata.ids.set(el, id); } return id; };
  const sel = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 3; e = e.parentElement) {
      if (e.id) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let p = e.tagName.toLowerCase();
      const sib = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
      if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(e) + 1})`;
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'Link';
    if (t === 'button') return 'Button';
    if (t === 'select') return 'Combo box';
    if (t === 'textarea') return 'Text box';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (['checkbox', 'radio'].includes(ty)) return ty === 'radio' ? 'Radio button' : 'Checkbox';
      if (['submit', 'button', 'reset'].includes(ty)) return 'Button';
      return 'Text box';
    }
    return t;
  };
  const labelOf = (el) => {
    const l = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) ||
      el.innerText || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || '';
    return String(l).replace(/\\s+/g, ' ').trim().slice(0, 80);
  };
"""
ACTIVE_JS = (
    "() => {"
    + _DESCRIBE
    + """
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { body: true };
  const style = (e) => { const c = getComputedStyle(e); return [c.outlineStyle, c.outlineWidth, c.outlineColor,
    c.boxShadow, c.borderColor, c.borderWidth, c.backgroundColor, c.color, c.textDecorationLine].join('|'); };
  const focused = style(el);
  el.blur();
  const unfocused = style(el);
  el.focus({ preventScroll: true });
  return { body: false, id: idOf(el), selector: sel(el), label: labelOf(el), role: roleOf(el),
           visible_focus: focused !== unfocused };
}"""
)
TABBABLE_JS = (
    "() => {"
    + _DESCRIBE
    + """
  const q = 'a[href], button, input:not([type=hidden]), select, textarea, [tabindex], [contenteditable=true], summary';
  const out = []; const radios = new Set();
  for (const el of document.querySelectorAll(q)) {
    if (el.closest('[data-ata-outline]')) continue;
    if (el.disabled || el.tabIndex < 0 || el.closest('[inert]')) continue;
    if (el.closest('dialog:not([open])') || el.closest('details:not([open]) > :not(summary)')) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) continue;
    if (el.type === 'radio' && el.name) { if (radios.has(el.name)) continue; radios.add(el.name); }
    out.push({ id: idOf(el), selector: sel(el), label: labelOf(el), role: roleOf(el) });
  }
  return out;
}"""
)


async def run_axe(page: Page, axe: AxeScript) -> dict[str, Any]:
    """axe-core's results for the page (WCAG 2.0–2.2 A/AA plus best practice), as axe returns them."""
    # Evaluated as an expression through the DevTools protocol: not a script tag or eval() in the page, so the
    # target's Content-Security-Policy can't block it (bypass_csp stays off).
    if not await page.evaluate("() => !!window.axe"):
        await page.evaluate(f"(() => {{\n{axe.source}\n;return true;}})()")
    result: dict[str, Any] = await page.evaluate(
        """async (tags) => {
          const r = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'] });
          const keep = (v) => ({ id: v.id, impact: v.impact, tags: v.tags, help: v.help, helpUrl: v.helpUrl,
            description: v.description, nodes: v.nodes.slice(0, 20).map((n) => ({ target: n.target, html: n.html,
            failureSummary: n.failureSummary })) });
          return { violations: r.violations.map(keep), incomplete: r.incomplete.map(keep), passes: r.passes.length };
        }""",
        TAGS,
    )
    return result


async def keyboard_pass(page: Page, *, max_presses: int = MAX_PRESSES) -> dict[str, Any]:
    """Presses Tab (up to 60 times) then Shift+Tab back. Records the focus order; never activates anything."""
    with contextlib.suppress(Error):
        await page.evaluate(
            "() => { if (document.activeElement) document.activeElement.blur(); window.scrollTo(0, 0); }"
        )
    tabbable = await page.evaluate(TABBABLE_JS)
    order: list[dict[str, Any]] = []
    seen: set[int] = set()
    stuck_at: str | None = None
    completed = cycled = False
    repeats = 0
    presses = 0
    for _ in range(max_presses):
        await page.keyboard.press("Tab")
        presses += 1
        a = await page.evaluate(ACTIVE_JS)
        if a.get("body"):
            if order:
                completed = True
                break
            continue
        if order and a["id"] == order[-1]["id"]:
            repeats += 1
            if repeats >= 2:  # focus didn't move for 3 presses
                stuck_at = a["selector"]
                break
            continue
        repeats = 0
        if a["id"] in seen:
            completed = True
            cycled = True
            break
        seen.add(a["id"])
        order.append(a)
    reverse_ok = True
    if order and stuck_at is None:
        moved = 0
        last = None
        for _ in range(min(len(order), 10)):
            await page.keyboard.press("Shift+Tab")
            presses += 1
            a = await page.evaluate(ACTIVE_JS)
            if not a.get("body") and a.get("id") != last:
                moved += 1
            last = a.get("id")
        reverse_ok = moved > 0 or len(order) == 1
    return {
        "order": order,
        "tabbable": tabbable,
        "stuck_at": stuck_at,
        "completed": completed,
        "cycled": cycled,
        "presses": presses,
        "reverse_ok": reverse_ok,
    }


async def outlined_screenshot(page: Page, targets: list[str]) -> bytes | None:
    """A masked screenshot (password inputs hidden) with the given elements outlined and numbered ① ②."""
    try:
        await page.evaluate(OUTLINE_JS, targets[:20])
        return await page.screenshot(
            type="jpeg", quality=70, full_page=True, mask=[page.locator("input[type=password]")], timeout=10_000
        )
    except Error:
        return None
    finally:
        with contextlib.suppress(Error):
            await page.evaluate(CLEAR_OUTLINES_JS)
