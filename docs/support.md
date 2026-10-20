# Support guide

## Something is wrong at a stall

1. **Check what customers see.** Open `<api>?action=catalogue` (the `api` is in
   `stalls/<slug>/stall.json`).
   - `open: true` but `market.date` is in the past → the owner needs to add the
     next market and make it live, or close pre-orders.
   - Everything `available: 0` → stock was never loaded or has sold out.
2. **Ask the owner for a Health check:** staff app › More › Health check. It
   lists schema problems, duplicate products and negative stock.
3. **Look in the sheet.** The `Audit` tab records every change, refusal and
   server error, newest at the bottom. Rows with Outcome `error` are crashes.
4. **Sales stuck on a phone:** staff app › More › Did not go through. They send
   once the phone has signal and somebody is signed in.

## Shipping a fix

Change the code here and push to `main`:

- Front end (`web/`): the Pages workflow republishes every stall. Phones pick
  it up the next time the app opens.
- Server (`server/`, `stalls/*/*.gs`): the server workflow pushes the code into
  every stall's sheet that has a `scriptId`, and moves the live deployment if
  it has a `deploymentId`.

## One-time setup for automatic server updates

The server workflow needs to act as the StallFlow Google account:

1. Turn on the Apps Script API: https://script.google.com/home/usersettings
   (signed in as StallFlow).
2. On a computer with Node installed: `npx @google/clasp@2.4.2 login`, signed
   in as StallFlow.
3. Copy the contents of `~/.clasprc.json` (Windows: `C:\Users\<you>\.clasprc.json`)
   into a repository secret named `CLASPRC_JSON`
   (repo › Settings › Secrets and variables › Actions).

Until this is done, server changes are pasted into the sheet's Apps Script
editor by hand.
