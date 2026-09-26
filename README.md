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

The active schema is documented in **Current compact result schema** below.

The live table is intentionally optimized for compact visual use while Apps Script maps those display headers to stable internal field names.

## Update workflow

During active development:

1. Edit scripts in this repository.
2. Copy the current `apps-script/Code.gs` into Apps Script.
3. Deploy a new Apps Script version when backend code changes.
4. Copy the current Tampermonkey script when browser extraction changes.

A later improvement can move Apps Script deployment to `clasp` so source synchronization and deployments no longer need manual copy/paste.

## Planned extensions

The architecture deliberately separates browser extraction from Sheet storage so additional flight aggregators can later reuse the same backend pattern.


## Collector status panel

Tampermonkey version 1.1.0 adds a persistent diagnostic panel on Skyscanner result pages.

It shows:

- current collector status
- Skyscanner cards detected
- results successfully extracted
- pending unsent results
- cumulative inserted / updated row counts returned by Apps Script
- backend health-check result
- last HTTP status
- last scan and send timestamps
- last transport or backend error

Controls:

- **Scan now** — force immediate DOM scan
- **Send now** — scan and immediately attempt to POST pending results
- **Test backend** — GET the Apps Script Web App URL and verify that the deployed backend can see the target spreadsheet

### Troubleshooting interpretation

- **No status panel at all**: Tampermonkey script is not running on the current URL; check whether the userscript is enabled and whether the Skyscanner hostname matches the userscript rules.
- **Backend = OK, Cards detected = 0**: browser-to-Google connectivity works; Skyscanner DOM selectors need adjustment.
- **Cards detected > 0, Results extracted = 0**: candidate cards are found, but extraction logic rejects them.
- **Pending > 0, HTTP blank**: results exist but no POST completed yet.
- **HTTP 200 + Saved**: Apps Script accepted the batch; inspect `Skyscanner Results`.
- **Backend error / Network error / Timeout**: troubleshoot deployment URL, Web App permissions, Tampermonkey `@connect`, or Apps Script deployment.


## Capture scope and seen_count

### Capture scope

The Tampermonkey collector scans **all Skyscanner connection/result cards that are currently rendered in the page DOM**. It is not limited to the cheapest or first result.

Skyscanner may lazy-load or virtualize results. As the user scrolls and additional result cards are rendered, the MutationObserver detects them and the collector accumulates those itineraries during the current search session.

This means:

- all currently rendered result cards are captured;
- additional cards loaded while scrolling are also captured;
- the script does not currently auto-scroll the entire result list by itself.

### seen_count

`seen_count` is the number of times the backend has accepted a new observation of the same deduplicated itinerary.

Version 1.2.0 fixes an earlier issue where `captured_at_client` changed on every periodic scan and could therefore cause unchanged results to be re-sent. The timestamp is now excluded from change detection.

After this fix, `seen_count` increases only when that itinerary is sent again because its captured content changed, for example when the price or another extracted field changes.

## Deployment workflow

GitHub `main` remains the **source of truth** for the project.

For now, Apps Script deployment is intentionally **manual**.

Current workflow:

```text
change required
      |
      v
update GitHub first
      |
      v
copy apps-script/Code.gs into Google Apps Script
      |
      v
save in Apps Script
      |
      v
Deploy -> Manage deployments -> Edit
      |
      v
create/select new version and deploy
      |
      v
existing /exec Web App URL remains in use
```

### Source-of-truth rule

All backend changes should be made in GitHub first:

```text
apps-script/Code.gs
```

The Apps Script editor on Google is treated as a deployed copy, not as the master source.

This avoids the GitHub and Google versions drifting apart.

### Tampermonkey updates

Tampermonkey source is maintained in:

```text
tampermonkey/skyscanner-capture.user.js
```

When this file changes, copy the latest version into Tampermonkey.

Tampermonkey-only changes do **not** require Apps Script redeployment.

### When Apps Script redeployment is required

Redeploy when files under:

```text
apps-script/**
```

change in a way that affects the Web App backend.

Typical examples:

- request handling changes
- spreadsheet schema changes
- deduplication logic changes
- authentication changes
- new backend fields or processing
- manifest changes that affect runtime behavior

### When redeployment is not required

No Apps Script redeployment is needed for:

- README/documentation changes
- Tampermonkey-only changes
- notes or planning files

### GitHub Actions status

A GitHub Actions / `clasp` deployment workflow was explored and the repository may still contain related files, but **automatic deployment is not currently part of the active operating procedure**.

Do not rely on GitHub Actions to update the Google Apps Script project.

The current decision is to keep manual deployment until automation is intentionally re-enabled and tested.

### Future option

If deployment automation is revisited later, the preferred architecture remains:

```text
GitHub main
   ->
GitHub Actions
   ->
clasp push
   ->
redeploy existing Apps Script deployment
```

Until then, use the manual workflow above.


## 2026-09-26 column-migration / German Skyscanner parsing fix

A test deployment exposed two issues in the first column-reorder migration:

1. Reordered values inherited number formats from the old physical columns. This could display times as dates (for example `1899-12-30 10:05:00`) and counters such as `seen_count` as times.
2. Search metadata parsing depended on the literal URL segment `/flights/`. German Skyscanner uses a localized route such as `/transport/fluge/...`, so `origin`, `destination`, and dates could be empty.

The fixes are now in GitHub:

- Apps Script explicitly resets data-column number formats after schema migration and then reapplies the intended formats by field name.
- Tampermonkey 1.3.0 parses the route structurally after `/transport/<localized route word>/` instead of requiring `/flights/`.
- German result text is supported for airline, departure/arrival time, duration, stops, and self-transfer extraction.
- Fallback itinerary deduplication now uses normalized flight characteristics instead of the entire rendered card text, reducing duplicates caused by provider advertising text or changing “Flight option N” labels.

Existing test rows that were already converted to the wrong underlying value type cannot always be repaired by formatting alone. For test data, the safest recovery is to clear the affected data rows (keep the header), deploy the fixed backend/userscript, and recapture the search results.



## 2026-09-26 route/price extraction refinement

This earlier one-way schema was superseded by the compact outbound/inbound schema introduced in Tampermonkey 1.5.0.

The current implementation uses separate `Out_*` and `In_*` fields, combined ISO datetime cells, `Price_PP` / `Price_Total`, and compact human-friendly keys. See **Current compact result schema**.

## Current compact result schema

The live `Skyscanner Results` tab uses the human-friendly display headers below:

```text
Org
Dst
ODeparture
OArrival
ODuration
OSt
OStops
OAirlines
OSelf Tr
IDeparture
IArrival
IDuration
ISt
IStops
IAirlines
ISelf Tr
Price PP
Price Total
Curr
AD
CH
cabin
Search URL
Source
First seen
Last seen
Seen Count
Captured at client
Price text
Dedupe key
Itineriary key
Config URL
Raw text
```

Datetime fields use compact ISO ordering:

```text
YYYY-MM-DD HH:mm
```

`OSt` / `ISt` are the outbound/inbound stop counts.

`OStops` / `IStops` contain the corresponding stop-airport IATA codes from the Skyscanner result card:

```text
OSt = 1   OStops = BCN
OSt = 2   OStops = AMS,MAD
ISt = 1   IStops = MAD
```

Direct legs use stop count `0` and leave the stop-airport field blank.

Tampermonkey 1.6.6 extracts these codes from the compact result text rendered on the initial Skyscanner page. Existing captured rows were backfilled where the stop airport codes were recoverable from `Raw text`.

For one-way searches, all inbound (`I*`) fields remain blank.

## Tampermonkey safe-to-leave indicator

Tampermonkey 1.6.0 simplifies the diagnostic panel and makes its primary purpose explicit: show whether it is safe to leave the current Skyscanner result page.

Indicator states:

- **Yellow** — results are still loading/being collected; keep the page open.
- **Blue** — results are currently being sent to Apps Script; keep the page open.
- **Green** — all currently discovered results have been sent and no new/changed results appeared during the stabilization window; it is safe to leave/change the page.
- **Red** — collector/backend error; keep the page open and inspect the displayed error.

The green state is deliberately delayed. After a successful send, the collector waits approximately 3.5 seconds for additional Skyscanner results to appear. If new results are detected, the green state is cancelled, the new results are sent, and the stabilization check starts again.

The compact panel now shows only:

- status
- result cards detected
- cumulative inserted / updated counts
- backend health
- error text when applicable
- manual **Scan now**, **Send now**, and **Test backend** buttons

Low-value telemetry such as `Results extracted`, `Pending`, HTTP status, last scan time, and last send time is intentionally hidden from the panel.



### Readiness timer fix (Tampermonkey 1.6.1)

Skyscanner continuously mutates its DOM. In 1.6.0, unchanged DOM-driven rescans could repeatedly restart the 3.5-second readiness timer, preventing the green **Complete — safe to leave page** state from appearing.

Version 1.6.1 changes the logic so that:

- ordinary DOM mutations / unchanged rescans do **not** restart the readiness timer;
- only an actual new or changed extracted flight result resets the stabilization period;
- after a successful send and a stable result set, the indicator can reach green even while Skyscanner continues updating unrelated page elements.



### Sticky completed-page state (Tampermonkey 1.6.2)

Once the current Skyscanner URL has reached the green **Complete — safe to leave page** state, that completed state is sticky for that URL.

- ordinary DOM churn and unchanged rescans no longer make the panel fall back to generic **Loading / collecting**;
- if genuinely new/changed extracted results appear and are unsent, the panel shows **New results detected — keep page open**, then **Sending**, and returns to green after completion;
- if a later scan finds nothing pending, the panel remains green;
- navigating to a new Skyscanner search URL resets the readiness state and starts the initial loading/collecting cycle again.



## Server-side result filters

The Google Apps Script backend supports optional filters from the `Guide & Filters` tab. Filters are applied **at spreadsheet injection time**, so Tampermonkey can still capture all rendered Skyscanner results while the backend decides which new itineraries are allowed into `Skyscanner Results`.

The `Guide & Filters` tab uses column A for the filter name and column B for the value:

```text
A                         B
Max. inbound stops        <number>
Max. outbound stops       <number>
Max PP price              <number>
Max total price           <number>
Self transfer             <TRUE/FALSE or ALLOW/EXCLUDE>
```

A blank value in column B disables that filter.

Semantics:

- `Max. inbound stops`: applies only when an inbound/return leg exists; one-way results ignore it.
- `Max. outbound stops`: maximum outbound stop count.
- `Max PP price`: maximum per-person price.
- `Max total price`: maximum total itinerary price.
- `Self transfer = TRUE` or `ALLOW`: self-transfer itineraries are permitted.
- `Self transfer = FALSE` or `EXCLUDE`: new itineraries with self-transfer on either leg are rejected.

Filters apply only to **new rows**. If an itinerary already exists in `Skyscanner Results`, it can still be updated even if its latest observation is outside the current filter limits. Existing rows are never deleted by this filter mechanism.

If an active numeric filter is configured but the corresponding extracted value is missing, the new result is rejected rather than silently admitted. This is intentionally fail-closed.

The backend response includes `filtered`, `filteredByReason`, and `activeFilters`. Tampermonkey 1.6.3 displays cumulative `Inserted / updated / filtered` counts in the compact status panel.

### Numeric spreadsheet values

Numeric result fields are explicitly coerced to JavaScript numbers in Apps Script before writing:

```text
Out_Stop
In_Stop
Price_PP
Price_Total
AD
CH
seen_count
```

The spreadsheet formatting no longer applies a blanket text format to the entire data area. Numeric columns receive numeric formats directly, while text formatting is restricted to text columns. This keeps prices and counts usable for native Google Sheets sorting, filtering, formulas, comparisons, and charts.



### Deterministic readiness state (Tampermonkey 1.6.4)

The collector readiness indicator no longer depends on a particular ordering of DOM scans, send callbacks, and timer callbacks.

The green state is now derived from these conditions:

```text
backend send succeeded
AND no unsent extracted results remain
AND at least one result has been discovered
AND the extracted result set has been stable for the configured settle window
```

If those conditions are true, the panel becomes **Complete — safe to leave page** regardless of whether an extra periodic scan happened first.

The panel also shows the active Tampermonkey script version. This makes it immediately visible when an already-open browser tab is still running an older userscript revision.



### Local Tampermonkey configuration placement

From Tampermonkey 1.6.5, the local credential/configuration block is placed as close as practical to the end of the userscript, immediately before `init()`:

```javascript
const WEB_APP_URL = 'PASTE_YOUR_GOOGLE_APPS_SCRIPT_EXEC_URL_HERE';
const API_KEY = 'PASTE_YOUR_API_KEY_HERE';

init();
```

This keeps the two machine-local values easy to preserve when replacing the script from GitHub. The constants do not need to be declared near the top; they only need to be initialized before `init()` starts code that reads them.



## Guide & Filters tab

The first spreadsheet tab is named `Guide & Filters`.

It combines three purposes in one human-readable reference page:

- editable server-side capture filters;
- a short explanation of the capture/filter/store workflow;
- a legend for the columns used in `Skyscanner Results`.

The filter input cells are highlighted in the Value column. Blank filter values disable that filter. Existing result rows are never deleted by these filters.

The Apps Script backend reads the filter rows by their labels, so the additional guide/legend content does not affect filtering.



## Temporary Skyscanner UI lock

Tampermonkey 1.6.7 temporarily blocks interaction with the Skyscanner page while the initial result set is being collected, sent to the backend, and allowed to settle.

The implementation deliberately does **not** pause Skyscanner itself. The page continues rendering and the collector continues scanning underneath a transparent interaction blocker.

The existing collector status panel remains in its normal bottom-right position and stays clickable above the blocker. Its three previous action buttons were removed and replaced by one contextual button:

```text
Use page anyway
```

Pressing this button:

- releases the page UI immediately;
- does not cancel scanning;
- does not cancel an active backend request;
- does not clear discovered or pending results;
- keeps collection/upload running in the background.

The override is scoped to the current Skyscanner URL. Navigating to a new search URL resets the override and activates the interaction lock again.

The page also unlocks automatically after the first successful completed capture cycle, when:

```text
at least one backend send has succeeded
AND no unsent extracted results remain
AND results have remained stable for the settle window
```

Once the current URL has completed or has been manually overridden, later background DOM changes do not re-lock the page.

While locked, pointer interaction and page scrolling are blocked, and page-level keyboard input is suppressed. The collector panel remains interactive so the override button can always be used.



### Localized Skyscanner result-card discovery (Tampermonkey 1.6.8)

Skyscanner localizes the route segment in result URLs. For example:

```text
/transport/flights/...   English
/transport/fluge/...     German
```

Earlier collector versions still had one result-card selector hard-coded to `/transport/flights/`. On localized pages this could leave the collector at `Cards detected: 0` even while visible flight cards were already rendered, which in turn prevented the readiness state from ever reaching Complete.

Tampermonkey 1.6.8 fixes this by:

- detecting itinerary links via `/config/` without depending on the localized route word;
- recognizing both English and German accessibility labels, including `Flight option`, `Total cost`, `Flugoption`, `Gesamtpreis`, and `Gesamtkosten`;
- applying the same multilingual handling when extracting result-card accessibility text.



### Per-search result counters (Tampermonkey 1.6.9)

The compact collector panel now uses:

```text
INS / UPD / REJ
```

where:

- `INS` = newly inserted rows;
- `UPD` = existing dedupe-key rows updated;
- `REJ` = new results rejected by the active server-side filters.

These counters are scoped to the current Skyscanner search page. They reset when the Skyscanner URL changes. A full browser-page reload naturally resets them as well because the userscript state is recreated.

