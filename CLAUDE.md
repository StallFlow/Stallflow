# StallFlow

Pre-orders, an offline-first till, stock and market numbers for market stalls.
One codebase serves every stall. Each stall's data lives in its own Google
Sheet, owned by the StallFlow Google account and shared with the stall owner.

## How it fits together

```
web/                 the front end, one copy for every stall
  index.html         customer order page            → /<slug>/
  app/               staff app (PWA, works offline)  → /<slug>/app/
  core/ plugins/     shared scripts and styles
  landing.html       stallflow.github.io/Stallflow/
server/              Apps Script, identical in every stall's sheet
  Core.gs            sheets, settings, identity, audit, plugin host, router, migrations
  Domain.gs          catalogue, stock, orders, costing, markets, dashboard
  People.gs          Google sign-in, the Users tab, the People screen's actions
  Platform.gs        Google client ID and StallFlow admins, same for every stall
  Plugins.gs         presets, scale/kitchen/cash-up plugins, the sheet menu
  appsscript.json    manifest (web app: execute as owner, anyone can call)
stalls/<slug>/       one folder per stall
  stall.json         name, api (web app /exec URL), scriptId, deploymentId
  Tenant.gs          seed data for that stall (StallFlow › Load this stall)
scripts/build-site.sh  builds _site/<slug>/ for every stall
.github/workflows/
  pages.yml          builds and publishes the site on every push to main
  server.yml         pushes server/ + stalls/<slug>/*.gs into each stall's
                     Apps Script and moves its live deployment (needs the
                     CLASPRC_JSON secret)
```

Request flow: the phone calls the stall's Apps Script `/exec` URL with
`?action=…` (GET) or a `text/plain` JSON body (POST; `application/json`
would trigger a CORS preflight Apps Script cannot answer). `SF.dispatch` in
Core.gs checks the signed token against the action's capability, and writes
go through `SF.once` so a retried request never runs twice.

## Sign-in

- Until `SF.PLATFORM` has both a `googleClientId` and at least one admin
  (`SF.googleOn()`), a stall uses role PINs.
- Once both are set, Google is the only way in: PIN sign-in is refused and old
  PIN tokens stop working. The phone sends Google's ID token to
  `signInGoogle`; the server checks it with Google and issues its own token
  carrying the email.
- On every request `SF.dispatch` looks the email up again (`SF.roleOf`), so
  role changes and switch-offs apply on the person's next tap.
- `SF.PLATFORM.admins` are owner on every stall and cannot be changed from a
  stall. Everyone else is a row in the stall's `Users` tab.
- Any email that has a Google account works; it does not have to be Gmail.

## Rules that are easy to break

- **Every stall shares the origin `stallflow.github.io`**, and so does the
  older `StallFlow/duxies` site. localStorage keys go through `SF.ls`, which
  prefixes them with the stall slug. Never call `localStorage` directly.
  Service-worker caches are named after their scope and only delete their own.
- **Do not touch `StallFlow/duxies`.** It is the original single-stall site and
  still live. This repo replaces it stall by stall.
- **Sheets carry real trading data.** Any change to `SF.SHEETS` needs a
  migration in `SF.MIGRATIONS` and a bump of `SF.SCHEMA`.
- **Money and stock are ledgers.** Stock on hand is the sum of `Movements`;
  never write a stock count directly.
- **Never write a customer's phone number into the audit trail.**
- Server code is plain Apps Script (V8, no modules). Every `.gs` shares one
  global scope; plugins register themselves with `SF.definePlugin`.

## Checking a stall from a session

The public `catalogue` action needs no sign-in and shows what customers see:

```
<api>?action=catalogue
```

Look at `open` (pre-orders), `market.date` (is the live market in the past?),
and `products[].available` (is anything actually in stock?). The `health`
action needs an owner or manager token.

## Before pushing

```
for f in web/core/*.js web/plugins/*.js web/app/sw.js; do node --check "$f"; done
for f in server/*.gs stalls/*/*.gs; do cp "$f" /tmp/c.js && node --check /tmp/c.js; done
node tests/server.test.js      # runs the real server code against a fake sheet
scripts/build-site.sh
```

Then serve `_site/` and open `/<slug>/app/` in a browser.
