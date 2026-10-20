# Adding a new stall

About 20 minutes. Do it signed in as the **StallFlow Google account**.

1. **Make the sheet.** Make a copy of the StallFlow template sheet and name it
   after the stall.
2. **Fill in the stall.** In the repo, copy `stalls/duxies/` to
   `stalls/<slug>/` (lowercase, no spaces, e.g. `kobus-biltong`). Edit
   `Tenant.gs`: name, colours, WhatsApp number, preset, products and prices.
3. **Load it.** Push. Once the server workflow has run, open the sheet and
   choose **StallFlow › Load this stall**.
4. **Publish the server.** In the sheet: **Extensions › Apps Script › Deploy ›
   New deployment › Web app**. Execute as *Me*, access *Anyone*. Copy the web
   app URL and the deployment ID.
5. **Connect it.** In `stalls/<slug>/stall.json` set `api` to the web app URL,
   `scriptId` (Apps Script › Project Settings › Script ID) and
   `deploymentId`. Push.
6. **Share it.** Share the sheet with the stall owner as an editor, and send
   them their two links:
   - order page: `https://stallflow.github.io/Stallflow/<slug>/`
   - staff app: `https://stallflow.github.io/Stallflow/<slug>/app/`
