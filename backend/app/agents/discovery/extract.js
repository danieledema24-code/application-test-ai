// In-page extraction for the Application Discovery Agent. Ported from api/src/services/discovery.ts
// (EXTRACT_SCRIPT) and extended for dropdowns, search, filters, tables, modals, tabs, accordions, menus,
// pagination, ARIA roles, form constraints and locator candidates. Read-only: it never clicks or types.
// Evaluated as an expression; returns plain JSON.
(() => {
  const MAX = { links: 300, nav: 40, headings: 30, forms: 15, fields: 30, components: 120, text: 20000, hidden: 5000 };
  const clean = (s, n = 120) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const text = (el, n = 120) => clean(el && (el.innerText || el.textContent), n);
  const uniqBy = (arr, key) => { const seen = new Set(); return arr.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const q = (s) => JSON.stringify(s);
  const cssPath = (el) => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return "#" + el.id;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5 && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      const name = cur.getAttribute("name");
      if (name && /^[\w-]+$/.test(name)) { parts.unshift(part + '[name="' + name + '"]'); break; }
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ");
  };
  const labelText = (el) => {
    const id = el.getAttribute("id");
    let lab = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
    if (!lab) lab = el.closest("label");
    if (lab) {
      const copy = lab.cloneNode(true);
      copy.querySelectorAll("input,select,textarea").forEach((x) => x.remove());
      const t = clean(copy.textContent, 80);
      if (t) return t;
    }
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = clean(lb.split(/\s+/).map((i) => { const n = document.getElementById(i); return n ? n.textContent : ""; }).join(" "), 80);
      if (t) return t;
    }
    return clean(el.getAttribute("aria-label") || "", 80);
  };
  const accName = (el) =>
    clean(el.getAttribute("aria-label") || "", 80) || labelText(el) || text(el, 80) || clean(el.getAttribute("title") || el.getAttribute("alt") || el.value || el.getAttribute("placeholder") || "", 80);
  const implicitRole = (el) => {
    const t = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (el.getAttribute("role")) return el.getAttribute("role");
    if (t === "button" || (t === "input" && ["submit", "button", "reset", "image"].includes(type))) return "button";
    if (t === "a" && el.hasAttribute("href")) return "link";
    if (t === "select") return el.multiple || Number(el.size) > 1 ? "listbox" : "combobox";
    if (t === "textarea") return "textbox";
    if (t === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      if (type === "range") return "slider";
      if (["", "text", "email", "tel", "url", "password", "number"].includes(type)) return type === "number" ? "spinbutton" : "textbox";
    }
    if (t === "table") return "table";
    if (t === "dialog") return "dialog";
    if (t === "nav") return "navigation";
    if (t === "form") return "form";
    if (t === "details") return "group";
    return null;
  };
  const locators = (el) => {
    const out = [];
    const role = implicitRole(el);
    const name = accName(el);
    const tid = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-test");
    const lab = ["input", "select", "textarea"].includes(el.tagName.toLowerCase()) ? labelText(el) : "";
    if (role && name && role !== "password") out.push("getByRole(" + q(role) + ", { name: " + q(name) + " })");
    if (lab) out.push("getByLabel(" + q(lab) + ")");
    if (el.getAttribute("placeholder")) out.push("getByPlaceholder(" + q(clean(el.getAttribute("placeholder"), 80)) + ")");
    if (!lab && name && ["a", "button"].includes(el.tagName.toLowerCase())) out.push("getByText(" + q(name) + ")");
    if (tid) out.push("getByTestId(" + q(tid) + ")");
    out.push("locator(" + q(cssPath(el)) + ")");
    return out;
  };
  const snippet = (el) => {
    const c = el.cloneNode(true);
    const strip = (n) => { if (n.matches && n.matches("input[type=password],input[type=hidden]")) n.removeAttribute("value"); };
    strip(c);
    if (c.querySelectorAll) c.querySelectorAll("input[type=password],input[type=hidden]").forEach(strip);
    if (c.querySelectorAll) c.querySelectorAll("script,style,svg").forEach((n) => n.remove());
    return clean(c.outerHTML, 300);
  };
  const DESTRUCTIVE = /\b(delete|remove|destroy|erase|unsubscribe|deactivate|close account|cancel (my )?(subscription|order|account))\b/i;
  const TRANSACTIONAL = /\b(buy|purchase|checkout|check out|pay|place order|order now|add to (basket|cart|bag)|subscribe|donate|book now)\b/i;
  const SEARCHY = /\b(search|query|keyword|find)\b/i;
  const FILTERY = /filter|facet|refine|sort|category|categories/i;

  // ---------------------------------------------------------------- links, nav, headings
  const allLinks = [...document.querySelectorAll("a[href]")];
  const links = uniqBy(allLinks.map((a) => ({ href: a.href, text: text(a, 80), rel: a.getAttribute("rel") || "", download: a.hasAttribute("download") })), (l) => l.href).slice(0, MAX.links);
  const navEls = [...document.querySelectorAll("nav, header, [role=navigation]")];
  const navLinks = uniqBy(
    navEls.flatMap((n) => [...n.querySelectorAll("a[href]")]).map((a) => ({ text: text(a, 60), href: a.href })).filter((l) => l.text),
    (l) => l.text + "|" + l.href
  ).slice(0, MAX.nav);
  const headings = [...document.querySelectorAll("h1, h2, h3")].map((h) => ({ level: Number(h.tagName[1]), text: text(h, 140) })).filter((h) => h.text).slice(0, MAX.headings);

  // ---------------------------------------------------------------- forms
  const forms = [...document.querySelectorAll("form")].slice(0, MAX.forms).map((f) => {
    const submit = f.querySelector("button[type=submit], input[type=submit], button:not([type])");
    const fields = [...f.querySelectorAll("input, select, textarea")]
      .filter((i) => !["hidden", "submit", "button", "reset", "image"].includes((i.type || "").toLowerCase()))
      .slice(0, MAX.fields)
      .map((i) => {
        const tag = i.tagName.toLowerCase();
        const ml = i.getAttribute("maxlength");
        const mn = i.getAttribute("minlength");
        return {
          name: i.getAttribute("name") || i.getAttribute("id") || "",
          type: tag === "input" ? (i.getAttribute("type") || "text").toLowerCase() : tag,
          label: labelText(i) || clean(i.getAttribute("placeholder") || "", 80),
          required: Boolean(i.required) || i.getAttribute("aria-required") === "true",
          placeholder: i.getAttribute("placeholder") ? clean(i.getAttribute("placeholder"), 80) : null,
          constraints: {
            min: i.getAttribute("min"),
            max: i.getAttribute("max"),
            maxlength: ml !== null && /^\d+$/.test(ml) ? Number(ml) : null,
            minlength: mn !== null && /^\d+$/.test(mn) ? Number(mn) : null,
            pattern: i.getAttribute("pattern"),
            step: i.getAttribute("step"),
          },
          options: tag === "select" ? [...i.options].map((o) => text(o, 60)).filter(Boolean).slice(0, 25) : null,
          autocomplete: i.getAttribute("autocomplete"),
          locator: locators(i)[0],
        };
      });
    const method = (f.getAttribute("method") || "get").toUpperCase();
    return {
      name: clean(f.getAttribute("aria-label") || f.getAttribute("name") || f.getAttribute("id") || "", 80) || null,
      heading: (() => { let n = f; for (let i = 0; i < 4 && n; i++) { const h = n.querySelector && n.querySelector("h1,h2,h3,legend"); if (h) return text(h, 80); n = n.parentElement; } return null; })(),
      method,
      action: f.action || location.href,
      submit_label: submit ? (text(submit, 60) || submit.value || submit.getAttribute("aria-label") || null) : null,
      role: f.getAttribute("role"),
      fields,
      selector: cssPath(f),
      locator: locators(f)[0],
      html: snippet(f),
    };
  });

  // ---------------------------------------------------------------- components
  const comps = [];
  const add = (kind, el, details = {}) => {
    if (comps.length >= MAX.components) return;
    const locs = locators(el);
    comps.push({ kind, role: implicitRole(el), name: accName(el) || kind, locator: locs[0], locators: locs, selector: cssPath(el), visible: visible(el), details, html: snippet(el) });
  };
  document.querySelectorAll("button, [role=button], input[type=submit], input[type=button], input[type=reset]").forEach((b) => {
    const name = accName(b);
    add("button", b, {
      in_form: Boolean(b.closest("form")),
      type: (b.getAttribute("type") || (b.tagName === "BUTTON" ? "submit" : "")).toLowerCase(),
      destructive: DESTRUCTIVE.test(name),
      transactional: TRANSACTIONAL.test(name),
      disabled: Boolean(b.disabled) || b.getAttribute("aria-disabled") === "true",
    });
  });
  document.querySelectorAll("select, [role=combobox], [aria-haspopup=listbox], [aria-haspopup=menu], [aria-haspopup=true]").forEach((d) => {
    const inFilter = Boolean(d.closest("[class*=filter i], [id*=filter i], [aria-label*=filter i], [class*=facet i], [class*=sort i], [aria-label*=sort i]"));
    const nameish = (d.getAttribute("name") || "") + " " + accName(d);
    if (d.tagName === "SELECT" && (inFilter || FILTERY.test(nameish))) {
      add("filter", d, { control: "select", options: [...d.options].map((o) => text(o, 40)).slice(0, 15) });
    } else if (d.tagName === "SELECT" && d.closest("form")) {
      // Form selects are reported as form fields.
    } else {
      add("dropdown", d, { options: d.tagName === "SELECT" ? [...d.options].map((o) => text(o, 40)).slice(0, 15) : null });
    }
  });
  const searchInputs = [...document.querySelectorAll("input[type=search], [role=searchbox], [role=search] input, input[name=q], input[name=query], input[name=search], input[name=s], input[name=keyword], input[name=keywords]")];
  document.querySelectorAll("input[type=text], input:not([type])").forEach((i) => {
    if (SEARCHY.test((i.getAttribute("placeholder") || "") + " " + labelText(i) + " " + (i.getAttribute("aria-label") || ""))) searchInputs.push(i);
  });
  uniqBy(searchInputs, (x) => cssPath(x)).forEach((i) => {
    const f = i.closest("form");
    add("search", i, { form_method: f ? (f.getAttribute("method") || "get").toUpperCase() : null, form_action: f ? f.action : null, param: i.getAttribute("name") });
  });
  document.querySelectorAll("[class*=filter i] input[type=checkbox], [class*=filter i] input[type=radio], [aria-label*=filter i] input[type=checkbox], fieldset[class*=filter i]").forEach((c) => {
    add("filter", c, { control: c.tagName === "FIELDSET" ? "group" : c.type, label: labelText(c) });
  });
  document.querySelectorAll("table, [role=grid], [role=table]").forEach((t) => {
    const headers = [...t.querySelectorAll("th, [role=columnheader]")].map((h) => text(h, 40)).filter(Boolean);
    const rows = t.querySelectorAll("tr, [role=row]").length;
    if (headers.length === 0 && rows < 2) return; // layout table
    add("table", t, { columns: headers.slice(0, 20), rows, sortable: Boolean(t.querySelector("[aria-sort], th[class*=sort i]")), caption: t.querySelector("caption") ? text(t.querySelector("caption"), 80) : null });
  });
  const dialogs = [...document.querySelectorAll("dialog, [role=dialog], [role=alertdialog], [aria-modal=true]")];
  uniqBy(dialogs, (d) => cssPath(d)).forEach((d) => add("modal", d, { open: visible(d), trigger: false }));
  document.querySelectorAll("[aria-haspopup=dialog], [data-toggle=modal], [data-bs-toggle=modal], [data-modal-target], [data-dialog]").forEach((t) => {
    add("modal", t, { open: false, trigger: true, controls: t.getAttribute("aria-controls") || t.getAttribute("data-bs-target") || t.getAttribute("data-target") || t.getAttribute("data-modal-target") });
  });
  document.querySelectorAll("[role=tablist]").forEach((t) => add("tabs", t, { tabs: [...t.querySelectorAll("[role=tab]")].map((x) => text(x, 40)).slice(0, 12) }));
  document.querySelectorAll("details").forEach((d) => add("accordion", d, { summary: text(d.querySelector("summary"), 80), open: d.open }));
  document.querySelectorAll("[aria-expanded]:not([aria-haspopup]):not([role=tab]):not([role=combobox])").forEach((b) => {
    const label = accName(b);
    if (/menu|navigation|nav/i.test(label) || b.closest("header, nav")) add("menu", b, { toggle: true, expanded: b.getAttribute("aria-expanded") === "true" });
    else add("accordion", b, { expanded: b.getAttribute("aria-expanded") === "true", controls: b.getAttribute("aria-controls") });
  });
  document.querySelectorAll("[role=menu], [role=menubar]").forEach((m) => add("menu", m, { items: [...m.querySelectorAll("[role^=menuitem]")].map((x) => text(x, 40)).slice(0, 15) }));
  const pagers = [...document.querySelectorAll("nav[aria-label*=pagination i], [class*=pagination i], ul.pager, [role=navigation][aria-label*=page i]")];
  uniqBy(pagers, (p) => cssPath(p)).forEach((p) => add("pagination", p, { links: [...p.querySelectorAll("a[href]")].map((a) => ({ text: text(a, 20), href: a.href })).slice(0, 15) }));
  const relNext = document.querySelector("a[rel=next]");
  if (relNext && pagers.length === 0) add("pagination", relNext, { links: [{ text: text(relNext, 20), href: relNext.href }] });
  document.querySelectorAll("[role=slider], [role=switch], input[type=range]").forEach((o) => add("other", o, { role: implicitRole(o) }));

  // ---------------------------------------------------------------- text for injection detection / evidence
  const visibleText = clean(document.body ? document.body.innerText : "", MAX.text);
  const hiddenParts = [];
  document.querySelectorAll("body *").forEach((el) => {
    if (hiddenParts.join(" ").length > MAX.hidden) return;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"].includes(el.tagName)) return;
    if (el.children.length > 0) return;
    const t = clean(el.textContent, 400);
    if (t && !visible(el)) hiddenParts.push(t);
  });
  const metaRobots = document.querySelector("meta[name=robots]");
  const bodyLower = (document.body ? document.body.innerHTML : "").slice(0, 200000).toLowerCase();
  return {
    title: clean(document.title, 300),
    lang: document.documentElement.getAttribute("lang"),
    meta_robots: metaRobots ? metaRobots.getAttribute("content") : null,
    links,
    nav_links: navLinks,
    headings,
    forms,
    components: comps,
    has_password: Boolean(document.querySelector("input[type=password]")),
    text: visibleText,
    hidden_text: clean(hiddenParts.join(" • "), MAX.hidden),
    captcha: /g-recaptcha|h-captcha|hcaptcha|cf-turnstile|challenge-platform|captcha/.test(bodyLower),
    counts: {
      links: allLinks.length,
      inputs: document.querySelectorAll("input:not([type=hidden]), select, textarea").length,
      images: document.images.length,
      iframes: document.querySelectorAll("iframe").length,
    },
  };
})()
