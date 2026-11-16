# StallFlow design connector for ChatGPT

ChatGPT gets to read a stall's **brand kit** (name, colours, label look, order links), its
**products and prices**, and can save **one design note**. It uses that to make posts,
posters, labels and price lists. It cannot see cost prices, money, orders or customers, and it
cannot change stock, prices or anything else. That is enforced by the stall
(`SF.DESIGN_TOOLS` in `server/Support.gs`), not by this relay.

```
ChatGPT ──OAuth──▶ this Worker ──Google sign-in──▶ only ALLOWED_EMAILS get in
        ──/mcp───▶ this Worker ──?design=STALL_KEY──▶ the stall's Apps Script
```

ChatGPT never holds the stall key: it holds a token this Worker issued after Google said who
you are. Taking an email off `ALLOWED_EMAILS` stops that account on its next call. Switching
the key off in the app stops everything at once.

## What your ChatGPT plan allows

As of November 2026 OpenAI's own documents disagree. The developer guide says developer mode
gives Plus and Pro read **and** write tools. The help centre says Pro users get read/fetch
only, and write actions are for Business, Enterprise and Edu. All the reading here works on
Pro either way. `save_design_note` is the only write tool, and it is harmless, so it doubles as
the test: if ChatGPT can save a note (it shows in StallFlow › Settings › ChatGPT for artwork),
your plan allows writes and Phase 2 (colours, label logo, poster art) is worth building.

## Setting it up (about 30 minutes, R0)

1. **Make the stall key.** In the staff app, signed in as the StallFlow administrator:
   More › Settings › **ChatGPT for artwork** › Switch on and make the key. Copy it. It is shown
   once. This also records the order page address, so open the app from its real address.
2. **Google sign-in client.** In Google Cloud (project "Stallflow Stalls", as the StallFlow
   account) › APIs & Services › Credentials, open the existing **Web application** OAuth client
   (its ID is in `server/Platform.gs`). Under *Authorised redirect URIs* add
   `https://<your worker>.workers.dev/callback`. Copy its client secret (make one if it has
   none). Only the `openid` and `email` scopes are used, so Google needs no app review.
3. **Cloudflare** (free plan), the same account as the Claude relay:
   - Workers & Pages › KV › Create a namespace `stallflow-chatgpt-oauth`.
   - Create a Worker `stallflow-chatgpt-duxies`. Either paste `dist/worker.js` in the dashboard
     editor, or run `npm install && npx wrangler deploy` here after putting the KV id in
     `wrangler.jsonc`.
   - Settings › Bindings: KV namespace, variable name `OAUTH_KV`.
   - Settings › Variables: `STALL_API`, `ALLOWED_EMAILS`, `GOOGLE_CLIENT_ID` as in
     `wrangler.jsonc`; **secrets** `GOOGLE_CLIENT_SECRET` and `STALL_KEY` (step 1).
   - Settings › Compatibility flags: add `global_fetch_strictly_public`.
   - Open `https://<your worker>.workers.dev/`: it should say "StallFlow design connector".
4. **ChatGPT** (web): Settings › Apps (or Connectors) › Advanced › turn on **Developer mode** ›
   Create. Name `StallFlow – Duxie's`, URL `https://<your worker>.workers.dev/mcp`,
   authentication **OAuth**. Allow, then sign in with an allowed Google account.
5. **Test.** In a chat with the app switched on: *"Use StallFlow: read the brand kit and the
   products, then save a design note saying 'ChatGPT connected'."* Check the note under
   Settings › ChatGPT for artwork.

## Changing it

- Edit `worker.js`, run `npm test` (Miniflare: the full sign-in against pretend Google and
  Apps Script), then `npm run bundle` and commit `dist/worker.js` with it.
- A new tool goes in `SF.DESIGN_TOOLS` with a test in `tests/server.test.js`. Keep it to what a
  designer needs; never cost prices, money, orders, customers or people.
- One Worker per stall (each has its own `STALL_API` and `STALL_KEY`).
