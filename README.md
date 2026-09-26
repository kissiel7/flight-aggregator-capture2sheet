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

The live `Skyscanner Results` tab uses compact display-oriented headers:

```text
Org
Dst
Out_DayTimeD
Out_DayTimeL
Out_Dur
Out_Stop
Out_Airlines
Out_Self_T
In_DayTimeD
In_DayTimeL
In_Dur
In_Stop
In_Airlines
In_Self_T
Price_PP
Price_Total
Curr
AD
CH
cabin
Search_URL
source
first_seen
last_seen
seen_count
captured_at_client
price_text
dedupe_key
itinerary_key
config_url
raw_text
```

Datetime fields use ISO ordering in one cell:

```text
YYYY-MM-DD HH:mm
```

Examples:

```text
Out_DayTimeD = 2026-10-18 20:50
Out_DayTimeL = 2026-10-19 01:10
In_DayTimeD  = 2026-10-30 16:40
In_DayTimeL  = 2026-10-30 22:35
```

For one-way results, all `In_*` fields remain blank.

The spreadsheet contains a `Skyscanner Examples` tab with one-way and round-trip examples using the same schema.

### Compact human-friendly keys

Opaque Skyscanner config identifiers are retained in `config_url`, but the working keys are human-readable.

One-way example:

```text
itinerary_key = BER-TFS_2610182050_LAE
dedupe_key    = BER-TFS_2610182050_LAE_A3C0E
```

Round-trip example:

```text
itinerary_key = BER-TFS_2610182050_2610301640_K7M
dedupe_key    = BER-TFS_2610182050_2610301640_K7M_A3C0E
```

Meaning:

- `BER-TFS` = actual outbound airport pair
- `2610182050` = outbound departure in `YYMMDDHHmm`
- the optional second timestamp = inbound departure in `YYMMDDHHmm`
- the final three alphanumeric characters are a base-36 tie-breaker derived from the stable Skyscanner itinerary/config identity
- `A3C0E` = 3 adults, 0 children, economy

Three hash characters are intentionally used as the minimum practical suffix because the readable route and exact departure timestamp(s) already provide most of the uniqueness. The suffix is only a compact collision tie-breaker.

`itinerary_key` identifies the flight combination. `dedupe_key` additionally identifies the passenger/cabin quote context so price observations for materially different searches do not overwrite each other.



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

The Google Apps Script backend supports optional filters from the `Filters` tab. Filters are applied **at spreadsheet injection time**, so Tampermonkey can still capture all rendered Skyscanner results while the backend decides which new itineraries are allowed into `Skyscanner Results`.

The `Filters` tab uses column A for the filter name and column B for the value:

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

