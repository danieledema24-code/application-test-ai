/**
 * Route-change focus (AppShell) moves focus to the page h1. A screen that restores focus itself, such as the
 * test-case list returning to the row a user opened, claims the focus so the h1 doesn't take it back.
 * A claim is short-lived, so a late claim can't suppress the h1 focus of a later visit.
 */
const CLAIM_MS = 3000;
let claim: { path: string; at: number } | null = null;

export function claimRouteFocus(pathname: string) {
  claim = { path: pathname, at: Date.now() };
}

/** True once per claim, when the screen at `pathname` has placed focus itself. */
export function takeRouteFocusClaim(pathname: string): boolean {
  const c = claim;
  if (!c || c.path !== pathname || Date.now() - c.at > CLAIM_MS) return false;
  claim = null;
  return true;
}
