# DemoShop

The small application under test used for demos and end-to-end checks of the platform. Plain Node 22, no dependencies.

```sh
cd demo-shop
npm start            # http://localhost:4100 (set DEMO_PORT to change it)
```

Pages: home, products and two product pages, a contact form and a sign-in form. A small bearer-token API
(`/api/products`, `/openapi.json`) is kept for the deferred API testing story (P5-06).

Deliberate bugs:
1. The contact form accepts an empty Message (no `required` on the field). The Phase 4 journey catches it.
2. `GET /api/products/{id}` returns `price` as a string instead of a number.

Phase 5 flaws (P5-00), one or more per non-functional testing type. They add no forms, fields, links or navigation
items, so Phase 1–4 discovery, test design and the Phase 4 failing set are unchanged:

3. Accessibility: each product page shows a product picture (inline SVG, no extra route) **without `alt`**, and its
   "N in stock" line is `#9ca3af` on white (about 2.5:1).
4. Security: every response sends `X-Powered-By: DemoShop/0.9 (Node 22)`, and product pages set
   `recently_viewed=<id>; Path=/` without `HttpOnly` or `SameSite`. The shop sends no Content-Security-Policy,
   `X-Content-Type-Options`, `X-Frame-Options` or `Referrer-Policy` headers (as before). `POST /login` still sets no
   cookie.
5. Performance: `GET /products/2` (Desk lamp) is serialised behind one in-process lock, held for `DEMO_SLOW_MS`
   (default 150) plus half that for every other request to the page in the last 5 seconds (at most 20 counted).
   Alone it answers in about 150 ms; under the default load profile (10 users) the requests queue and its p95
   rises well above 800 ms while the other pages stay fast.

`POST /login` returns the account page without a session cookie, so signed-in state does not persist.

The test login and API token live in `demo-login.mjs`. Tests read them from there or from `DEMO_LOGIN_USER` /
`DEMO_LOGIN_PASSWORD`; docs never copy them.
