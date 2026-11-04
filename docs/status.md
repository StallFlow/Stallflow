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

## Reporting problems to Claude (built, needs two switches)

More › Report a problem saves what staff type to the sheet's Issues tab and,
when connected, opens a GitHub issue labelled `app-report`. The
`claude-fix.yml` workflow then asks Claude to look into it and open a pull
request. Claude never merges; a person does.

To switch it on, once:

1. **GitHub token for the sheet.** Create a fine-grained token at
   github.com › Settings › Developer settings, limited to this repository, with
   **Issues: read and write** and nothing else. In each stall's Apps Script:
   Project Settings › Script properties › add `GITHUB_TOKEN`. Until then,
   reports are only kept in the Issues tab (Status says "saved (not connected
   to GitHub yet)").
2. **Anthropic key for the workflow.** Repo › Settings › Secrets › Actions ›
   `ANTHROPIC_API_KEY`. Until then the workflow reports that it has no key and
   stops.
3. Confirm the Claude GitHub app is installed on this repository.

Reports are public (this repo is public). Phone numbers and e-mail addresses
are blanked out before anything is stored or sent, and the screen tells staff
not to type customer names. Make the repo private if that is not enough.

## Next up

- **Stock import** for Duxie's (products, prices, batch costs) before their
  next market. Nothing is built yet.
- Add Duxie's next market and make it live (Numbers). Pre-orders stay closed
  until then, because the 5 Sep market has passed.
- Optional: bump GitHub Actions to Node 24 versions (deprecation warnings).
