# StallFlow

**Start with `docs/status.md`**: what is live, which accounts own what, and what is next.

Pre-orders, an offline-first till, stock and market numbers for market stalls.
One codebase serves every stall. Each stall's data lives in its own Google
Sheet, owned by the StallFlow Google account and shared with the stall owner.

## How it fits together

```
web/                 the front end, one copy for every stall
  index.html         customer order page            → /<slug>/
  app/               staff app (PWA, works offline)  → /<slug>/app/
  core/ plugins/     shared scripts and styles (core/places.js: Google place
                     suggestions for Where boxes; off without a mapsKey.
                     core/filters.js: search/filter/sort bars for long lists,
                     SF.filters.bar + .row + .th (sortable headings); filters
                     rows in place. core/labelimg.js: labels as 300 dpi PNGs
                     and a .zip, for separate label printers. core/scan.js:
                     the till scanner; BarcodeDetector where the phone has
                     it, else core/vendor/jsQR.js — jsqr 1.4.0 from npm,
                     unchanged, Apache-2.0 — which is how iPhones scan)
  landing.html       stallflow.github.io/Stallflow/
  guide/             How-to videos (More › How-to videos, core/guide.js): one
                     captioned MP4 + poster per chapter, made by tools/guide/.
                     Never cached by the service worker (played from the network)
tools/guide/         remakes the videos: guide.js drives the real app on an
                     iPhone screen with demo data, make_video.py adds captions.
                     Run both after changing a screen the videos show
server/              Apps Script, identical in every stall's sheet
  Core.gs            sheets, settings, identity, audit, plugin host, router, migrations
  Domain.gs          catalogue, stock, orders, costing, markets, dashboard
  People.gs          Google sign-in, the Users tab, the People screen's actions
  Platform.gs        Google client ID and StallFlow admins, same for every stall
  Plugins.gs         presets, scale/kitchen/cash-up plugins, the sheet menu
  appsscript.json    manifest (web app: execute as owner, anyone can call)
stalls/platform.json  settings shared by every stall: mapsKey (Google Maps
                     browser key, public by design, referrer-restricted)
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

Request flow: the staff app sends every request, reads included, as a
`text/plain` JSON POST to the stall's Apps Script `/exec` URL, so tokens never
appear in a URL (`application/json` would trigger a CORS preflight Apps Script
cannot answer). Only the public order page uses GET (`?action=catalogue`). `SF.dispatch` in
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
- **Write to the sheet only through `SF.append` / `SF.setCell`.** They pass
  values through `SF.safe`, which stops text starting with `= + - @` being run
  as a formula. Writing with `getRange().setValue()` directly skips that.
- **Every market has its own order page**: `/<slug>/?m=<MarketId>`, and
  `?m=home` for orders between markets (`SF.HOME`). The plain `/<slug>/`
  is the live market, so QR codes printed before this still work; when that
  market is closed the page lists the markets that are open instead.
  `SF.takesOrders(m)` decides: pre-orders switched on, and the market not
  past (between markets: the `homeOrders` setting). Orders, made-to-order
  capacity, stock moves and the Collect queue all follow the market the order
  is for, never just the live one.
- **Public order protections:** at most `SF.MAX_OPEN_PER_PHONE` unpaid orders
  per phone per market; customer details of finished markets are wiped by
  `SF.purgeCustomers` (daily on first `boot`, and when a new market is made
  live). Between-markets orders have no market day, so their details are kept
  until the order is handed over or cancelled, and wiped then.
- **Collect is off unless a stall switches it on** (`collectStep`, Settings).
  Off, `markPaid` also hands the order over (status `collected`) and the
  Collect tab is hidden; the till's Still to pay shows the items and takes the
  money through the same notes-and-change sheet as a walk-up sale.
- **Stocktake** (`stockcounts`, `countlines`; Stock › Stocktake and More ›
  Stocktake): an owner or manager starts it and the stock on hand is kept as
  the snapshot; anyone with the `count` capability counts a location (scan
  or − / +; the draft stays on the phone until Done); each Done is a new
  submission and the latest per location counts. Only the owner approves: the
  difference goes into Movements as `stocktake` lines and the loss is kept at
  cost in the stocktake's Result. Counts are never edited, only appended.
- **Who may change things:** anything that changes how the stall runs
  (markets, pre-orders on/off, Collect, plugins, label look, profile, PINs,
  release unpaid, reset) needs the `settings` capability: owner and manager
  only. `reports` is read access (the viewer role has it). Never give a write
  action `reports` alone.
- **Text from people is never markup or code:** escape with `esc()` in HTML;
  pass values to onclick handlers through `data-*` attributes and
  `this.getAttribute(...)`, never inside a quoted JS string (HTML-escaping does
  not protect a JS string: the browser decodes `&#39;` back to `'` first).
  Market dates must be `yyyy-mm-dd`; shop words go through `SF.cleanWord`;
  colours through `SF.cleanColour`; any raw `setValues` passes cells through
  `SF.safe`.
- **Global names are taken**: SFC is the cash-up plugin, SFK the kitchen
  plugin, SFCount the stocktake. A test checks none overwrites another.
- **Sales between markets** go under the market id `SF.HOME` ('HOME'), a
  virtual market `SF.markets()` adds; it is not a row in Markets.
- **How each order was paid** is the `Paid` column of Orders (schema 10):
  `cash`, `card` or `eft`, through `SF.payMethod`; blank (older orders) is
  cash. The cash-up expects only cash (plus the float) in the tin; Numbers
  splits takings by method.
- **Receipts** go out through WhatsApp from the phone (`wa.me` link). The
  customer's number is typed for that one message and never sent to the
  server or kept on the phone.
- **Backups** (`SF.backup`, weekly via `autoBackup` from an owner's or
  manager's phone, or Health › Back up now, or the sheet menu) copy every tab
  as plain values into a new spreadsheet in the StallFlow Drive, with
  customers' names and phone numbers left out. Only the spreadsheets
  permission is used: adding another Google service (Drive, triggers)
  would need the owner to re-authorise before the live app works again.
- **Updates must never cost a sale.** A sale lives in the phone's outbox
  (`sf.outbox`) until the server answers `ok`. Only an explicit `ok: true`
  removes it; an unreadable reply (error page, lost connection), a busy server
  (`retry: true`, from `SF.lock`) and an `Unknown action` from a server that
  has not updated yet all keep it queued and retried. Every write carries an
  `opId`, so sending one twice (the first reply was lost) sells once. Only a
  real refusal (`ok: false` without `retry`) moves it to "Did not go through".
  Never turn a "nothing ran" answer into a failure, and never `retry: true` an
  answer after something already ran.
- **Google sign-in problems** (`authError`, public) log only a fixed stage and
  code from allowlists (`SF.AUTH_STAGES`, `SF.AUTH_CODES`), at most 40 an hour;
  never a token, an email or free text. Health shows the recent ones.
- **The staff app is not locked to portrait** (manifest `orientation: any`);
  short landscape screens have their own rules at the end of components.css.
- **Several markets can trade on the same day.** Each phone sells at the market
  it chose (`sf.sellAt`); the top bar and the "You are selling at" banner
  (`SF.sellingAt()`) name it, amber when it is not today's. The till's
  `running` list feeds the "Markets today" card (Start / Switch). Keep every
  sale, pre-order and number filed under its own market.
- **One-off fixes to a stall's own data** live in `stalls/<slug>/Fixes.gs`
  (`sfDataFixes()`), run once by `SF.runDataFixes` on the first `boot` after an
  update. A fix changes only what is still exactly as it was (a hand edit
  wins) and a failing one never stops the app.
- **Uncooked stock** (the `Pantry` tab) is a plain count list, not a ledger:
  nothing is sold from it, so `savePantry` overwrites the amount.
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
node tests/browser.test.js     # the real app in a browser against that server (needs Playwright)
SF_DEVICE='iPhone SE' node tests/browser.test.js   # the same, on a phone's screen and touch
scripts/build-site.sh
```

Then serve `_site/` and open `/<slug>/app/` in a browser.
