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
import http from "node:http";
import { DEMO_API_TOKEN, DEMO_LOGIN } from "./demo-login.mjs";

const PORT = Number(process.env.DEMO_PORT ?? 4100);
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

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} · DemoShop</title>
<style>body{font-family:system-ui;margin:0}nav{background:#0b1b3a;padding:12px 24px}nav a{color:#fff;margin-right:16px}main{padding:24px;max-width:640px}
label{display:block;margin-top:12px}input,textarea{display:block;width:100%;padding:8px;margin-top:4px}.error{color:#b91c1c}.ok{color:#15803d}.stock{color:#9ca3af}button{margin-top:16px;padding:8px 16px}</style></head>
<body><nav><a href="/">Home</a><a href="/products">Products</a><a href="/contact">Contact</a><a href="/login">Sign in</a></nav><main>${body}</main></body></html>`;

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
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const m = url.pathname.match(/^\/(api\/)?products\/(\d+)$/);
    let out;
    /** @type {Record<string, string>} */
    const headers = { "x-powered-by": POWERED_BY }; // bug 4
    if (m && req.method === "GET") {
      const p = products.find((x) => x.id === Number(m[2]));
      if (m[1]) out = auth(req) ?? (p ? [200, "application/json", JSON.stringify({ ...p, price: String(p.price) })] : [404, "application/json", '{"error":"Not found"}']);
      else if (p) {
        // Bugs 3 and 4: no alt on the picture, a low-contrast stock line, a cookie without HttpOnly/SameSite.
        out = [200, "text/html", page(p.name, `<h1>${p.name}</h1><img src="${picture(p)}" width="160" height="120"><p>Price: £${p.price}</p><p class="stock">${p.stock} in stock</p><button>Add to basket</button>`)];
        headers["set-cookie"] = `recently_viewed=${p.id}; Path=/`;
        if (p.id === 2) return void lampLookup().then(() => res.writeHead(out[0], { ...headers, "content-type": out[1] }).end(out[2]));
      } else out = [404, "text/html", page("Not found", "<h1>Not found</h1>")];
    } else out = routes[`${req.method} ${url.pathname}`]?.(req, body, url) ?? [404, "text/html", page("Not found", "<h1>Page not found</h1>")];
    res.writeHead(out[0], { ...headers, "content-type": out[1] }).end(out[2]);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`DemoShop target app on http://localhost:${PORT}`)); // never log the demo login or token
