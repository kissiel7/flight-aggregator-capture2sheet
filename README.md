# Flight Aggregator Capture2Sheet

Capture flight-search results from browser aggregators and store them in Google Sheets.

## Current implementation

The first supported source is **Skyscanner**.

Architecture:

```text
Skyscanner browser page
        |
        v
Tampermonkey collector
        |
        | HTTPS POST / JSON
        v
Google Apps Script Web App
        |
        v
Google Sheet: "Flight Aggregator Capture"
        |
        v
Tab: "Skyscanner Results"
```

## Repository layout

```text
apps-script/
  Code.gs                          Google Apps Script backend

tampermonkey/
  skyscanner-capture.user.js       Browser collector

README.md                          Setup and operating documentation
```

## Design decisions

### Spreadsheet selection

The Apps Script locates a native Google Sheet by the exact Drive name:

```text
Flight Aggregator Capture
```

No spreadsheet ID is hard-coded.

If zero matching native Google Sheets exist, the backend stops with an error. If more than one matching native Google Sheet exists, it also stops rather than guessing which file should receive the data.

### Deduplication

Deduplication is enforced **server-side** in Apps Script.

The browser creates a `dedupe_key` from:

- origin
- destination
- outbound date
- inbound date
- passenger configuration
- cabin
- Skyscanner itinerary identifier

Price is deliberately **not** part of the key.

If the same itinerary is observed again, the existing row is updated instead of duplicated. The backend preserves `first_seen`, updates `last_seen`, increments `seen_count`, and refreshes volatile fields such as price.

A script lock protects the Sheet against simultaneous writes.

### Secrets

Do **not** commit the Apps Script API key or deployed Web App URL.

The shared secret is stored in Apps Script Script Properties and copied locally into Tampermonkey.

## Google Apps Script setup

1. Open the Apps Script project.
2. Replace `Code.gs` with `apps-script/Code.gs`.
3. Save.
4. Run `testSpreadsheetConnection()`.
5. Authorize Drive / Sheets access if Google requests it.
6. Verify the execution log reports:
   - `Flight Aggregator Capture`
   - the expected tabs.
7. Run `setupSkyscannerCollector()`.
8. Copy the generated API key from the execution log.

The setup function creates the `Skyscanner Results` tab if required and writes the expected header row.

## Deploy Apps Script as a Web App

In Apps Script:

1. **Deploy -> New deployment**
2. Type: **Web app**
3. Execute as: **Me**
4. Who has access: **Anyone**
5. Deploy.
6. Copy the deployed URL ending in `/exec`.

Use the deployed `/exec` URL, not the development `/dev` URL.

Opening the `/exec` URL in a browser should return a JSON health-check response.

## Tampermonkey setup

1. Install Tampermonkey.
2. Create a new userscript.
3. Copy `tampermonkey/skyscanner-capture.user.js`.
4. Set:
   - `WEB_APP_URL`
   - `API_KEY`
5. Save the userscript.
6. Open a Skyscanner flight-results page.

The script automatically observes dynamically rendered results and batches changed itineraries to Apps Script.

A small status badge appears at the bottom-right of the page. Clicking it forces an immediate scan and send.

## Google Sheet columns

The current backend maintains:

```text
dedupe_key
itinerary_key
first_seen
last_seen
seen_count
captured_at_client
source
search_url
origin
destination
outbound_date
inbound_date
adults
children
cabin
price
currency
price_text
airlines
depart_time
arrive_time
duration
stops
self_transfer
config_url
raw_text
```

## Update workflow

During active development:

1. Edit scripts in this repository.
2. Copy the current `apps-script/Code.gs` into Apps Script.
3. Deploy a new Apps Script version when backend code changes.
4. Copy the current Tampermonkey script when browser extraction changes.

A later improvement can move Apps Script deployment to `clasp` so source synchronization and deployments no longer need manual copy/paste.

## Planned extensions

The architecture deliberately separates browser extraction from Sheet storage so additional flight aggregators can later reuse the same backend pattern.
