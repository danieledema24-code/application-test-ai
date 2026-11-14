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

`POST /login` returns the account page without a session cookie, so signed-in state does not persist.

The test login and API token live in `demo-login.mjs`. Tests read them from there or from `DEMO_LOGIN_USER` /
`DEMO_LOGIN_PASSWORD`; docs never copy them.
