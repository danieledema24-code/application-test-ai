// A tiny "application under test" for demos and end-to-end checks of the platform.
// Run with `npm start` (port 4100, or DEMO_PORT). Moved out of the retired Node API in P4-15 (plain Node, no
// dependencies). Contains deliberate bugs (README "Deliberate bugs"):
//   1. The contact form accepts an empty message (no required validation on "message").
//   2. GET /api/products/{id} returns `price` as a string instead of a number.
//   Phase 5 (P5-00), chosen so discovery, test design and the Phase 4 failing set stay the same (no new forms,
//   fields, links or navigation):
//   3. Accessibility: product pages show an image without `alt`, and the stock line is #9ca3af on white (~2.5:1).
//   4. Security: every response sends `X-Powered-By` with a version; product pages set a `recently_viewed` cookie
//      without HttpOnly or SameSite. (No CSP, nosniff, frame or referrer headers, as before.)
//   5. Performance: GET /products/2 (Desk lamp) is serialised behind one in-process lock (see `lampLookup`).
// Release 2 (P6-00, README "Release 2 (Phase 6)") is served when DEMO_VERSION=2, or when the file named by
// DEMO_VERSION_FILE (read on every request) says 2. Release 1 (the default) is byte-for-byte the Phase 5 shop.
import fs from "node:fs";
import http from "node:http";
import { DEMO_API_TOKEN, DEMO_LOGIN } from "./demo-login.mjs";

const PORT = Number(process.env.DEMO_PORT ?? 4100);
const DEMO_VERSION = process.env.DEMO_VERSION === "2" ? 2 : 1;
// Set by the operator; never served (no route reads it). Lets tests flip releases without a restart.
const VERSION_FILE = process.env.DEMO_VERSION_FILE;
// P6-03a: if set, one line "METHOD /path?query STATUS" per request is appended to this file (never served; no bodies,
// headers or cookies). Exploration checks read it to prove that only GET/HEAD requests reached the shop.
const ACCESS_LOG = process.env.DEMO_ACCESS_LOG;
/** The release to serve for this request: the version file's content if it is readable and 1 or 2, else DEMO_VERSION. */
function currentRelease() {
  if (VERSION_FILE) {
    try {
      const v = fs.readFileSync(VERSION_FILE, "utf8").trim();
      if (v === "1" || v === "2") return Number(v);
    } catch {
      // unreadable or missing: fall back to DEMO_VERSION
    }
  }
  return DEMO_VERSION;
}
// The release of the request being handled. Pages are rendered synchronously inside the request handler, so `page()`
// can read it without being passed it.
let release = 1;
// Bug 5: the Desk lamp page's "stock lookup" holds one shared lock for DEMO_SLOW_MS, plus half that for every other
// request made to the page in the last 5 seconds (at most 20 counted). Alone it answers in about DEMO_SLOW_MS; with
// ten users browsing the shop the requests queue behind each other and its p95 rises well above 800 ms, while the
// other pages stay fast.
const SLOW_MS = Number(process.env.DEMO_SLOW_MS ?? 150);
const SLOW_WINDOW_MS = 5000;
const POWERED_BY = "DemoShop/0.9 (Node 22)";
const USER = DEMO_LOGIN;
const TOKEN = DEMO_API_TOKEN;
const products = [
  { id: 1, name: "Travel mug", price: 12.5, stock: 40 },
  { id: 2, name: "Desk lamp", price: 34, stock: 8 },
];

// A plain product picture as an inline SVG (no extra route).
const picture = (p) =>
  "data:image/svg+xml," +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#e5e7eb"/><text x="80" y="66" font-size="14" text-anchor="middle" fill="#374151">${p.name}</text></svg>`);

let lampQueue = Promise.resolve();
/** @type {number[]} */
let lampRecent = [];
/** Bug 5: serialised, and slower the busier the page is. Resolves when this request's turn is over. */
function lampLookup() {
  const now = Date.now();
  lampRecent = lampRecent.filter((t) => now - t < SLOW_WINDOW_MS);
  lampRecent.push(now);
  const hold = SLOW_MS * (1 + (Math.min(lampRecent.length, 20) - 1) / 2);
  const turn = lampQueue.then(() => new Promise((r) => setTimeout(r, hold)));
  lampQueue = turn;
  return turn;
}

// Release 2: the nav gains "Offers".
const offersLink = () => (release === 2 ? `<a href="/offers">Offers</a>` : "");
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} · DemoShop</title>
<style>body{font-family:system-ui;margin:0}nav{background:#0b1b3a;padding:12px 24px}nav a{color:#fff;margin-right:16px}main{padding:24px;max-width:640px}
label{display:block;margin-top:12px}input,textarea{display:block;width:100%;padding:8px;margin-top:4px}.error{color:#b91c1c}.ok{color:#15803d}.stock{color:#9ca3af}button{margin-top:16px;padding:8px 16px}</style></head>
<body><nav><a href="/">Home</a><a href="/products">Products</a>${offersLink()}<a href="/contact">Contact</a><a href="/login">Sign in</a></nav><main>${body}</main></body></html>`;

/** @type {Record<string, (req: http.IncomingMessage, body: string, url: URL) => [number, string, string]>} */
const routes = {
  "GET /": () => [200, "text/html", page("Home", `<h1>Welcome to DemoShop</h1><p>Everyday products for your desk.</p><a href="/products">Browse products</a>`)],
  "GET /products": () => [200, "text/html", page("Products", `<h1>Products</h1><ul>${products.map((p) => `<li><a href="/products/${p.id}">${p.name}</a> — £${p.price}</li>`).join("")}</ul>`)],
  "GET /contact": () => [200, "text/html", page("Contact", `<h1>Contact us</h1><form method="post" action="/contact">
    <label for="name">Name</label><input id="name" name="name" required>
    <label for="email">Email</label><input id="email" name="email" type="email" required>
    <label for="message">Message</label><textarea id="message" name="message"></textarea>
    <button type="submit">Send message</button></form>`)],
  "POST /contact": (_r, body) => {
    const f = new URLSearchParams(body);
    if (!f.get("name") || !f.get("email")) return [400, "text/html", page("Contact", `<h1>Contact us</h1><p class="error">Name and email are required</p>`)];
    return [200, "text/html", page("Contact", `<h1>Thank you</h1><p class="ok">Message sent</p>`)];
  },
  "GET /login": () => [200, "text/html", page("Sign in", `<h1>Sign in</h1><form method="post" action="/login">
    <label for="email">Email</label><input id="email" name="email" type="email" required>
    <label for="password">Password</label><input id="password" name="password" type="password" required>
    <button type="submit">Sign in</button></form>`)],
  "POST /login": (_r, body) => {
    const f = new URLSearchParams(body);
    if (f.get("email") === USER.email && f.get("password") === USER.password)
      return [200, "text/html", page("Account", `<h1>My account</h1><p class="ok">Signed in as ${USER.email}</p><a href="/">Home</a>`)];
    return [401, "text/html", page("Sign in", `<h1>Sign in</h1><p class="error">Invalid email or password</p><a href="/login">Try again</a>`)];
  },
  "GET /api/products": (req) => auth(req) ?? [200, "application/json", JSON.stringify(products)],
  "POST /api/products": (req, body) => {
    const denied = auth(req);
    if (denied) return denied;
    let p;
    try { p = JSON.parse(body); } catch { return [400, "application/json", JSON.stringify({ error: "Malformed JSON" })]; }
    if (typeof p.name !== "string" || !p.name) return [400, "application/json", JSON.stringify({ error: "name is required" })];
    if (typeof p.price !== "number" || p.price < 0 || p.price > 10000) return [400, "application/json", JSON.stringify({ error: "price must be a number 0-10000" })];
    const created = { id: products.length + 1, name: p.name, price: p.price, stock: 0 };
    return [201, "application/json", JSON.stringify(created)];
  },
  "GET /openapi.json": () => [200, "application/json", JSON.stringify(openapi)],
};

/** Release 2's Contact form; with `nameError`, Name is flagged (`aria-invalid`) and the error is shown above it. */
const contactV2 = (nameError) => `<h1>Contact us</h1>${nameError ? `<p class="error" role="alert">${nameError}</p>` : ""}<form method="post" action="/contact">
    <label for="name">Name</label><input id="name" name="name" required${nameError ? ' aria-invalid="true"' : ""}>
    <label for="email">Email</label><input id="email" name="email" type="email" required>
    <label for="message">Your message</label><textarea id="message" name="message" required></textarea>
    <label for="order">Order number</label><input id="order" name="order" maxlength="20">
    <button type="submit">Send</button></form>`;

/** Release 2 (README "Release 2 (Phase 6)"): routes that differ from release 1. Every other route is release 1's. */
/** @type {Record<string, (req: http.IncomingMessage, body: string, url: URL) => [number, string, string]>} */
const routesV2 = {
  // 3. The Travel mug is gone.
  "GET /products": () => [200, "text/html", page("Products", `<h1>Products</h1><ul>${products.filter((p) => p.id !== 1).map((p) => `<li><a href="/products/${p.id}">${p.name}</a> — £${p.price}</li>`).join("")}</ul>`)],
  // 4. "Your message" (same id and name) is required, an optional Order number is new, and the button says "Send".
  "GET /contact": () => [200, "text/html", page("Contact", contactV2())],
  "POST /contact": (_r, body) => {
    const f = new URLSearchParams(body);
    // 4. A Name of only spaces counts as empty (release 1 accepts it: DEF-0002 in the demo chain, fixed here). The
    // form is shown again with Name flagged and the error, so the submission is visibly blocked.
    if (f.get("name") && !f.get("name").trim()) return [400, "text/html", page("Contact", contactV2("Name is required"))];
    if (!f.get("name") || !f.get("email") || !f.get("message")) return [400, "text/html", page("Contact", `<h1>Contact us</h1><p class="error">Name, email and message are required</p>`)];
    return [200, "text/html", page("Contact", `<h1>Thank you</h1><p class="ok">Message sent</p>`)];
  },
  // 2. Offers. "Show details" writes "Bundle price: £NaN" and then throws a TypeError (reads `price` of undefined);
  // "Add to basket" tries POST /basket; "Apply code" submits the Promo code form.
  "GET /offers": () => [200, "text/html", page("Offers", `<h1>Offers</h1><section><h2>Desk lamp bundle</h2><p>The desk lamp with a spare bulb.</p>
    <button type="button" onclick="var offer;document.getElementById('bundle').textContent='Bundle price: £'+Number(offer);offer.price.toFixed(2)">Show details</button>
    <p id="bundle"></p>
    <button type="button" onclick="fetch('/basket', {method: 'POST'})">Add to basket</button></section>
    <form method="post" action="/offers/apply"><label for="code">Promo code</label><input id="code" name="code">
    <button type="submit">Apply code</button></form>`)],
  "POST /offers/apply": () => [200, "text/html", page("Offers", `<h1>Offers</h1><p class="error">This promo code is not valid</p><a href="/offers">Back to offers</a>`)],
  "POST /basket": () => [200, "application/json", JSON.stringify({ items: 1 })],
};

/** @returns {[number, string, string] | null} */
function auth(req) {
  return req.headers.authorization === `Bearer ${TOKEN}` ? null : [401, "application/json", JSON.stringify({ error: "Unauthorized" })];
}

const openapi = {
  openapi: "3.0.3",
  info: { title: "DemoShop API", version: "1.0.0" },
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    schemas: {
      Product: { type: "object", required: ["id", "name", "price"], properties: { id: { type: "integer" }, name: { type: "string" }, price: { type: "number" }, stock: { type: "integer" } } },
      NewProduct: { type: "object", required: ["name", "price"], properties: { name: { type: "string", maxLength: 80, example: "Notebook" }, price: { type: "number", minimum: 0, maximum: 10000, example: 4.99 } } },
    },
  },
  security: [{ bearer: [] }],
  paths: {
    "/api/products": {
      get: { summary: "List products", responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Product" } } } } } } },
      post: { summary: "Create product", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NewProduct" } } } }, responses: { "201": { description: "created", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } } } },
    },
    "/api/products/{id}": {
      get: { summary: "Get product", parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", example: 1 } }], responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } } } },
    },
  },
};

http.createServer((req, res) => {
  if (ACCESS_LOG) res.on("finish", () => fs.appendFile(ACCESS_LOG, `${req.method} ${req.url} ${res.statusCode}\n`, () => {}));
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    release = currentRelease();
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const m = url.pathname.match(/^\/(api\/)?products\/(\d+)$/);
    let out;
    /** @type {Record<string, string>} */
    const headers = { "x-powered-by": POWERED_BY }; // bug 4
    if (m && req.method === "GET") {
      const p = products.find((x) => x.id === Number(m[2]) && !(release === 2 && !m[1] && x.id === 1)); // v2: no Travel mug page
      if (m[1]) out = auth(req) ?? (p ? [200, "application/json", JSON.stringify({ ...p, price: String(p.price) })] : [404, "application/json", '{"error":"Not found"}']);
      else if (p) {
        // Bugs 3 and 4: no alt on the picture, a low-contrast stock line, a cookie without HttpOnly/SameSite.
        out = [200, "text/html", page(p.name, `<h1>${p.name}</h1><img src="${picture(p)}" width="160" height="120"><p>Price: £${p.price}</p><p class="stock">${p.stock} in stock</p><button>Add to basket</button>`)];
        headers["set-cookie"] = `recently_viewed=${p.id}; Path=/`;
        if (p.id === 2) return void lampLookup().then(() => res.writeHead(out[0], { ...headers, "content-type": out[1] }).end(out[2]));
      } else out = [404, "text/html", page("Not found", "<h1>Not found</h1>")];
    } else {
      const key = `${req.method} ${url.pathname}`;
      const handler = (release === 2 ? routesV2[key] : undefined) ?? routes[key];
      out = handler?.(req, body, url) ?? [404, "text/html", page("Not found", "<h1>Page not found</h1>")];
    }
    res.writeHead(out[0], { ...headers, "content-type": out[1] }).end(out[2]);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`DemoShop target app on http://localhost:${PORT}`)); // never log the demo login or token
