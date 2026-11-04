# Where things stand

_Last updated 20 October 2026._

## Live

| | |
|---|---|
| Duxie's order page | https://stallflow.github.io/Stallflow/duxies/ |
| Duxie's staff app | https://stallflow.github.io/Stallflow/duxies/app/ |
| Server | Apps Script bound to Duxie's sheet, deployment `AKfycbzT…w4w` (in `stalls/duxies/stall.json`) |
| Sign-in | **Google.** Switched on 20 Oct after `sfGrantGoogle` ran as StallFlow. Add staff under More › People. |
| Code updates | Push to `main`: Pages republishes the app; the server workflow pushes `server/` into the sheet and redeploys in place (key: `CLASPRC_JSON` secret, StallFlow Google account). |

The older site, `stallflow.github.io/duxies/` (repo `StallFlow/duxies`), uses
the same server and sheet. Leave it alone; give people the new links.

## Accounts

- **GitHub:** `StallFlow` owns this repo; `elchoerob-stack` is a collaborator.
  The Claude GitHub app is installed on `StallFlow/Stallflow` only.
- **Google:** `stallflow910803@gmail.com` owns the Cloud project
  "Stallflow Stalls" (OAuth client in `server/Platform.gs`) and the
  `CLASPRC_JSON` key. On 20 Oct Google briefly blocked this account
  (new account + Cloud project + unverified-app approval + key used from
  GitHub); its recovery phone (ending 71) is not Jacques's.
  **Fix its recovery phone and email before relying on it again.**
- The clasp key shown in a chat screenshot on 20 Oct should be revoked at
  myaccount.google.com/connections (as StallFlow) and replaced:
  `npx @google/clasp@2.4.2 login` in an Incognito window, then update the
  `CLASPRC_JSON` secret. Never screenshot `.clasprc.json`.

## To switch Google sign-in on

1. Decide which Google account StallFlow runs as. Recommended until there is
   a Google Workspace account: an established account Jacques controls.
2. As that account, in the sheet's Apps Script editor, run `sfGrantGoogle`
   (People.gs) and approve. The log must say the permission is in place.
3. Put the admin email(s) back in `SF.PLATFORM.admins` (`server/Platform.gs`)
   and push. `SF.googleOn()` needs both a client ID and an admin.
4. Sign in on the phone, then add people under More › People.

If the deploying account changes, the OAuth client and the `CLASPRC_JSON`
key should move to that account too.

## Place suggestions in the app (on)

The **Where** box on New market suggests places from Google as you type,
inside the app (South Africa only). Nothing opens another browser. Without a
key, with no signal, or if Google refuses the key, the box is plain text.

- **Key:** `mapsKey` in `stalls/platform.json`, shared by every stall. Set on
  4 November 2026. It lives in the Google Cloud project **"My First Project"**
  (not "Stallflow Stalls").
- **Restrictions (checked 4 Nov):** websites `https://stallflow.github.io/*`
  only; APIs: Maps JavaScript API and Places API (New) only. A request from
  another website is refused with `API_KEY_HTTP_REFERRER_BLOCKED`.
- **Billing: action needed.** The Google account is on the $300 free trial.
  Before the trial ends, convert it or link the project to a paying billing
  account, or suggestions stop (the box then falls back to plain text). Set a
  budget alert in Google Cloud Billing while you are there.
- The key is meant to be seen: every phone that opens the app receives it.
  The website and API restrictions are what protect it, so never loosen them.
  To change keys, replace `mapsKey` and push; blank turns suggestions off.
- **More › Health check** shows "Place search: Google" when it is on.

## Reporting problems to Claude (built, needs two switches)

Staff tap **More › Report a problem**. The report is saved in the sheet's
Issues tab and, once connected, opened as a GitHub issue labelled
`app-report`. The `claude-fix.yml` workflow comments "Claude is looking into
this", then Claude opens a pull request with a fix or explains on the issue
what it found. **Claude never merges**; a person does.

To switch it on, once per stall:

1. **Sheet → GitHub.** In the stall's spreadsheet: **StallFlow › Connect
   problem reports to Claude…** and follow the box. It needs a fine-grained
   GitHub token limited to this repository with **Issues: read and write**
   only. The token is checked before it is kept. Paste it only into that box,
   never into a chat.
2. **GitHub → Claude.** Repo › Settings › Secrets and variables › Actions,
   add **one** of:
   - `CLAUDE_CODE_OAUTH_TOKEN`: uses a Claude Pro/Max subscription. Get it by
     running `claude setup-token` on a computer with Claude Code.
   - `ANTHROPIC_API_KEY`: uses an API account at console.anthropic.com.
3. The Claude GitHub app must be installed on this repository (it is).

**More › Health check** shows "Problem reports: To Claude" once step 1 is
done. Reports are public (this repo is public). Phone numbers and e-mail
addresses are blanked out before anything is stored or sent, and the screen
asks staff not to type customer names.

## Next up

- **Stock import** for Duxie's (products, prices, batch costs) before their
  next market. Nothing is built yet.
- Add Duxie's next market and make it live (Numbers). Pre-orders stay closed
  until then, because the 5 Sep market has passed.
- Optional: bump GitHub Actions to Node 24 versions (deprecation warnings).
