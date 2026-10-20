# Adding a new stall

About 20 minutes. Do it signed in as the **StallFlow Google account**.

1. **Make the sheet.** Create a blank Google Sheet named after the stall, then
   open **Extensions › Apps Script** once so it gets its own script project.
   Copy the **Script ID** from Apps Script › Project Settings.
2. **Describe the stall.** In the repo, copy `stalls/duxies/` to
   `stalls/<slug>/` (lowercase, no spaces, e.g. `kobus-biltong`).
   - In `stall.json`, set `name` and `scriptId`. Leave `api` and
     `deploymentId` empty for now.
   - In `Tenant.gs`, set the name, colours, WhatsApp number, preset, products
     and prices.
3. **Send the code.** Push. The server workflow copies the code into the
   sheet. (Without the `CLASPRC_JSON` secret, paste `server/*.gs`,
   `server/appsscript.json` and the stall's `Tenant.gs` into the Apps Script
   editor by hand.)
4. **Load it.** Reload the sheet and choose **StallFlow › Load this stall**.
5. **Publish the server.** In Apps Script: **Deploy › New deployment › Web
   app**, execute as *Me*, access *Anyone*. Copy the web app URL and the
   deployment ID into `api` and `deploymentId` in `stall.json`. Push.
6. **Share it.** Share the sheet with the stall owner as an editor, and send
   them their two links:
   - order page: `https://stallflow.github.io/Stallflow/<slug>/`
   - staff app: `https://stallflow.github.io/Stallflow/<slug>/app/`
