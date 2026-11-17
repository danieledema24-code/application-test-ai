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

## Release 2 (Phase 6)

P6-00 adds a second release of the shop for change detection, impact analysis, healing and exploratory testing. The
release comes from `DEMO_VERSION` (default `1`). If `DEMO_VERSION_FILE` is set, that file is read on every request
and its content (`1` or `2`) wins, so a release can be flipped without restarting; a missing or unreadable file falls
back to `DEMO_VERSION`. The file is set by whoever starts the shop and is never served.

```sh
DEMO_VERSION=2 npm start                          # release 2
DEMO_VERSION_FILE=/tmp/demo-version npm start     # echo 2 > /tmp/demo-version flips the next request to release 2
```

Release 1 is byte-for-byte the Phase 5 shop (checked route by route against a snapshot in
`backend/tests/fixtures/demo_shop_v1_snapshot.json`). Release 2 changes:

1. The nav gains "Offers" (`/offers`), between Products and Contact.
2. `/offers` has the heading "Offers" and one offer, "Desk lamp bundle", with:
   - `<button type="button">Show details</button>`: its inline handler writes "Bundle price: £NaN" and then throws a
     `TypeError` (it reads a property of `undefined`);
   - `<button type="button">Add to basket</button>`: its handler calls `fetch('/basket', {method: 'POST'})`;
   - a "Promo code" form (one text field, submit "Apply code", `POST /offers/apply`, which says the code is not
     valid).
3. `/products/1` (Travel mug) returns 404 and is gone from `/products`. The bearer-token API is unchanged.
4. The Contact form: the label "Message" becomes "Your message" (same `id`/`name`) and the textarea is `required`;
   `POST /contact` rejects an empty message with 400 "Name, email and message are required"; a Name that is empty
   after trimming gets 400 with the form shown again, Name flagged (`aria-invalid`) and "Name is required" (release 1
   accepts a Name of only spaces: the demo chain's DEF-0002, fixed in release 2); a new optional field
   "Order number" (`maxlength=20`); the button "Send message" becomes "Send". The confirmation ("Thank you" /
   "Message sent") is unchanged.
5. Everything else is as in release 1, Phase 5 flaws included.

### Exploratory testing (P6-03a)

Release 2's `/offers` is what the safe explorer finds on the demo (AI off, charter "New and changed pages from
CHG-0001"): clicking "Show details" gives an uncaught `TypeError` and "Bundle price: £NaN" (two medium findings, one
grouped defect draft), clicking "Add to basket" makes the page try `POST /basket`, which the explorer blocks before it
leaves the browser ("Blocked write attempts"), and "Apply code" submits the Promo code form, so it is never clicked
("Not tried: Submits a form").

To check what reached the shop, set `DEMO_ACCESS_LOG` to a file path: one line `METHOD /path?query STATUS` is
appended per request (no bodies, headers or cookies; the file is never served, and responses are unchanged). After an
exploratory session the log holds only `GET` (and `HEAD`) lines.

```sh
DEMO_VERSION=2 DEMO_ACCESS_LOG=/tmp/demo-access.log npm start
```

The test login and API token live in `demo-login.mjs`. Tests read them from there or from `DEMO_LOGIN_USER` /
`DEMO_LOGIN_PASSWORD`; docs never copy them.
