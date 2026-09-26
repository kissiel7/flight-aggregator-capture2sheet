// ==UserScript==
// @name         Skyscanner -> Google Sheets Collector
// @namespace    flight-aggregator-capture2sheet
// @version      1.2.0
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

  const WEB_APP_URL = 'PASTE_YOUR_GOOGLE_APPS_SCRIPT_EXEC_URL_HERE';
  const API_KEY = 'PASTE_YOUR_API_KEY_HERE';

  const CONFIG = {
    scanDelayMs: 2500,
    sendDelayMs: 1500,
    minSendIntervalMs: 4000,
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
    lastStatus: 'Starting',
    lastCandidateCount: 0,
    lastPendingCount: 0,
    lastHttpStatus: '',
    lastResponse: '',
    lastError: '',
    backendHealth: 'not tested',
    lastScanAt: '',
    lastSendAt: ''
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

    const flightsIndex = parts.findIndex(
      part => part.toLowerCase() === 'flights'
    );

    let origin = '';
    let destination = '';
    let outboundDate = '';
    let inboundDate = '';

    if (flightsIndex >= 0) {
      origin = parts[flightsIndex + 1] || '';
      destination = parts[flightsIndex + 2] || '';
      outboundDate = decodeSkyscannerDate(parts[flightsIndex + 3] || '');
      inboundDate = decodeSkyscannerDate(parts[flightsIndex + 4] || '');
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
     * Capture every flight-result / connection card currently rendered
     * by Skyscanner, not only the cheapest or first result. Skyscanner
     * lazy-loads and may virtualize results, so cards that appear later
     * while scrolling are picked up by MutationObserver and accumulated
     * in state.discovered.
     */

    document.querySelectorAll(
      '[aria-label*="Flight option"],' +
      '[aria-label*="Total cost"],' +
      'a[href*="/transport/flights/"][href*="/config/"]'
    ).forEach(element => candidates.add(findResultContainer(element)));

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

    if (element.getAttribute) {
      const own = element.getAttribute('aria-label');
      if (own) accessibilityLabels.push(own);
    }

    element.querySelectorAll?.('[aria-label]').forEach(node => {
      const label = node.getAttribute('aria-label');

      if (
        label &&
        (/flight option/i.test(label) || /total cost/i.test(label))
      ) {
        accessibilityLabels.push(label);
      }
    });

    if (accessibilityLabels.length) {
      return normalizeWhitespace(accessibilityLabels.join(' '));
    }

    return normalizeWhitespace(element.innerText || element.textContent || '');
  }

  function normalizeCurrency(value) {
    const token = String(value || '').trim().toUpperCase();

    if (token === '€') return 'EUR';
    if (token === '$') return 'USD';
    if (token === '£') return 'GBP';
    if (token === 'ZŁ') return 'PLN';

    return token;
  }

  function parseLocalizedNumber(value) {
    let text = String(value || '').replace(/\s/g, '');
    const lastComma = text.lastIndexOf(',');
    const lastDot = text.lastIndexOf('.');

    if (lastComma >= 0 && lastDot >= 0) {
      if (lastComma > lastDot) {
        text = text.replace(/\./g, '').replace(',', '.');
      } else {
        text = text.replace(/,/g, '');
      }
    } else if (lastComma >= 0) {
      const decimals = text.length - lastComma - 1;

      if (decimals === 2) {
        text = text.replace(',', '.');
      } else {
        text = text.replace(/,/g, '');
      }
    } else {
      const pieces = text.split('.');

      if (
        pieces.length > 2 ||
        (pieces.length === 2 && pieces[1].length === 3)
      ) {
        text = text.replace(/\./g, '');
      }
    }

    const number = Number(text);
    return Number.isFinite(number) ? number : '';
  }

  function extractPrice(text) {
    const normalized = normalizeWhitespace(text);

    const patterns = [
      {
        regex: /(?:Total cost|Price)[^\d€$£]*([€$£])\s*([\d.,\s]+)/i,
        symbolFirst: true
      },
      {
        regex: /([€$£])\s*([\d][\d.,\s]*)/,
        symbolFirst: true
      },
      {
        regex: /([\d][\d.,\s]*)\s*(EUR|USD|GBP|PLN|CHF|zł|€|\$|£)/i,
        symbolFirst: false
      },
      {
        regex: /(EUR|USD|GBP|PLN|CHF)\s*([\d][\d.,\s]*)/i,
        symbolFirst: true
      }
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern.regex);
      if (!match) continue;

      const currencyToken = pattern.symbolFirst ? match[1] : match[2];
      const numberToken = pattern.symbolFirst ? match[2] : match[1];

      return {
        price: parseLocalizedNumber(numberToken),
        currency: normalizeCurrency(currencyToken),
        price_text: normalizeWhitespace(match[0])
      };
    }

    return {
      price: '',
      currency: '',
      price_text: ''
    };
  }

  function extractAirlines(text) {
    for (const regex of [/Flight with ([^.]+)\./i, /Operated by ([^.]+)\./i]) {
      const match = text.match(regex);
      if (match) return normalizeWhitespace(match[1]);
    }

    return '';
  }

  function extractTimes(text) {
    const result = {
      depart_time: '',
      arrive_time: ''
    };

    const match = text.match(
      /Departing from .*? at ([0-9]{1,2}:[0-9]{2}(?:\s*[AP]M)?).*?arriving in .*? at ([0-9]{1,2}:[0-9]{2}(?:\s*[AP]M)?)/i
    );

    if (match) {
      result.depart_time = normalizeWhitespace(match[1]);
      result.arrive_time = normalizeWhitespace(match[2]);
      return result;
    }

    const times = Array.from(
      text.matchAll(/\b([0-2]?\d:[0-5]\d)\b/g)
    ).map(matchItem => matchItem[1]);

    if (times.length >= 1) result.depart_time = times[0];
    if (times.length >= 2) result.arrive_time = times[1];

    return result;
  }

  function extractDuration(text) {
    let match = text.match(
      /taking\s+(\d+)\s*hours?\s*(\d+)?\s*minutes?/i
    );

    if (match) {
      return match[1] + 'h ' + (match[2] || '0') + 'm';
    }

    match = text.match(/\b(\d{1,3})h\s*(\d{1,2})m\b/i);

    if (match) {
      return match[1] + 'h ' + match[2] + 'm';
    }

    return '';
  }

  function extractStops(text) {
    if (/\bdirect\b/i.test(text)) return 0;

    const numeric = text.match(/\b(\d+)\s+stops?\b/i);
    if (numeric) return Number(numeric[1]);

    if (/\bone stop\b/i.test(text)) return 1;
    if (/\btwo stops\b/i.test(text)) return 2;
    if (/\bthree stops\b/i.test(text)) return 3;

    return '';
  }

  function extractSelfTransfer(text) {
    return Boolean(
      /self[- ]?transfer/i.test(text) ||
      /change airports/i.test(text)
    );
  }

  function buildQueryKey(search) {
    return [
      search.origin,
      search.destination,
      search.outbound_date,
      search.inbound_date,
      search.adults,
      search.children,
      search.cabin
    ]
      .map(value => normalizeWhitespace(value).toLowerCase())
      .join('|');
  }

  function extractResult(element) {
    const rawText = getResultText(element);

    if (!rawText || rawText.length < 20) return null;

    const search = getSearchMetadata();
    const configUrl = extractConfigUrl(element);

    let itineraryKey = extractItineraryKey(configUrl);

    if (!itineraryKey) {
      itineraryKey =
        'fallback-' + fnv1a(normalizeForFingerprint(rawText));
    }

    const dedupeKey =
      buildQueryKey(search) + '|' + itineraryKey;

    const price = extractPrice(rawText);
    const times = extractTimes(rawText);

    return {
      dedupe_key: dedupeKey,
      itinerary_key: itineraryKey,
      captured_at_client: new Date().toISOString(),
      source: 'skyscanner',
      search_url: search.search_url,
      origin: search.origin,
      destination: search.destination,
      outbound_date: search.outbound_date,
      inbound_date: search.inbound_date,
      adults: search.adults,
      children: search.children,
      cabin: search.cabin,
      price: price.price,
      currency: price.currency,
      price_text: price.price_text,
      airlines: extractAirlines(rawText),
      depart_time: times.depart_time,
      arrive_time: times.arrive_time,
      duration: extractDuration(rawText),
      stops: extractStops(rawText),
      self_transfer: extractSelfTransfer(rawText),
      config_url: configUrl,
      raw_text: rawText
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
    state.lastStatus =
      candidates.length === 0
        ? 'No result cards detected'
        : `Extracted ${state.discovered.size}`;
    updateBadge();

    if (changed > 0) {
      log('New/changed results:', changed, 'total:', state.discovered.size);
      scheduleSend();
    }
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
      state.lastStatus = 'Nothing pending';
      updateBadge();
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
    state.lastSendTime = Date.now();
    state.lastSendAt = new Date().toLocaleTimeString();
    state.lastStatus = `Sending ${pending.length}`;
    state.lastError = '';
    updateBadge();

    const payload = {
      apiKey: API_KEY,
      client: {
        name: 'Skyscanner Tampermonkey Collector',
        version: '1.2.0',
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
          state.lastPendingCount = getResultsNeedingSend().length;
          state.lastStatus =
            `Saved: +${Number(body.inserted || 0)} new, ` +
            `${Number(body.updated || 0)} updated`;
          state.lastError = '';
          updateBadge();

          log('Server result:', body);

          if (getResultsNeedingSend().length) {
            scheduleSend();
          }
        } catch (error) {
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
        state.lastStatus = 'Network error';
        state.lastError = JSON.stringify(error || {});
        updateBadge();
        console.error('[Skyscanner -> Sheets] Network error:', error);
      },

      ontimeout() {
        state.sending = false;
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

  function statusSymbol() {
    if (state.sending) return '↗';
    if (/error|timeout|unauthorized|configure/i.test(state.lastStatus)) return '⚠';
    if (/saved|extracted|nothing pending/i.test(state.lastStatus)) return '✓';
    return '•';
  }

  function createBadge() {
    badge = document.createElement('div');
    badge.id = 'skyscanner-sheet-collector-status';

    Object.assign(badge.style, {
      position: 'fixed',
      right: '14px',
      bottom: '14px',
      zIndex: '2147483647',
      width: '300px',
      padding: '12px',
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

    const pending = getResultsNeedingSend().length;
    state.lastPendingCount = pending;

    const errorLine = state.lastError
      ? `<div style="margin-top:6px;color:#ffd0d0"><b>Error:</b> ${escapeHtml(state.lastError)}</div>`
      : '';

    badge.innerHTML = `
      <div style="font-weight:700;font-size:13px;margin-bottom:7px">
        ${statusSymbol()} Skyscanner → Sheets
      </div>

      <div><b>Status:</b> ${escapeHtml(state.lastStatus)}</div>
      <div><b>Cards detected:</b> ${state.lastCandidateCount}</div>
      <div><b>Results extracted:</b> ${state.discovered.size}</div>
      <div><b>Pending:</b> ${pending}</div>
      <div><b>Inserted / updated:</b> ${state.totalServerInserted} / ${state.totalServerUpdated}</div>
      <div><b>Backend:</b> ${escapeHtml(state.backendHealth)}</div>
      <div><b>HTTP:</b> ${escapeHtml(state.lastHttpStatus || '-')}</div>
      <div><b>Last scan:</b> ${escapeHtml(state.lastScanAt || '-')}</div>
      <div><b>Last send:</b> ${escapeHtml(state.lastSendAt || '-')}</div>
      ${errorLine}

      <div style="display:flex;gap:6px;margin-top:9px">
        <button id="fac2s-scan" style="cursor:pointer;padding:4px 7px">Scan now</button>
        <button id="fac2s-send" style="cursor:pointer;padding:4px 7px">Send now</button>
        <button id="fac2s-test" style="cursor:pointer;padding:4px 7px">Test backend</button>
      </div>
    `;

    badge.querySelector('#fac2s-scan')?.addEventListener('click', event => {
      event.stopPropagation();
      scanPage();
    });

    badge.querySelector('#fac2s-send')?.addEventListener('click', event => {
      event.stopPropagation();
      scanPage();
      sendPendingResults();
    });

    badge.querySelector('#fac2s-test')?.addEventListener('click', event => {
      event.stopPropagation();
      testBackend();
    });
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
      state.lastStatus = 'New search';
      updateBadge();

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
    createBadge();
    startObserver();
    watchUrl();

    setTimeout(scanPage, 1500);
    setTimeout(testBackend, 2500);
    setInterval(scanPage, 15000);
  }

  init();
})();
