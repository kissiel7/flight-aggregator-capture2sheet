// ==UserScript==
// @name         Skyscanner -> Google Sheets Collector
// @namespace    flight-aggregator-capture2sheet
// @version      1.6.10
// @description  Capture Skyscanner results into Google Sheets via Apps Script
// @match        https://www.skyscanner.com/*
// @match        https://www.skyscanner.de/*
// @match        https://www.skyscanner.pl/*
// @match        https://www.skyscanner.net/*
// @include      /^https:\/\/(?:www\.)?skyscanner\.[a-z.]+\/.*$/
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    scriptVersion: '1.6.10',
    scanDelayMs: 2500,
    sendDelayMs: 1500,
    minSendIntervalMs: 4000,
    readyStabilizeMs: 3500,
    debug: true
  };

  const state = {
    discovered: new Map(),
    sentSnapshot: new Map(),
    scanTimer: null,
    sendTimer: null,
    sending: false,
    lastSendTime: 0,
    totalServerInserted: 0,
    totalServerUpdated: 0,
    totalServerFiltered: 0,
    lastStatus: 'Starting',
    lastCandidateCount: 0,
    lastPendingCount: 0,
    lastHttpStatus: '',
    lastResponse: '',
    lastError: '',
    backendHealth: 'not tested',
    lastScanAt: '',
    lastSendAt: '',
    lastResultChangeAt: 0,
    lastSuccessfulSendAt: 0,
    ready: false,
    pageCompleted: false,
    userBypassedLock: false,
    readyTimer: null
  };

  function log(...args) {
    if (CONFIG.debug) {
      console.log('[Skyscanner -> Sheets]', ...args);
    }
  }

  function fnv1a(value) {
    let hash = 0x811c9dc5;

    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash +=
        (hash << 1) +
        (hash << 4) +
        (hash << 7) +
        (hash << 8) +
        (hash << 24);
    }

    return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
  }

  function normalizeWhitespace(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeForFingerprint(value) {
    let text = normalizeWhitespace(value).toLowerCase();

    text = text.replace(
      /(?:€|eur|usd|\$|gbp|£|pln|zł|chf)\s*[\d.,\s]+/gi,
      ''
    );

    text = text.replace(
      /[\d.,\s]+\s*(?:€|eur|usd|\$|gbp|£|pln|zł|chf)/gi,
      ''
    );

    return normalizeWhitespace(text);
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      if (
        value !== null &&
        value !== undefined &&
        String(value).trim() !== ''
      ) {
        return String(value);
      }
    }

    return '';
  }

  function decodeSkyscannerDate(value) {
    const v = String(value || '');

    if (/^\d{6}$/.test(v)) {
      return `20${v.slice(0, 2)}-${v.slice(2, 4)}-${v.slice(4, 6)}`;
    }

    if (/^\d{8}$/.test(v)) {
      return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    }

    return v;
  }

  function getSearchMetadata() {
    const url = new URL(window.location.href);
    const parts = url.pathname.split('/').filter(Boolean);

    let origin = '';
    let destination = '';
    let outboundDate = '';
    let inboundDate = '';

    /*
     * Skyscanner localizes the route word in the URL:
     *   /transport/flights/...
     *   /transport/fluge/...
     * etc.
     *
     * Therefore do not depend on the literal word "flights".
     * The route structure after /transport/<localized-word>/ is stable.
     */
    const transportIndex = parts.findIndex(
      part => part.toLowerCase() === 'transport'
    );

    if (transportIndex >= 0 && parts.length >= transportIndex + 5) {
      origin = parts[transportIndex + 2] || '';
      destination = parts[transportIndex + 3] || '';
      outboundDate = decodeSkyscannerDate(parts[transportIndex + 4] || '');
      inboundDate = decodeSkyscannerDate(parts[transportIndex + 5] || '');
    } else {
      /*
       * Fallback for layouts without /transport/.
       */
      const dateIndex = parts.findIndex(part => /^\d{6,8}$/.test(part));

      if (dateIndex >= 2) {
        origin = parts[dateIndex - 2] || '';
        destination = parts[dateIndex - 1] || '';
        outboundDate = decodeSkyscannerDate(parts[dateIndex] || '');
        inboundDate = decodeSkyscannerDate(parts[dateIndex + 1] || '');
      }
    }

    return {
      search_url: window.location.href,
      origin: String(origin).toUpperCase(),
      destination: String(destination).toUpperCase(),
      outbound_date: outboundDate,
      inbound_date: inboundDate,
      adults: firstNonEmpty(
        url.searchParams.get('adultsv2'),
        url.searchParams.get('adults'),
        ''
      ),
      children: firstNonEmpty(
        url.searchParams.get('childrenv2'),
        url.searchParams.get('children'),
        ''
      ),
      cabin: firstNonEmpty(
        url.searchParams.get('cabinclass'),
        url.searchParams.get('cabinClass'),
        ''
      )
    };
  }

  function findResultContainer(element) {
    return element.closest('li, article, [role="listitem"]') || element;
  }

  function findCandidateElements() {
    const candidates = new Set();

    /*
     * Skyscanner localizes route URLs and accessibility text.
     *
     * Examples:
     *   /transport/flights/...   (English)
     *   /transport/fluge/...     (German)
     *
     * Any itinerary/config link is a strong signal that its containing
     * element is a flight result card, independent of the localized route
     * word used in the URL.
     */
    document
      .querySelectorAll('a[href*="/config/"]')
      .forEach(element => {
        candidates.add(findResultContainer(element));
      });

    /*
     * Sponsored/result cards do not always expose a config link, so also
     * detect localized accessibility labels.
     */
    document.querySelectorAll('[aria-label]').forEach(element => {
      const label = String(
        element.getAttribute('aria-label') || ''
      );

      if (
        /flight option|total cost|flugoption|gesamtpreis|gesamtkosten/i.test(
          label
        )
      ) {
        candidates.add(findResultContainer(element));
      }
    });

    document.querySelectorAll(
      '[data-testid*="itinerary"],' +
      '[data-testid*="flight-card"],' +
      '[data-testid*="result-card"]'
    ).forEach(element => candidates.add(element));

    return Array.from(candidates).filter(Boolean);
  }

  function extractConfigUrl(element) {
    let link = element.querySelector?.('a[href*="/config/"]');

    if (!link && element.matches?.('a[href*="/config/"]')) {
      link = element;
    }

    if (!link) return '';

    try {
      return new URL(link.href, window.location.origin).href;
    } catch (_) {
      return link.href || '';
    }
  }

  function extractItineraryKey(configUrl) {
    if (!configUrl) return '';

    try {
      const url = new URL(configUrl);
      const match = url.pathname.match(/\/config\/([^/?#]+)/i);

      if (match) return decodeURIComponent(match[1]);
    } catch (_) {
      // Continue to fallback.
    }

    const fallbackMatch = String(configUrl).match(/\/config\/([^/?#]+)/i);

    return fallbackMatch ? decodeURIComponent(fallbackMatch[1]) : '';
  }

  function getResultText(element) {
    const accessibilityLabels = [];

    const isRelevantAccessibilityLabel = label =>
      /flight option|total cost|flugoption|gesamtpreis|gesamtkosten/i.test(
        String(label || '')
      );

    if (element.getAttribute) {
      const own = element.getAttribute('aria-label');

      if (own && isRelevantAccessibilityLabel(own)) {
        accessibilityLabels.push(own);
      }
    }

    element.querySelectorAll?.('[aria-label]').forEach(node => {
      const label = node.getAttribute('aria-label');

      if (label && isRelevantAccessibilityLabel(label)) {
        accessibilityLabels.push(label);
      }
    });

    if (accessibilityLabels.length) {
      return normalizeWhitespace(accessibilityLabels.join(' '));
    }

    return normalizeWhitespace(
      element.innerText || element.textContent || ''
    );
  }

  function extractResult(element) {
    const rawText = getResultText(element);

    if (!rawText || rawText.length < 20) return null;

    const search = getSearchMetadata();
    const configUrl = extractConfigUrl(element);
    const rawItineraryKey = extractItineraryKey(configUrl);

    const price = extractPrice(rawText);
    const totalPrice = extractTotalPrice(rawText);

    const legBlocks = findLegBlocks(rawText);

    const outLeg = extractLeg(
      legBlocks[0] || rawText,
      search.outbound_date,
      search.origin,
      search.destination
    );

    const hasInbound =
      Boolean(search.inbound_date) &&
      legBlocks.length >= 2;

    const inLeg = hasInbound
      ? extractLeg(
          legBlocks[1],
          search.inbound_date,
          outLeg.destination || search.destination,
          outLeg.origin || search.origin
        )
      : {
          origin: '',
          destination: '',
          departure_dt: '',
          arrival_dt: '',
          duration: '',
          stops: '',
          stop_airports: '',
          airlines: '',
          self_transfer: ''
        };

    const keys = buildFriendlyKeys(
      search,
      outLeg,
      inLeg,
      rawItineraryKey
    );

    return {
      dedupe_key: keys.dedupe_key,
      itinerary_key: keys.itinerary_key,
      captured_at_client: new Date().toISOString(),
      source: 'skyscanner',
      search_url: search.search_url,

      origin: outLeg.origin || search.origin,
      destination: outLeg.destination || search.destination,

      out_departure_dt: outLeg.departure_dt,
      out_arrival_dt: outLeg.arrival_dt,
      out_duration: outLeg.duration,
      out_stops: outLeg.stops,
      out_stop_airports: outLeg.stop_airports,
      out_airlines: outLeg.airlines,
      out_self_transfer: outLeg.self_transfer,

      in_departure_dt: inLeg.departure_dt,
      in_arrival_dt: inLeg.arrival_dt,
      in_duration: inLeg.duration,
      in_stops: inLeg.stops,
      in_stop_airports: inLeg.stop_airports,
      in_airlines: inLeg.airlines,
      in_self_transfer: inLeg.self_transfer,

      adults: Number(search.adults || 0) || '',
      children: countChildren(search.children),
      cabin: search.cabin,

      price: price.price,
      total_price: totalPrice,
      currency: price.currency,
      price_text: price.price_text,

      config_url: configUrl,
      raw_text: rawText
    };
  }

  function clearReadyState(reason = '') {
    state.ready = false;
    state.pageCompleted = false;

    if (state.readyTimer) {
      clearTimeout(state.readyTimer);
      state.readyTimer = null;
    }

    if (reason) {
      state.lastStatus = reason;
    }

    updateBadge();
  }

  function canBeReadyNow() {
    const pending = getResultsNeedingSend().length;
    const stableFor =
      Date.now() - Number(state.lastResultChangeAt || 0);

    return (
      !state.sending &&
      pending === 0 &&
      state.discovered.size > 0 &&
      state.lastSuccessfulSendAt > 0 &&
      stableFor >= CONFIG.readyStabilizeMs
    );
  }

  function evaluateReadiness() {
    if (state.lastError) {
      state.ready = false;
      updateBadge();
      return;
    }

    if (canBeReadyNow()) {
      state.ready = true;
      state.pageCompleted = true;
      state.lastStatus = 'All results uploaded';

      if (state.readyTimer) {
        clearTimeout(state.readyTimer);
        state.readyTimer = null;
      }

      updateBadge();
      return;
    }

    state.ready = false;

    if (state.sending) {
      updateBadge();
      return;
    }

    const pending = getResultsNeedingSend().length;

    if (pending > 0) {
      state.lastStatus = state.pageCompleted
        ? 'New results detected'
        : 'Results pending';
      updateBadge();
      return;
    }

    if (
      state.discovered.size > 0 &&
      state.lastSuccessfulSendAt > 0
    ) {
      state.lastStatus = 'Sent — checking for more results';
      scheduleReadyCheck();
    }

    updateBadge();
  }

  function scheduleReadyCheck() {
    if (state.readyTimer) {
      return;
    }

    const stableFor =
      Date.now() - Number(state.lastResultChangeAt || 0);

    const remaining = Math.max(
      25,
      CONFIG.readyStabilizeMs - stableFor
    );

    state.readyTimer = setTimeout(() => {
      state.readyTimer = null;
      evaluateReadiness();
    }, remaining);
  }

  function getReadyVisual() {
    if (state.lastError) {
      return {
        color: '#d93025',
        symbol: '●',
        label: 'Error'
      };
    }

    if (state.pageCompleted) {
      return {
        color: '#188038',
        symbol: '●',
        label: 'Complete'
      };
    }

    if (state.userBypassedLock) {
      return {
        color: '#1a73e8',
        symbol: '●',
        label: 'Override'
      };
    }

    if (state.sending) {
      return {
        color: '#1a73e8',
        symbol: '●',
        label: 'Sending'
      };
    }

    const pending = getResultsNeedingSend().length;

    if (pending > 0) {
      return {
        color: '#f9ab00',
        symbol: '●',
        label: 'Collecting'
      };
    }

    if (state.ready) {
      return {
        color: '#188038',
        symbol: '●',
        label: 'Complete'
      };
    }

    return {
      color: '#f9ab00',
      symbol: '●',
      label: 'Loading'
    };
  }

  function scanPage() {
    const candidates = findCandidateElements();
    state.lastCandidateCount = candidates.length;
    state.lastScanAt = new Date().toLocaleTimeString();
    let changed = 0;

    for (const element of candidates) {
      const result = extractResult(element);
      if (!result) continue;

      /*
       * Compare stable result content only.
       *
       * captured_at_client is deliberately excluded from the comparison;
       * otherwise every periodic scan would look "changed" only because
       * the timestamp is new, causing needless re-sends and inflated
       * seen_count values in the spreadsheet.
       */
      const comparable = {
        ...result,
        captured_at_client: ''
      };

      const serialized = JSON.stringify(comparable);
      const previous = state.discovered.get(result.dedupe_key);

      if (!previous || previous.serialized !== serialized) {
        state.discovered.set(result.dedupe_key, {
          result,
          serialized
        });

        changed++;
      }
    }

    state.lastPendingCount = getResultsNeedingSend().length;

    if (changed > 0) {
      state.lastResultChangeAt = Date.now();

      if (state.readyTimer) {
        clearTimeout(state.readyTimer);
        state.readyTimer = null;
      }

      if (state.lastPendingCount > 0) {
        state.ready = false;
        state.lastStatus = state.pageCompleted
          ? 'New results detected'
          : `Collecting ${state.discovered.size} results`;

        log('New/changed results:', changed, 'total:', state.discovered.size);
        scheduleSend();
      }
    } else if (candidates.length === 0 && state.discovered.size === 0) {
      state.ready = false;
      state.lastStatus = 'Waiting for Skyscanner results';
    }

    evaluateReadiness();
  }

  function scheduleScan() {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(scanPage, CONFIG.scanDelayMs);
  }

  function getResultsNeedingSend() {
    const results = [];

    for (const [key, entry] of state.discovered.entries()) {
      const lastSent = state.sentSnapshot.get(key);

      if (lastSent !== entry.serialized) {
        results.push(entry.result);
      }
    }

    return results;
  }

  function scheduleSend() {
    clearTimeout(state.sendTimer);
    state.sendTimer = setTimeout(sendPendingResults, CONFIG.sendDelayMs);
  }

  function sendPendingResults() {
    if (state.sending) {
      scheduleSend();
      return;
    }

    const pending = getResultsNeedingSend();
    state.lastPendingCount = pending.length;
    updateBadge();

    if (!pending.length) {
      evaluateReadiness();
      return;
    }

    const sinceLastSend = Date.now() - state.lastSendTime;

    if (sinceLastSend < CONFIG.minSendIntervalMs) {
      clearTimeout(state.sendTimer);

      state.sendTimer = setTimeout(
        sendPendingResults,
        CONFIG.minSendIntervalMs - sinceLastSend
      );

      return;
    }

    if (!WEB_APP_URL || WEB_APP_URL.includes('PASTE_')) {
      state.lastStatus = 'Configure WEB_APP_URL';
      updateBadge();
      console.error('[Skyscanner -> Sheets] WEB_APP_URL not configured.');
      return;
    }

    if (!API_KEY || API_KEY.includes('PASTE_')) {
      state.lastStatus = 'Configure API_KEY';
      updateBadge();
      console.error('[Skyscanner -> Sheets] API_KEY not configured.');
      return;
    }

    state.sending = true;
    state.ready = false;
    state.lastSendTime = Date.now();
    state.lastSendAt = new Date().toLocaleTimeString();
    state.lastStatus = `Sending ${pending.length}`;
    state.lastError = '';
    updateBadge();

    const payload = {
      apiKey: API_KEY,
      client: {
        name: 'Skyscanner Tampermonkey Collector',
        version: '1.6.10',
        page: window.location.href,
        sent_at: new Date().toISOString()
      },
      results: pending
    };

    GM_xmlhttpRequest({
      method: 'POST',
      url: WEB_APP_URL,
      headers: {
        'Content-Type': 'application/json'
      },
      data: JSON.stringify(payload),
      timeout: 30000,

      onload(response) {
        state.sending = false;
        state.lastHttpStatus = String(response.status || '');
        state.lastResponse = String(response.responseText || '').slice(0, 500);

        try {
          const body = JSON.parse(response.responseText);

          if (!body.ok) {
            throw new Error(body.error || 'Server returned an error');
          }

          for (const result of pending) {
            if (state.discovered.has(result.dedupe_key)) {
              state.sentSnapshot.set(
                result.dedupe_key,
                JSON.stringify({
                  ...result,
                  captured_at_client: ''
                })
              );
            }
          }

          state.totalServerInserted += Number(body.inserted || 0);
          state.totalServerUpdated += Number(body.updated || 0);
          state.totalServerFiltered += Number(body.filtered || 0);
          state.lastPendingCount = getResultsNeedingSend().length;
          state.lastSuccessfulSendAt = Date.now();
          state.ready = false;
          state.lastStatus = 'Sent — checking for more results';
          state.lastError = '';

          log('Server result:', body);

          if (getResultsNeedingSend().length) {
            scheduleSend();
          }

          evaluateReadiness();
        } catch (error) {
          state.ready = false;
          state.lastStatus = 'Server error';
          state.lastError = String(error && error.message ? error.message : error);
          updateBadge();

          console.error(
            '[Skyscanner -> Sheets]',
            error,
            response.responseText
          );
        }
      },

      onerror(error) {
        state.sending = false;
        state.ready = false;
        state.lastStatus = 'Network error';
        state.lastError = JSON.stringify(error || {});
        updateBadge();
        console.error('[Skyscanner -> Sheets] Network error:', error);
      },

      ontimeout() {
        state.sending = false;
        state.ready = false;
        state.lastStatus = 'Timeout';
        state.lastError = 'POST request timed out after 30 seconds';
        updateBadge();
        console.error('[Skyscanner -> Sheets] Request timeout');
      }
    });
  }

  let badge = null;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let interactionBlocker = null;
  let savedBodyOverflow = '';
  let savedHtmlOverflow = '';
  let scrollLockCaptured = false;

  function isInteractionLocked() {
    return !state.pageCompleted && !state.userBypassedLock;
  }

  function createInteractionBlocker() {
    if (interactionBlocker) return;

    interactionBlocker = document.createElement('div');
    interactionBlocker.id = 'skyscanner-sheet-collector-lock';

    Object.assign(interactionBlocker.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483646',
      background: 'rgba(0, 0, 0, 0.025)',
      cursor: 'wait',
      display: 'none',
      pointerEvents: 'auto'
    });

    interactionBlocker.setAttribute(
      'aria-label',
      'Skyscanner page temporarily locked while results are being captured'
    );

    document.body.appendChild(interactionBlocker);
  }

  function syncInteractionLock() {
    if (!interactionBlocker) return;

    const locked = isInteractionLocked();

    interactionBlocker.style.display = locked ? 'block' : 'none';

    if (locked) {
      if (!scrollLockCaptured) {
        savedBodyOverflow = document.body.style.overflow || '';
        savedHtmlOverflow = document.documentElement.style.overflow || '';
        scrollLockCaptured = true;
      }

      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
    } else if (scrollLockCaptured) {
      document.body.style.overflow = savedBodyOverflow;
      document.documentElement.style.overflow = savedHtmlOverflow;
      scrollLockCaptured = false;
    }
  }

  function blockPageKeyboardWhileLocked(event) {
    if (!isInteractionLocked()) return;

    if (badge && badge.contains(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  document.addEventListener(
    'keydown',
    blockPageKeyboardWhileLocked,
    true
  );

  function createBadge() {
    badge = document.createElement('div');
    badge.id = 'skyscanner-sheet-collector-status';

    Object.assign(badge.style, {
      position: 'fixed',
      right: '14px',
      bottom: '14px',
      zIndex: '2147483647',
      width: 'fit-content',
      minWidth: '220px',
      maxWidth: 'calc(100vw - 28px)',
      padding: '10px 11px',
      background: 'rgba(20, 24, 31, 0.95)',
      color: '#fff',
      border: '1px solid rgba(255,255,255,.25)',
      borderRadius: '10px',
      fontFamily: 'Arial, sans-serif',
      fontSize: '12px',
      lineHeight: '1.45',
      boxShadow: '0 4px 18px rgba(0,0,0,.35)',
      userSelect: 'text'
    });

    document.body.appendChild(badge);
    updateBadge();
  }

  function updateBadge() {
    if (!badge) return;

    syncInteractionLock();

    const visual = getReadyVisual();

    const errorLine = state.lastError
      ? `<div style="margin-top:7px;color:#ffd0d0"><b>Error:</b> ${escapeHtml(state.lastError)}</div>`
      : '';

    const overrideButton = isInteractionLocked()
      ? `
        <div style="margin-top:9px">
          <button
            id="fac2s-override"
            style="cursor:pointer;padding:6px 10px;font-weight:700"
          >Use page anyway</button>
        </div>
      `
      : '';

    badge.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;font-weight:700;font-size:13px;margin-bottom:8px">
        <span style="font-size:19px;line-height:1;color:${visual.color}">${visual.symbol}</span>
        <span>${escapeHtml(visual.label)}</span>
      </div>

      <div style="white-space:nowrap"><b>Status:</b> ${escapeHtml(state.lastStatus)}</div>
      <div><b>Version:</b> ${escapeHtml(CONFIG.scriptVersion)}</div>
      <div><b>Cards detected:</b> ${state.lastCandidateCount}</div>
      <div><b>INS / UPD / REJ:</b> ${state.totalServerInserted} / ${state.totalServerUpdated} / ${state.totalServerFiltered}</div>
      <div style="white-space:nowrap"><b>Backend:</b> ${escapeHtml(state.backendHealth)}</div>
      ${errorLine}
      ${overrideButton}
    `;

    badge.querySelector('#fac2s-override')?.addEventListener(
      'click',
      event => {
        event.preventDefault();
        event.stopPropagation();

        state.userBypassedLock = true;
        state.lastStatus = state.sending
          ? 'UI override active — upload continues'
          : 'UI override active — collection continues';

        syncInteractionLock();
        updateBadge();
      }
    );
  }

  function testBackend() {
    if (!WEB_APP_URL || WEB_APP_URL.includes('PASTE_')) {
      state.backendHealth = 'WEB_APP_URL not configured';
      state.lastStatus = 'Configure WEB_APP_URL';
      updateBadge();
      return;
    }

    state.backendHealth = 'testing...';
    state.lastError = '';
    updateBadge();

    GM_xmlhttpRequest({
      method: 'GET',
      url: WEB_APP_URL,
      timeout: 20000,

      onload(response) {
        state.lastHttpStatus = String(response.status || '');
        state.lastResponse = String(response.responseText || '').slice(0, 500);

        try {
          const body = JSON.parse(response.responseText);

          if (body.ok) {
            state.backendHealth =
              'OK: ' +
              (body.spreadsheet || 'backend') +
              (body.sheet ? ' / ' + body.sheet : '');
          } else {
            state.backendHealth = 'backend returned error';
            state.lastError = body.error || 'Unknown backend error';
          }
        } catch (error) {
          state.backendHealth = 'invalid response';
          state.lastError =
            'GET returned non-JSON: ' +
            String(response.responseText || '').slice(0, 180);
        }

        updateBadge();
      },

      onerror(error) {
        state.backendHealth = 'network error';
        state.lastError = JSON.stringify(error || {});
        updateBadge();
      },

      ontimeout() {
        state.backendHealth = 'timeout';
        state.lastError = 'Backend health check timed out';
        updateBadge();
      }
    });
  }

  function startObserver() {
    const observer = new MutationObserver(() => {
      scheduleScan();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    log('MutationObserver started');
  }

  let lastUrl = window.location.href;

  function watchUrl() {
    setInterval(() => {
      if (window.location.href === lastUrl) return;

      lastUrl = window.location.href;

      log('URL changed:', lastUrl);

      state.discovered.clear();
      state.sentSnapshot.clear();
      state.totalServerInserted = 0;
      state.totalServerUpdated = 0;
      state.totalServerFiltered = 0;
      state.lastCandidateCount = 0;
      state.lastPendingCount = 0;
      state.lastResultChangeAt = Date.now();
      state.lastSuccessfulSendAt = 0;
      state.pageCompleted = false;
      state.userBypassedLock = false;
      clearReadyState('New search — waiting for results');

      setTimeout(scanPage, 2000);
    }, 1000);
  }

  GM_registerMenuCommand('Scan Skyscanner now', () => {
    scanPage();
    sendPendingResults();
  });

  GM_registerMenuCommand('Show collector status', () => {
    alert(
      [
        'Skyscanner -> Google Sheets',
        '',
        `Results found: ${state.discovered.size}`,
        `Inserted: ${state.totalServerInserted}`,
        `Updated: ${state.totalServerUpdated}`,
        `Status: ${state.lastStatus}`
      ].join('\n')
    );
  });

  function init() {
    log('Starting');
    state.lastResultChangeAt = Date.now();
    state.pageCompleted = false;
    state.userBypassedLock = false;
    createInteractionBlocker();
    createBadge();
    clearReadyState('Waiting for Skyscanner results');
    startObserver();
    watchUrl();

    setTimeout(scanPage, 1500);
    setTimeout(testBackend, 2500);
    setInterval(scanPage, 15000);
  }

  // ============================================================
  // LOCAL CONFIGURATION
  // Keep these values when replacing/updating the userscript.
  // ============================================================
  const WEB_APP_URL = 'PASTE_YOUR_GOOGLE_APPS_SCRIPT_EXEC_URL_HERE';
  const API_KEY = 'PASTE_YOUR_API_KEY_HERE';

  init();
})();
