// Responsive observation at the current viewport. Read-only.
(() => {
  const visible = (el) => {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const navLinks = [...document.querySelectorAll("nav a[href], header a[href], [role=navigation] a[href]")];
  const visibleNav = navLinks.filter(visible).length;
  const menuButton = [...document.querySelectorAll("button, [role=button]")].some(
    (b) => visible(b) && /menu|navigation|nav/i.test((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")) && b.hasAttribute("aria-expanded")
  );
  const doc = document.documentElement;
  return {
    width: window.innerWidth,
    nav_links_total: navLinks.length,
    nav_links_visible: visibleNav,
    menu_button: menuButton,
    horizontal_overflow: doc.scrollWidth > window.innerWidth + 1,
    scroll_width: doc.scrollWidth,
  };
})()
