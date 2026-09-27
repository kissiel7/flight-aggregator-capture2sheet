# Troubleshooting, Regression Notes, and Maintenance Rules

This document is the canonical maintenance record for the Skyscanner -> Google Sheets capture pipeline.

It summarizes bugs already encountered, their root causes, the fixes that worked, and the rules that should be followed to avoid reintroducing them.

Current implementation reviewed against `main`:

- Tampermonkey collector: **v1.6.13**
- Apps Script backend: `apps-script/Code.gs`
- Spreadsheet: `Flight Aggregator Capture`
- Result tab: `Results`
- Configuration/reference tab: `Guide & Filters`

---

## 1. Architecture and ownership boundaries

```text
Skyscanner page
    |
    | DOM/result-card parsing
    v
Tampermonkey userscript
    |
    | JSON batch
    v
Google Apps Script Web App
    |
    | validation, filtering, dedupe/upsert
    v
Google Sheet
```

Responsibilities must remain separated:

### Tampermonkey

Responsible for:

- discovering currently rendered Skyscanner result cards;
- parsing flight/card data;
- building itinerary and dedupe keys;
- tracking what has already been sent during the current page session;
- sending result batches;
- user-facing status, temporary page lock, and override.

Tampermonkey must **not** be treated as the authoritative dedupe layer.

### Apps Script

Responsible for:

- API-key validation;
- reading server-side filters;
- authoritative deduplication/upsert;
- preserving `First seen`;
- updating `Last seen`;
- incrementing `Seen Count`;
- inserting only new rows that pass active filters;
- coercing numeric values to actual numbers before writing to Sheets.

### Google Sheet

Responsible for:

- persistent storage;
- human-readable display labels;
- editable filter configuration;
- user review/analysis.

Do not move critical data-integrity logic into spreadsheet formulas.

---

## 2. Current invariants

These are intentional design rules. Treat them as regression checks.

### Repository / deployment

- GitHub `main` is the source of truth.
- Routine Apps Script changes must update the **existing Web App deployment**:
  `Deploy -> Manage deployments -> existing Web App -> Edit -> New version -> Deploy`.
- Do not create a new deployment for routine updates; doing so can change the deployment ID and `/exec` URL.
- Tampermonkey-only changes do not require Apps Script redeployment.
- Already-open browser tabs continue running the old userscript until reloaded.

### Local Tampermonkey secrets

The local values remain close to the end of the userscript, immediately before `init()`:

```javascript
const WEB_APP_URL = 'PASTE_YOUR_GOOGLE_APPS_SCRIPT_EXEC_URL_HERE';
const API_KEY = 'PASTE_YOUR_API_KEY_HERE';

init();
```

Never commit real values.

### Dedupe

- Server-side Apps Script dedupe is authoritative.
- Price is not part of itinerary identity.
- `itinerary_key` identifies the flight combination.
- `dedupe_key` adds passenger/cabin quote context.
- A short three-character base-36 suffix is only a tie-breaker.
- Prefer Skyscanner config identity when available; otherwise use a stable leg signature.

### One-way vs round-trip

- One-way searches leave all inbound fields blank.
- Inbound filters are ignored for one-way results.
- Do not manufacture inbound data by reversing the outbound leg.

### Filters

Filters live in `Guide & Filters`.

Active filters are applied only when inserting a **new** dedupe key.

Existing rows:

- are not deleted;
- may continue to be updated even if the current filter values would reject a new row with the same characteristics.

Blank filter values disable that filter.

### Numeric data

These fields must be stored as real numbers, not numeric-looking strings:

- `OSt`
- `ISt`
- `Price PP`
- `Price Total`
- `AD`
- `CH`
- `Seen Count`

Number formatting alone is not sufficient. Apps Script must coerce the payload values to JavaScript numbers before `.setValues()`.

---

## 3. Current collector status semantics

### Main/bold state

The large status is intentionally short:

```text
Loading
Collecting
Sending
Complete
Override
Error
```

### Small Status line

Operational status may include:

```text
Starting
Waiting for Skyscanner results
New search — waiting for results
Collecting N results
Results pending
Sending N
Sent — checking for more results
All results uploaded
New results detected
UI override active — collection continues
UI override active — upload continues
Configure WEB_APP_URL
Configure API_KEY
Parser error
Server error
Network error
Timeout
```

The small status is diagnostic detail. The bold line should remain a state category, not duplicate the same sentence.

### Backend line

Keep backend health compact:

```text
Not tested
Testing
OK
Config error
Server error
Invalid response
Network error
Timeout
```

### Per-search counters

```text
INS / UPD / REJ
```

- `INS`: new rows inserted.
- `UPD`: existing dedupe-key rows updated.
- `REJ`: new results rejected by server-side filters.

Counters are scoped to the current Skyscanner search URL and reset when the URL changes. A full page reload recreates userscript state and therefore resets them too.

---

## 4. UI lock semantics

The collector temporarily blocks interaction with the Skyscanner page until the initial detected results have been sent and the page has settled.

Important:

- the blocking layer must not stop Skyscanner rendering;
- DOM observation and backend upload continue underneath;
- the existing bottom-right collector panel remains clickable above the blocker;
- the only page control in the panel is `Use page anyway`;
- override releases only the UI lock;
- override must not cancel scanning, pending results, or an active upload;
- override is reset when the Skyscanner search URL changes;
- once a URL is Complete or manually overridden, later DOM churn must not re-lock that same URL.

Browser-level actions such as closing the tab or changing the address bar cannot be reliably blocked by a userscript.

---

## 5. Bug/fix ledger

### 5.1 Volatile client timestamp caused endless resend / inflated Seen Count

**Symptom**

The same itinerary was repeatedly sent even though its real content had not changed. `Seen Count` increased rapidly.

**Root cause**

`captured_at_client` changed on every scan and was included in the client-side comparison snapshot.

**Fix**

Exclude `captured_at_client` from the stable comparison used by `sentSnapshot`.

**Permanent rule**

Never include volatile observation metadata in the client-side equality check. Compare only fields whose change should trigger a new observation.

---

### 5.2 Spreadsheet schema migration inherited incorrect formats

**Symptom**

Values such as `10:05` appeared as date/time serials or count values displayed as times after column changes.

**Root cause**

Existing cell formats survived schema migration and were inappropriate for the new column occupying the same position.

**Fix**

Explicitly reapply formats by semantic column after schema changes.

**Permanent rule**

After any schema reorder/add/remove operation:

1. verify header order;
2. reapply text/number/date formats explicitly;
3. inspect real rows, not only the header.

Do not assume moving data also moves the correct semantic formatting.

---

### 5.3 Numeric-looking prices were stored as text

**Symptom**

Google Sheets could not reliably sort, compare, chart, or calculate prices numerically.

**Root cause**

Cell number format was set, but payload values could still arrive as strings.

**Fix**

Apps Script now coerces numeric fields before writing and applies numeric formatting only to numeric columns.

**Permanent rule**

Data type and display format are separate concerns. Fix the value type first, then formatting.

---

### 5.4 Search-area destination was used instead of actual airport

**Symptom**

Destination could be `TENE` instead of actual `TFS` / `TFN`.

**Root cause**

The parser trusted the search URL area code rather than the rendered itinerary.

**Fix**

Use actual airport codes from the result card where available; search URL codes are fallback only.

**Permanent rule**

For itinerary identity and stored route data, prefer the rendered flight/card data over broad search-area codes.

---

### 5.5 German Skyscanner text was not parsed completely

**Symptoms**

Missing:

- stop count;
- duration;
- airlines;
- self-transfer;
- arrival-day offset;
- total price.

**Root cause**

Parser logic was initially biased toward English/card patterns and did not cover German result text.

**Fix**

Add German patterns such as:

```text
Flug mit einem Zwischenstopp
Flug mit 2 Zwischenstopps
Flug mit eigenem Transfer
einen Tag später
Gesamtpreis
Gesamt
```

**Permanent rule**

Every parser change must be tested against at least one real German raw-text sample because the active workflow uses `skyscanner.de`.

Keep `Raw text` in the sheet; it is the primary evidence for future parser repairs.

---

### 5.6 Stop airports were available but not captured

**Symptom**

Stop count existed, but `OStops` / `IStops` remained blank.

**Root cause**

The parser extracted only stop count, not airport codes following the compact stop summary.

**Fix**

Parse patterns such as:

```text
1 Zwischenstopp BCN
2 Zwischenstopps MAD , AMS
```

Store compact comma-separated IATA codes:

```text
BCN
MAD,AMS
```

Direct flights keep the stop-airport field blank.

**Permanent rule**

When adding a parsed field, update all four layers together:

1. Tampermonkey payload;
2. Apps Script `SCHEMA`;
3. spreadsheet header/format/width;
4. examples/documentation.

---

### 5.7 Arrival-day offset was lost

**Symptom**

Overnight flights could get the departure date as their arrival date.

**Root cause**

Only time-of-day was parsed.

**Fix**

Support:

- `+1`, `+2`;
- `einen Tag später`;
- `zwei Tage später`;
- English equivalents.

**Permanent rule**

Datetime parsing must combine search-date context with card-local day-offset information.

---

### 5.8 `inbound_date` semantics were accidentally changed

**Symptom**

Round-trip parsing could interpret the wrong date as the inbound search date.

**Fix**

Restore `inbound_date` to mean the actual return-search date.

**Permanent rule**

Date field semantics are part of the API contract. Do not rename/re-purpose them casually; document any semantic change before implementation.

---

### 5.9 Display-header changes broke backend assumptions

**Symptom**

User-friendly spreadsheet labels changed while backend code still expected internal-style labels.

**Root cause**

Storage/display labels and internal payload field names were coupled.

**Fix**

Apps Script uses a `SCHEMA` mapping:

```javascript
{ header: 'ODeparture', field: 'out_departure_dt' }
```

Internal backend indexes should be derived from `field`, not display text where possible.

**Permanent rule**

Treat spreadsheet labels as presentation. Treat payload field names as API identifiers.

Human-friendly label changes should not require Tampermonkey payload renaming.

---

### 5.10 Readiness timer starvation

**Symptom**

The collector stayed yellow indefinitely after a successful send.

**Root cause**

Skyscanner continuously mutates the DOM. Every unchanged rescan restarted the readiness timer before the stabilization interval could expire.

**Fix**

Do not restart an existing readiness timer for ordinary unchanged DOM activity. Only a real extracted-result change resets the stabilization period.

**Permanent rule**

Readiness must be based on result-state changes, not raw DOM mutation frequency.

---

### 5.11 Completed page fell back to Loading

**Symptom**

A page reached green/Complete and then later showed yellow Loading even though nothing was pending.

**Root cause**

Ordinary rescans could clear or overwrite the presentation state after completion.

**Fix**

Completion is sticky for the current search URL.

**Permanent rule**

Once a URL completes, unrelated DOM churn must not make the page look incomplete.

A genuinely new unsent result may temporarily change operational status, but the implementation must not confuse generic DOM activity with incomplete upload.

---

### 5.12 Readiness depended on callback/timer ordering

**Symptom**

`Status: Nothing pending` could coexist with a yellow not-ready state.

**Root cause**

Readiness depended on which timer, scan, or send callback happened first.

**Fix**

Derive readiness from facts:

```text
backend send succeeded
AND no unsent extracted results remain
AND at least one result was discovered
AND extracted results have been stable for the settle interval
```

**Permanent rule**

State machines should be fact-derived and idempotent. Avoid transition logic that requires callbacks to occur in a particular order.

---

### 5.13 Localized Skyscanner route path caused zero cards detected

**Symptom**

Visible results existed, but:

```text
Cards detected: 0
```

**Root cause**

A selector contained the English-only path:

```text
/transport/flights/
```

while German pages used:

```text
/transport/fluge/
```

**Fix**

Detect itinerary links using the language-independent `/config/` component and supplement with multilingual accessibility labels.

**Permanent rule**

Do not put localized Skyscanner route words into core selectors.

Prefer structural/stable signals:

- `/config/`;
- `data-testid`;
- generic container relationships.

Localized labels are useful only as supplementary detection.

---

### 5.14 German accessibility labels were not recognized

**Symptom**

Some sponsored/result cards without a config link could be missed.

**Fix**

Recognize both English and German accessibility labels, including:

```text
Flight option
Total cost
Flugoption
Gesamtpreis
Gesamtkosten
```

**Permanent rule**

Accessibility-label parsing must be explicitly multilingual or avoided as a sole selector.

---

### 5.15 Parser helper functions were accidentally removed during a block edit

**Symptom**

```text
Cards detected: 10
Status: Waiting for Skyscanner results
INS / UPD / REJ: 0 / 0 / 0
```

Card discovery worked, but extraction silently failed.

**Root cause**

A source-edit operation replacing a large function block accidentally removed parser helper functions located between the edited functions.

**Fix**

Restore the complete helper set and surface parser exceptions explicitly.

The collector now reports `Parser error` instead of silently remaining in Loading.

**Permanent rule**

This is the most important regression lesson from the project:

**Never perform broad source-range replacement based only on the next function marker unless the entire intervening function inventory has been checked.**

After every Tampermonkey code edit, verify that these critical functions still exist:

```text
extractPrice
extractTotalPrice
extractTimes
extractDuration
extractStops
extractStopAirports
extractSelfTransfer
extractAirportCodes
extractLeg
buildFriendlyKeys
extractResult
scanPage
sendPendingResults
evaluateReadiness
updateBadge
```

Also verify the userscript version was updated consistently in:

- metadata `@version`;
- `CONFIG.scriptVersion`;
- backend client payload version.

---

### 5.16 Backend health text made the panel unnecessarily wide

**Symptom**

`Backend: OK: Flight Aggregator Capture / Results` dominated panel width.

**Fix**

Use compact backend states, especially `OK`.

**Permanent rule**

The status panel is operational UI, not a diagnostic dump. Detailed diagnostics belong in console logs, raw response state, or documentation.

---

### 5.17 Result counters were cumulative across searches

**Symptom**

INS/UPD/filter counts on a new Skyscanner search included previous search activity.

**Root cause**

Counters lived for the full userscript lifetime and were not reset on SPA URL changes.

**Fix**

Reset:

- INS;
- UPD;
- REJ;
- detected-card count;
- pending count

when the search URL changes.

**Permanent rule**

All status-panel counters should have explicit scope. Current scope is the current search URL.

---

### 5.18 Filters needed to run at injection time

**Requirement**

Results outside configured limits must not be added to the table, while existing rows should remain.

**Implementation**

Apps Script reads `Guide & Filters` and evaluates filters only for new rows.

**Permanent rule**

Filtering belongs on the backend, immediately before insertion. The browser may capture more than the sheet stores.

This keeps:

- the capture layer observable;
- filter policy centrally editable;
- existing data stable.

---

### 5.19 Apps Script deployment workflow could change the Web App URL

**Risk**

Using `New deployment` for routine updates can create a new deployment ID / URL.

**Fix / decision**

Routine changes update the existing deployment.

**Permanent rule**

Only create a new deployment when intentionally creating a new endpoint.

---


## 5.20 Volatile diagnostic card text prevented readiness from settling

**Symptom**

The panel could remain indefinitely on:

```text
Sent — checking for more results
```

even though:

- Backend was `OK`;
- there were no meaningful visible changes;
- the same page had already been uploaded.

A related clue was `REJ` or `UPD` increasing beyond the number of currently rendered cards.

**Root cause**

The browser-side change detector compared almost the whole captured result object. That included diagnostic/presentation fields such as:

- `raw_text`;
- `price_text`.

Skyscanner can change text that is not part of itinerary identity or the meaningful quote, for example:

- offer counts;
- sponsored wording;
- accessibility text;
- provider presentation text.

Those changes made an already-sent result look new, which reset the stabilization timer and could trigger repeated backend observations.

**Fix**

Tampermonkey 1.6.12 uses one canonical `getStableResultSnapshot()` for both:

- discovered-result change detection;
- successful-send snapshots.

The stable snapshot includes meaningful structured flight/quote fields such as route, dates/times, duration, stops, stop airports, airlines, self-transfer, passengers, cabin, numeric prices, currency and config identity.

It deliberately excludes volatile diagnostic fields such as:

```text
captured_at_client
raw_text
price_text
```

**Permanent rule**

Readiness and resend logic must compare semantic structured data, not diagnostic text.

If a field is primarily kept to debug parsing or reproduce the source text, it should not by itself cause a resend.

When adding a new payload field, decide explicitly whether that field belongs in the stable comparison snapshot.


## 5.21 Per-passenger price was confused with total price

**Symptom**

With searches containing multiple travellers, valid new results could all be rejected by the `Max PP price` filter even though the visible per-passenger price was below the configured limit.

Example Skyscanner text:

```text
373 € pro Passagier. Gesamtpreis 1.119 €
```

Expected:

```text
Price PP    = 373
Price Total = 1119
```

**Root cause**

The generic price parser could match a total-price amount before reliably identifying the explicitly labelled per-passenger amount.

For a multi-traveller search this could produce:

```text
Price PP = 1119
```

which then caused the backend `Max PP price` filter to reject the new itinerary.

**Fix**

Tampermonkey 1.6.13 gives explicit per-passenger wording highest priority, including:

```text
pro Passagier
pro Person
per passenger
per person
per traveller / traveler
Price per passenger
```

`Gesamtpreis` / `Gesamt` remain the responsibility of `extractTotalPrice()`.

A regression sample is:

```text
373 € pro Passagier. Gesamtpreis 1.119 €
```

and must parse as:

```text
Price PP    = 373
Price Total = 1119
```

**Permanent rule**

When the same card contains both a unit price and an aggregate price, parser precedence must be based on semantic labels, not merely the first currency-looking number.

Do not add `Gesamtpreis`, `Gesamt`, or `Total cost` to the generic per-passenger price patterns.

## 6. Mandatory regression checklist after Tampermonkey changes

Run this checklist before considering a userscript change complete.

### Static checks

- [ ] `@version`, `CONFIG.scriptVersion`, and client payload version match.
- [ ] Critical parser helper functions are all present.
- [ ] `WEB_APP_URL` and `API_KEY` placeholders remain near the end of the script.
- [ ] No real secrets are committed.
- [ ] Result selectors do not depend on `/transport/flights/` or another locale-specific route word.
- [ ] `captured_at_client` is excluded from stable resend comparison.
- [ ] `raw_text` and `price_text` are excluded from stable resend comparison.
- [ ] URL-change handler resets page-scoped state/counters and override.
- [ ] Parser exceptions are caught and surfaced as `Parser error`.

### Browser smoke test

Test at least one German Skyscanner one-way search containing:

- [ ] direct flight;
- [ ] one-stop flight;
- [ ] two-stop flight if available;
- [ ] self-transfer result if available;
- [ ] overnight arrival if available;
- [ ] sponsored card.

Verify:

- [ ] Cards detected > 0 when cards are visibly present.
- [ ] Collector progresses Loading -> Collecting/Sending -> Complete.
- [ ] UI lock is active before completion.
- [ ] `Use page anyway` unlocks UI without stopping capture.
- [ ] Backend becomes `OK`.
- [ ] `INS / UPD / REJ` is plausible.
- [ ] Completion status is `All results uploaded`.
- [ ] Page does not revert to Loading after completion.
- [ ] Navigating to a new search URL resets counters and lock.
- [ ] Reloading the tab starts the current userscript version.

### Data smoke test

Inspect at least one written row:

- [ ] actual `Org` / `Dst` airport codes;
- [ ] ISO outbound datetime;
- [ ] correct overnight arrival date;
- [ ] duration;
- [ ] stop count;
- [ ] `OStops` / `IStops` airport codes;
- [ ] airline;
- [ ] self-transfer boolean;
- [ ] numeric `Price PP`;
- [ ] on multi-traveller cards, `Price PP` comes from the explicit per-passenger value, not `Price Total`;
- [ ] numeric `Price Total`;
- [ ] numeric AD/CH;
- [ ] correct dedupe and itinerary keys;
- [ ] `Raw text` retained.

---

## 7. Mandatory regression checklist after Apps Script/schema changes

- [ ] GitHub `main` changed first.
- [ ] `SCHEMA` has the same number/order of columns as the live result sheet.
- [ ] New display labels map to existing internal payload fields where possible.
- [ ] Backend indexes are derived from internal fields, not fragile label strings.
- [ ] Numeric fields are coerced to numbers before writing.
- [ ] Numeric/date/text formats are explicitly reapplied after migrations.
- [ ] Existing rows are preserved unless deletion was explicitly requested.
- [ ] Filters reject only new rows.
- [ ] One-way results do not fail inbound filters.
- [ ] Apps Script Web App existing deployment is updated with a **new version**, not replaced with a new deployment.
- [ ] Health check returns OK after deployment.
- [ ] Tampermonkey is re-tested against the deployed backend.

---

## 8. Symptom -> first diagnostic

| Symptom | Check first |
|---|---|
| Visible cards, `Cards detected: 0` | localized selector/card-discovery regression |
| `Cards detected > 0`, counters remain zero | parser error / missing helper functions |
| Repeated UPD and rapidly rising Seen Count | volatile field accidentally included in stable comparison |
| Never reaches Complete after successful upload | readiness timer/state logic |
| Complete later becomes Loading | sticky-completion regression |
| Stuck on `Sent — checking for more results` while backend is OK | check whether volatile fields entered the stable comparison snapshot |
| Price sorts lexically instead of numerically | payload type coercion, not cell display format |
| All new multi-traveller results are REJ despite low visible PP prices | verify per-passenger parsing is not using total price |
| Destination is TENE instead of TFS/TFN | parser fell back to search-area code |
| Stop count exists but OStops/IStops blank | stop-airport parsing regression |
| Existing rows disappear after filter changes | backend filtering behavior is wrong; filters must not delete |
| Filters appear ignored | deployed Apps Script version may still be old or filter-tab name mismatched |
| Tampermonkey UI looks like old version | reload already-open Skyscanner tab |
| Backend URL suddenly fails after deployment | check whether a new deployment/URL was created accidentally |

---

## 9. Known limitations

### Lazy loading / virtualization

The collector only knows about result cards that Skyscanner has actually rendered/discovered.

`All results uploaded` means:

> all results currently discovered by the collector have been uploaded.

It does **not** prove that every result in Skyscanner's headline count has been rendered.

The current script does not auto-scroll the entire result list.

If complete-page exhaustive capture becomes required, implement an explicit strategy such as:

- controlled auto-scroll until result count stabilizes;
- detection of Skyscanner's end-of-results/loading indicator;
- comparison against a reliable rendered total if available.

Do not redefine readiness to mean “all Skyscanner results” until such a mechanism exists.

### Round-trip parsing

Round-trip support exists, but Skyscanner card layout can vary. Any material parser change should be validated against real round-trip raw text before claiming full coverage.

### Open-jaw itineraries

The current compact schema stores one main `Org` and `Dst` pair and inbound leg details, but does not explicitly store separate inbound origin/destination columns. Do not claim full open-jaw representation without extending the schema.

---

## 10. Change-management rule

When changing parser, schema, readiness, or UI-lock code, avoid “large replacement” edits unless necessary.

Preferred sequence:

1. fetch the current file from GitHub;
2. identify the smallest function/block that needs changing;
3. edit only that function/block;
4. re-fetch the file;
5. verify critical function inventory and version strings;
6. run the smoke-test checklist;
7. update this document if a new failure mode was discovered.

Every bug that takes non-trivial diagnosis should leave behind:

- the symptom;
- root cause;
- fix;
- permanent rule/test that prevents recurrence.

That is the main purpose of this file.
