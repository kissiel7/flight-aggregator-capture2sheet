// ==UserScript==
// @name         Skyscanner -> Google Sheets Collector
// @namespace    flight-aggregator-capture2sheet
// @version      1.6.1
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
    const patterns = [
      /Flug mit\s+(.+?)\s+Abflug ab/i,
      /Flight with\s+(.+?)\s+Departing from/i,
      /Operated by\s+(.+?)(?=[.,]|$)/i
    ];

    for (const regex of patterns) {
      const match = text.match(regex);

      if (match) {
        return normalizeWhitespace(match[1]);
      }
    }

    return '';
  }

  function extractTimes(text) {
    const result = {
      depart_time: '',
      arrive_time: ''
    };

    const patterns = [
      /Departing from .*? at ([0-9]{1,2}:[0-9]{2}(?:\s*[AP]M)?).*?arriving in .*? at ([0-9]{1,2}:[0-9]{2}(?:\s*[AP]M)?)/i,
      /Abflug ab .*? um ([0-9]{1,2}:[0-9]{2}).*?Ankunft in .*? um ([0-9]{1,2}:[0-9]{2})/i
    ];

    for (const regex of patterns) {
      const match = text.match(regex);

      if (match) {
        result.depart_time = normalizeWhitespace(match[1]);
        result.arrive_time = normalizeWhitespace(match[2]);
        return result;
      }
    }

    const values = Array.from(
      text.matchAll(/\b([0-2]?\d:[0-5]\d)\b/g)
    ).map(matchItem => matchItem[1]);

    if (values.length >= 1) result.depart_time = values[0];
    if (values.length >= 2) result.arrive_time = values[1];

    return result;
  }

  function extractDuration(text) {
    let match = text.match(
      /Flugzeit von\s+(\d+)\s*Stunden?(?:\s+(\d+)\s*Minuten?)?/i
    );

    if (match) {
      return match[1] + 'h ' + (match[2] || '0') + 'm';
    }

    match = text.match(
      /\b(\d{1,3})\s*(?:Std\.|St\.)\s*(?:(\d{1,2})\s*Min\.)?/i
    );

    if (match) {
      return match[1] + 'h ' + (match[2] || '0') + 'm';
    }

    match = text.match(
      /taking\s+(\d+)\s*hours?(?:\s+(\d+)\s*minutes?)?/i
    );

    if (match) {
      return match[1] + 'h ' + (match[2] || '0') + 'm';
    }

    match = text.match(
      /\b(\d{1,3})h\s*(?:(\d{1,2})m)?\b/i
    );

    if (match) {
      return match[1] + 'h ' + (match[2] || '0') + 'm';
    }

    return '';
  }

  function extractStops(text) {
    if (/\bDirektflug\b/i.test(text) || /\bDirekt\b/i.test(text)) {
      return 0;
    }

    let match = text.match(
      /Flug mit\s+(\d+)\s+Zwischenstopps?/i
    );

    if (match) {
      return Number(match[1]);
    }

    if (/Flug mit einem Zwischenstopp/i.test(text)) {
      return 1;
    }

    match = text.match(
      /\b(\d+)\s+Zwischenstopps?\b/i
    );

    if (match) {
      return Number(match[1]);
    }

    match = text.match(
      /\b(\d+)\s+stops?\b/i
    );

    if (match) {
      return Number(match[1]);
    }

    return '';
  }

  function extractSelfTransfer(text) {
    return Boolean(
      /self[- ]?transfer/i.test(text) ||
      /change airports/i.test(text) ||
      /Flug mit eigenem Transfer/i.test(text) ||
      /eigenem Transfer/i.test(text) ||
      /erneut einchecken/i.test(text)
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

  function extractAirportCodes(text, times, fallbackOrigin, fallbackDestination) {
    let origin = fallbackOrigin || '';
    let destination = fallbackDestination || '';

    if (times.depart_time) {
      const departRegex = new RegExp(
        times.depart_time.replace(':', '\\:') + '\\s+([A-Z]{3})\\b'
      );
      const match = text.match(departRegex);
      if (match) origin = match[1];
    }

    if (times.arrive_time) {
      const arriveRegex = new RegExp(
        times.arrive_time.replace(':', '\\:') +
        '(?:\\s+\\+\\d+)?\\s+([A-Z]{3})\\b'
      );
      const matches = Array.from(text.matchAll(new RegExp(arriveRegex.source, 'g')));
      if (matches.length) {
        destination = matches[matches.length - 1][1];
      }
    }

    return { origin, destination };
  }


  function extractTotalPrice(text) {
    const match = text.match(
      /Gesamtpreis\s+([\d.]+(?:,\d{1,2})?)\s*€/i
    ) || text.match(
      /Gesamt\s+([\d.]+(?:,\d{1,2})?)\s*€/i
    );

    if (!match) {
      return '';
    }

    const normalized = match[1]
      .replace(/\./g, '')
      .replace(',', '.');

    const value = Number(normalized);

    return Number.isFinite(value)
      ? value
      : '';
  }

  function shortHash(value, length = 3) {
    const base36 = parseInt(fnv1a(String(value || '')), 16)
      .toString(36)
      .toUpperCase()
      .padStart(length, '0');

    return base36.slice(-length);
  }

  function countChildren(value) {
    const text = normalizeWhitespace(value);

    if (!text) return 0;

    if (/^\d+$/.test(text)) {
      return Number(text);
    }

    return text
      .split(/[|,;]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .length;
  }

  function cabinCode(value) {
    const text = normalizeWhitespace(value).toLowerCase();

    if (text === 'economy') return 'E';
    if (text.includes('premium')) return 'P';
    if (text === 'business') return 'B';
    if (text === 'first') return 'F';

    return text ? text.slice(0, 1).toUpperCase() : 'U';
  }

  function combineDateTime(date, time) {
    if (!date || !time) return '';

    return `${date} ${normalizeWhitespace(time)}`;
  }

  function addDaysIso(date, days) {
    if (!date) return '';

    const parsed = new Date(date + 'T00:00:00Z');

    if (Number.isNaN(parsed.getTime())) {
      return '';
    }

    parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));

    return parsed.toISOString().slice(0, 10);
  }

  function extractArrivalDateForLeg(text, departureDate) {
    if (!departureDate) return '';

    let offset = 0;

    const plusMatch = text.match(/\b\+([1-9]\d*)\s+[A-Z]{3}\b/);

    if (plusMatch) {
      offset = Number(plusMatch[1]) || 0;
    } else if (/einen Tag später/i.test(text)) {
      offset = 1;
    } else if (/zwei Tage später/i.test(text)) {
      offset = 2;
    } else if (/one day later/i.test(text)) {
      offset = 1;
    } else if (/two days later/i.test(text)) {
      offset = 2;
    }

    return addDaysIso(departureDate, offset);
  }

  function findLegBlocks(text) {
    const markers = [];
    const regex = /(?:Abflug ab|Departing from)/gi;
    let match;

    while ((match = regex.exec(text)) !== null) {
      markers.push(match.index);
    }

    if (!markers.length) {
      return [text];
    }

    return markers.map((marker, index) => {
      const previousGerman = text.lastIndexOf('Flug mit ', marker);
      const previousEnglish = text.lastIndexOf('Flight with ', marker);

      let start = Math.max(previousGerman, previousEnglish);

      if (start < 0) {
        start = Math.max(0, marker - 160);
      }

      const nextMarker = markers[index + 1];

      let end = nextMarker === undefined
        ? text.length
        : nextMarker;

      if (nextMarker !== undefined) {
        const nextGerman = text.lastIndexOf('Flug mit ', nextMarker);
        const nextEnglish = text.lastIndexOf('Flight with ', nextMarker);
        const nextStart = Math.max(nextGerman, nextEnglish);

        if (nextStart > marker) {
          end = nextStart;
        }
      }

      return normalizeWhitespace(text.slice(start, end));
    });
  }

  function extractLeg(block, departureDate, fallbackOrigin, fallbackDestination) {
    if (!block || !departureDate) {
      return {
        origin: '',
        destination: '',
        departure_dt: '',
        arrival_dt: '',
        duration: '',
        stops: '',
        airlines: '',
        self_transfer: ''
      };
    }

    const times = extractTimes(block);
    const airports = extractAirportCodes(
      block,
      times,
      fallbackOrigin,
      fallbackDestination
    );

    const arrivalDate = extractArrivalDateForLeg(
      block,
      departureDate
    );

    return {
      origin: airports.origin,
      destination: airports.destination,
      departure_dt: combineDateTime(
        departureDate,
        times.depart_time
      ),
      arrival_dt: combineDateTime(
        arrivalDate || departureDate,
        times.arrive_time
      ),
      duration: extractDuration(block),
      stops: extractStops(block),
      airlines: extractAirlines(block),
      self_transfer: extractSelfTransfer(block)
    };
  }

  function compactDateTime(value) {
    const match = String(value || '').match(
      /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/
    );

    if (!match) return '';

    return (
      match[1].slice(2) +
      match[2] +
      match[3] +
      match[4] +
      match[5]
    );
  }

  function buildFriendlyKeys(search, outLeg, inLeg, rawItineraryKey) {
    const origin = outLeg.origin || search.origin || 'ORG';
    const destination =
      outLeg.destination || search.destination || 'DST';

    const outStamp =
      compactDateTime(outLeg.departure_dt) ||
      String(search.outbound_date || '').replace(/-/g, '').slice(2);

    const inStamp =
      compactDateTime(inLeg.departure_dt) ||
      (search.inbound_date
        ? String(search.inbound_date).replace(/-/g, '').slice(2)
        : '');

    const stableSignature = [
      rawItineraryKey,
      origin,
      destination,
      outLeg.departure_dt,
      outLeg.arrival_dt,
      outLeg.duration,
      outLeg.stops,
      outLeg.airlines,
      inLeg.departure_dt,
      inLeg.arrival_dt,
      inLeg.duration,
      inLeg.stops,
      inLeg.airlines
    ].join('|');

    /*
     * Three base-36 characters are used only as a tie-breaker.
     * The human-readable route and exact departure timestamps already
     * carry most of the uniqueness, so a longer opaque hash adds little.
     */
    const suffix = shortHash(
      rawItineraryKey || stableSignature,
      3
    );

    const readable = [
      `${origin}-${destination}`,
      outStamp,
      inStamp
    ]
      .filter(Boolean)
      .join('_');

    const itineraryKey = `${readable}_${suffix}`;

    const adults = Number(search.adults || 0) || 0;
    const children = countChildren(search.children);

    const dedupeKey =
      itineraryKey +
      `_A${adults}C${children}${cabinCode(search.cabin)}`;

    return {
      itinerary_key: itineraryKey,
      dedupe_key: dedupeKey
    };
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
      out_airlines: outLeg.airlines,
      out_self_transfer: outLeg.self_transfer,

      in_departure_dt: inLeg.departure_dt,
      in_arrival_dt: inLeg.arrival_dt,
      in_duration: inLeg.duration,
      in_stops: inLeg.stops,
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

    if (state.readyTimer) {
      clearTimeout(state.readyTimer);
      state.readyTimer = null;
    }

    if (reason) {
      state.lastStatus = reason;
    }

    updateBadge();
  }

  function scheduleReadyCheck() {
    /*
     * Do not restart an already scheduled readiness check merely because
     * Skyscanner mutated the DOM and triggered another unchanged scan.
     *
     * Skyscanner updates the page very frequently. Restarting a 3.5 s timer
     * on every DOM-driven scan can prevent the green state from ever being
     * reached. Only a real extracted-result change clears/restarts the
     * stabilization period (via clearReadyState / lastResultChangeAt).
     */
    if (state.readyTimer) {
      return;
    }

    const stableFor =
      Date.now() - Number(state.lastResultChangeAt || 0);

    const remaining = Math.max(
      0,
      CONFIG.readyStabilizeMs - stableFor
    );

    state.readyTimer = setTimeout(() => {
      state.readyTimer = null;

      const pending = getResultsNeedingSend();
      const stableNow =
        Date.now() - Number(state.lastResultChangeAt || 0);

      if (
        !state.sending &&
        pending.length === 0 &&
        state.discovered.size > 0 &&
        state.lastSuccessfulSendAt > 0 &&
        stableNow >= CONFIG.readyStabilizeMs
      ) {
        state.ready = true;
        state.lastStatus = 'Complete — safe to leave page';
        updateBadge();
        return;
      }

      if (!state.sending && state.discovered.size > 0) {
        state.lastStatus = 'Waiting for results to settle';
        updateBadge();
      }

      /*
       * If we are not ready because a send is still active or pending,
       * check again without allowing ordinary DOM rescans to postpone us.
       */
      scheduleReadyCheck();
    }, remaining);
  }

  function getReadyVisual() {
    if (state.lastError) {
      return {
        color: '#d93025',
        symbol: '●',
        label: 'Error — keep page open'
      };
    }

    if (state.sending) {
      return {
        color: '#1a73e8',
        symbol: '●',
        label: 'Sending — keep page open'
      };
    }

    if (state.ready) {
      return {
        color: '#188038',
        symbol: '●',
        label: 'Complete — safe to leave page'
      };
    }

    return {
      color: '#f9ab00',
      symbol: '●',
      label: 'Loading / collecting — keep page open'
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
      state.ready = false;

      if (state.readyTimer) {
        clearTimeout(state.readyTimer);
        state.readyTimer = null;
      }

      state.lastStatus = `Collecting ${state.discovered.size} results`;
      log('New/changed results:', changed, 'total:', state.discovered.size);
      scheduleSend();
      scheduleReadyCheck();
    } else if (candidates.length === 0 && state.discovered.size === 0) {
      state.lastStatus = 'Waiting for Skyscanner results';
    } else if (!state.ready && !state.sending) {
      state.lastStatus = 'Waiting for results to settle';
      scheduleReadyCheck();
    }

    updateBadge();
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
        version: '1.6.1',
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
          state.lastSuccessfulSendAt = Date.now();
          state.ready = false;
          state.lastStatus = 'Sent — checking for more results';
          state.lastError = '';
          updateBadge();

          log('Server result:', body);

          if (getResultsNeedingSend().length) {
            scheduleSend();
          } else {
            scheduleReadyCheck();
          }
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

    const visual = getReadyVisual();

    const errorLine = state.lastError
      ? `<div style="margin-top:7px;color:#ffd0d0"><b>Error:</b> ${escapeHtml(state.lastError)}</div>`
      : '';

    badge.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;font-weight:700;font-size:13px;margin-bottom:8px">
        <span style="font-size:19px;line-height:1;color:${visual.color}">${visual.symbol}</span>
        <span>${escapeHtml(visual.label)}</span>
      </div>

      <div><b>Status:</b> ${escapeHtml(state.lastStatus)}</div>
      <div><b>Cards detected:</b> ${state.lastCandidateCount}</div>
      <div><b>Inserted / updated:</b> ${state.totalServerInserted} / ${state.totalServerUpdated}</div>
      <div><b>Backend:</b> ${escapeHtml(state.backendHealth)}</div>
      ${errorLine}

      <div style="display:flex;gap:6px;margin-top:9px">
        <button id="fac2s-scan" style="cursor:pointer;padding:4px 7px">Scan now</button>
        <button id="fac2s-send" style="cursor:pointer;padding:4px 7px">Send now</button>
        <button id="fac2s-test" style="cursor:pointer;padding:4px 7px">Test backend</button>
      </div>
    `;

    badge.querySelector('#fac2s-scan')?.addEventListener('click', event => {
      event.stopPropagation();
      clearReadyState('Manual scan');
      scanPage();
    });

    badge.querySelector('#fac2s-send')?.addEventListener('click', event => {
      event.stopPropagation();
      clearReadyState('Manual send');
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
      state.lastResultChangeAt = Date.now();
      state.lastSuccessfulSendAt = 0;
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
    createBadge();
    clearReadyState('Waiting for Skyscanner results');
    startObserver();
    watchUrl();

    setTimeout(scanPage, 1500);
    setTimeout(testBackend, 2500);
    setInterval(scanPage, 15000);
  }

  init();
})();
