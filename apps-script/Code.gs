/**
 * Flight Aggregator Capture - Skyscanner Collector Backend
 *
 * Target spreadsheet: exact Google Drive name "Flight Aggregator Capture"
 * Target tab: "Skyscanner Results"
 */

const CONFIG = {
  SPREADSHEET_NAME: 'Flight Aggregator Capture',
  SHEET_NAME: 'Skyscanner Results',
  FILTER_SHEET_NAME: 'Filters',
  API_KEY_PROPERTY: 'SKYSCANNER_API_KEY'
};

const NUMERIC_FIELDS = new Set([
  'out_stops',
  'in_stops',
  'price',
  'total_price',
  'adults',
  'children'
]);

const BOOLEAN_FIELDS = new Set([
  'out_self_transfer',
  'in_self_transfer'
]);

const SCHEMA = [
  { header: 'Org', field: 'origin' },
  { header: 'Dst', field: 'destination' },

  { header: 'Out_DayTimeD', field: 'out_departure_dt' },
  { header: 'Out_DayTimeL', field: 'out_arrival_dt' },
  { header: 'Out_Dur', field: 'out_duration' },
  { header: 'Out_Stop', field: 'out_stops' },
  { header: 'Out_Airlines', field: 'out_airlines' },
  { header: 'Out_Self_T', field: 'out_self_transfer' },

  { header: 'In_DayTimeD', field: 'in_departure_dt' },
  { header: 'In_DayTimeL', field: 'in_arrival_dt' },
  { header: 'In_Dur', field: 'in_duration' },
  { header: 'In_Stop', field: 'in_stops' },
  { header: 'In_Airlines', field: 'in_airlines' },
  { header: 'In_Self_T', field: 'in_self_transfer' },

  { header: 'Price_PP', field: 'price' },
  { header: 'Price_Total', field: 'total_price' },
  { header: 'Curr', field: 'currency' },
  { header: 'AD', field: 'adults' },
  { header: 'CH', field: 'children' },
  { header: 'cabin', field: 'cabin' },

  { header: 'Search_URL', field: 'search_url' },
  { header: 'source', field: 'source' },
  { header: 'first_seen', field: 'first_seen' },
  { header: 'last_seen', field: 'last_seen' },
  { header: 'seen_count', field: 'seen_count' },
  { header: 'captured_at_client', field: 'captured_at_client' },
  { header: 'price_text', field: 'price_text' },
  { header: 'dedupe_key', field: 'dedupe_key' },
  { header: 'itinerary_key', field: 'itinerary_key' },
  { header: 'config_url', field: 'config_url' },
  { header: 'raw_text', field: 'raw_text' }
];

const HEADERS = SCHEMA.map(column => column.header);

function setupSkyscannerCollector() {
  const spreadsheet = getSpreadsheetByExactName_();
  const properties = PropertiesService.getScriptProperties();

  let apiKey = properties.getProperty(CONFIG.API_KEY_PROPERTY);

  if (!apiKey) {
    apiKey = Utilities.getUuid().replace(/-/g, '');
    properties.setProperty(CONFIG.API_KEY_PROPERTY, apiKey);
  }

  const sheet = getOrCreateSheet_(spreadsheet);
  ensureHeaders_(sheet);
  formatSheet_(sheet);

  console.log('');
  console.log('================================================');
  console.log('Flight Aggregator Capture configured');
  console.log('================================================');
  console.log('Spreadsheet:');
  console.log(spreadsheet.getName());
  console.log('Destination tab:');
  console.log(CONFIG.SHEET_NAME);
  console.log('API KEY:');
  console.log(apiKey);
  console.log('Copy this API key into the Tampermonkey script.');
  console.log('================================================');

  return {
    ok: true,
    spreadsheetName: spreadsheet.getName(),
    sheetName: CONFIG.SHEET_NAME,
    apiKey
  };
}

function doGet() {
  try {
    const spreadsheet = getSpreadsheetByExactName_();

    return jsonResponse_({
      ok: true,
      service: 'flight-aggregator-skyscanner-collector',
      spreadsheet: spreadsheet.getName(),
      sheet: CONFIG.SHEET_NAME
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    const payload = parsePayload_(e);
    validateApiKey_(payload);

    if (!Array.isArray(payload.results)) {
      throw new Error('results must be an array');
    }

    if (payload.results.length === 0) {
      return jsonResponse_({
        ok: true,
        received: 0,
        uniqueReceived: 0,
        inserted: 0,
        updated: 0,
        filtered: 0
      });
    }

    const spreadsheet = getSpreadsheetByExactName_();
    const sheet = getOrCreateSheet_(spreadsheet);
    ensureHeaders_(sheet);
    const filters = readFilters_(spreadsheet);

    // Deduplicate within the request.
    const incomingMap = new Map();

    payload.results.forEach(result => {
      if (!result || !result.dedupe_key) return;
      incomingMap.set(String(result.dedupe_key), result);
    });

    const incoming = Array.from(incomingMap.values());

    // Read existing rows once.
    const lastRow = sheet.getLastRow();
    let existingRows = [];

    if (lastRow >= 2) {
      existingRows = sheet
        .getRange(2, 1, lastRow - 1, HEADERS.length)
        .getValues();
    }

    const keyColumn = HEADERS.indexOf('dedupe_key');
    const firstSeenColumn = HEADERS.indexOf('first_seen');
    const lastSeenColumn = HEADERS.indexOf('last_seen');
    const seenCountColumn = HEADERS.indexOf('seen_count');

    const existingMap = new Map();

    existingRows.forEach((row, index) => {
      const key = String(row[keyColumn] || '');
      if (!key) return;

      existingMap.set(key, {
        rowNumber: index + 2,
        values: row
      });
    });

    const serverNow = new Date();
    const newRows = [];
    const updates = [];
    let filtered = 0;
    const filteredByReason = {};

    incoming.forEach(result => {
      const key = String(result.dedupe_key);
      const existing = existingMap.get(key);
      const row = resultToRow_(result);

      if (existing) {
        row[firstSeenColumn] = existing.values[firstSeenColumn] || serverNow;
        row[lastSeenColumn] = serverNow;
        row[seenCountColumn] =
          (Number(existing.values[seenCountColumn]) || 0) + 1;

        updates.push({
          rowNumber: existing.rowNumber,
          values: row
        });
      } else {
        const filterDecision = matchesFilters_(result, filters);

        if (!filterDecision.pass) {
          filtered++;
          const reason = filterDecision.reason || 'filtered';
          filteredByReason[reason] =
            (filteredByReason[reason] || 0) + 1;
          return;
        }

        row[firstSeenColumn] = serverNow;
        row[lastSeenColumn] = serverNow;
        row[seenCountColumn] = 1;
        newRows.push(row);
      }
    });

    updates.forEach(update => {
      sheet
        .getRange(update.rowNumber, 1, 1, HEADERS.length)
        .setValues([update.values]);
    });

    if (newRows.length > 0) {
      const startRow = sheet.getLastRow() + 1;

      sheet
        .getRange(startRow, 1, newRows.length, HEADERS.length)
        .setValues(newRows);
    }

    SpreadsheetApp.flush();

    return jsonResponse_({
      ok: true,
      spreadsheet: spreadsheet.getName(),
      sheet: CONFIG.SHEET_NAME,
      received: payload.results.length,
      uniqueReceived: incoming.length,
      inserted: newRows.length,
      updated: updates.length,
      filtered,
      filteredByReason,
      activeFilters: filters.active
    });
  } catch (error) {
    console.error(error);

    return jsonResponse_({
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
  } finally {
    try {
      lock.releaseLock();
    } catch (_) {
      // Ignore.
    }
  }
}

function getSpreadsheetByExactName_() {
  const files = DriveApp.getFilesByName(CONFIG.SPREADSHEET_NAME);
  const matches = [];

  while (files.hasNext()) {
    const file = files.next();

    if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
      matches.push(file);
    }
  }

  if (matches.length === 0) {
    throw new Error(
      'Google Sheet not found with exact name: "' +
      CONFIG.SPREADSHEET_NAME +
      '".'
    );
  }

  if (matches.length > 1) {
    throw new Error(
      'More than one Google Sheet exists with exact name "' +
      CONFIG.SPREADSHEET_NAME +
      '". Rename duplicates so the name is unique.'
    );
  }

  return SpreadsheetApp.open(matches[0]);
}

function resultToRow_(result) {
  return SCHEMA.map(column => {
    const header = column.header;
    const field = column.field;

    if (
      header === 'first_seen' ||
      header === 'last_seen' ||
      header === 'seen_count'
    ) {
      return '';
    }

    const value = result[field];

    if (value === undefined || value === null || value === '') {
      return '';
    }

    if (NUMERIC_FIELDS.has(field)) {
      const numeric = toFiniteNumber_(value);
      return numeric === null ? '' : numeric;
    }

    if (BOOLEAN_FIELDS.has(field)) {
      return toBoolean_(value);
    }

    if (typeof value === 'object' && !(value instanceof Date)) {
      return JSON.stringify(value);
    }

    return value;
  });
}

function readFilters_(spreadsheet) {
  const defaults = {
    maxInboundStops: null,
    maxOutboundStops: null,
    maxPricePP: null,
    maxTotalPrice: null,
    selfTransferAllowed: null,
    active: []
  };

  const sheet = spreadsheet.getSheetByName(CONFIG.FILTER_SHEET_NAME);

  if (!sheet || sheet.getLastRow() === 0) {
    return defaults;
  }

  const rows = sheet
    .getRange(1, 1, sheet.getLastRow(), 2)
    .getDisplayValues();

  rows.forEach(row => {
    const label = String(row[0] || '').trim().toLowerCase();
    const raw = String(row[1] || '').trim();

    if (!label || raw === '') {
      return;
    }

    if (label === 'max. inbound stops') {
      defaults.maxInboundStops =
        parseRequiredFilterNumber_(raw, row[0]);
      defaults.active.push(row[0]);
      return;
    }

    if (label === 'max. outbound stops') {
      defaults.maxOutboundStops =
        parseRequiredFilterNumber_(raw, row[0]);
      defaults.active.push(row[0]);
      return;
    }

    if (label === 'max pp price') {
      defaults.maxPricePP =
        parseRequiredFilterNumber_(raw, row[0]);
      defaults.active.push(row[0]);
      return;
    }

    if (label === 'max total price') {
      defaults.maxTotalPrice =
        parseRequiredFilterNumber_(raw, row[0]);
      defaults.active.push(row[0]);
      return;
    }

    if (label === 'self transfer') {
      defaults.selfTransferAllowed =
        parseSelfTransferFilter_(raw);
      defaults.active.push(row[0]);
    }
  });

  return defaults;
}

function parseRequiredFilterNumber_(value, label) {
  const number = parseLocaleNumber_(value);

  if (number === null || number < 0) {
    throw new Error(
      'Invalid value in Filters for "' +
      label +
      '": "' +
      value +
      '". Expected a non-negative number.'
    );
  }

  return number;
}

function parseLocaleNumber_(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  let text = String(value || '')
    .trim()
    .replace(/\s/g, '');

  if (!text) {
    return null;
  }

  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');

  if (comma >= 0 && dot >= 0) {
    if (comma > dot) {
      text = text.replace(/\./g, '').replace(',', '.');
    } else {
      text = text.replace(/,/g, '');
    }
  } else if (comma >= 0) {
    text = text.replace(',', '.');
  }

  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function parseSelfTransferFilter_(value) {
  const normalized = String(value || '').trim().toLowerCase();

  if (
    ['true', 'yes', 'y', '1', 'allow', 'allowed'].includes(normalized)
  ) {
    return true;
  }

  if (
    [
      'false',
      'no',
      'n',
      '0',
      'exclude',
      'excluded',
      'disallow',
      'not allowed'
    ].includes(normalized)
  ) {
    return false;
  }

  throw new Error(
    'Invalid value in Filters for "Self transfer": "' +
    value +
    '". Use TRUE/ALLOW or FALSE/EXCLUDE.'
  );
}

function matchesFilters_(result, filters) {
  if (filters.maxOutboundStops !== null) {
    const stops = toFiniteNumber_(result.out_stops);

    if (stops === null) {
      return { pass: false, reason: 'outbound_stops_missing' };
    }

    if (stops > filters.maxOutboundStops) {
      return { pass: false, reason: 'outbound_stops' };
    }
  }

  const hasInbound =
    Boolean(result.in_departure_dt) ||
    Boolean(result.in_arrival_dt);

  if (
    hasInbound &&
    filters.maxInboundStops !== null
  ) {
    const stops = toFiniteNumber_(result.in_stops);

    if (stops === null) {
      return { pass: false, reason: 'inbound_stops_missing' };
    }

    if (stops > filters.maxInboundStops) {
      return { pass: false, reason: 'inbound_stops' };
    }
  }

  if (filters.maxPricePP !== null) {
    const price = toFiniteNumber_(result.price);

    if (price === null) {
      return { pass: false, reason: 'price_pp_missing' };
    }

    if (price > filters.maxPricePP) {
      return { pass: false, reason: 'price_pp' };
    }
  }

  if (filters.maxTotalPrice !== null) {
    const price = toFiniteNumber_(result.total_price);

    if (price === null) {
      return { pass: false, reason: 'price_total_missing' };
    }

    if (price > filters.maxTotalPrice) {
      return { pass: false, reason: 'price_total' };
    }
  }

  if (filters.selfTransferAllowed === false) {
    if (
      toBoolean_(result.out_self_transfer) ||
      toBoolean_(result.in_self_transfer)
    ) {
      return { pass: false, reason: 'self_transfer' };
    }
  }

  return { pass: true, reason: '' };
}

function toFiniteNumber_(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  return parseLocaleNumber_(value);
}

function toBoolean_(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value || '').trim().toLowerCase();

  return ['true', '1', 'yes', 'y'].includes(normalized);
}

function validateApiKey_(payload) {
  const expected = PropertiesService
    .getScriptProperties()
    .getProperty(CONFIG.API_KEY_PROPERTY);

  if (!expected) {
    throw new Error(
      'API key has not been configured. Run setupSkyscannerCollector() first.'
    );
  }

  if (!payload || String(payload.apiKey || '') !== String(expected)) {
    throw new Error('Unauthorized');
  }
}

function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Empty POST body');
  }

  try {
    return JSON.parse(e.postData.contents);
  } catch (error) {
    throw new Error('Invalid JSON body: ' + error.message);
  }
}

function getOrCreateSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(CONFIG.SHEET_NAME);
  }

  return sheet;
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet
      .getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS]);

    sheet.setFrozenRows(1);
    return;
  }

  const lastColumn = Math.max(sheet.getLastColumn(), HEADERS.length);

  const currentHeaders = sheet
    .getRange(1, 1, 1, lastColumn)
    .getValues()[0]
    .map(value => String(value || '').trim());

  const populatedHeaders = currentHeaders.filter(Boolean);

  const exactMatch =
    populatedHeaders.length === HEADERS.length &&
    HEADERS.every((header, index) => populatedHeaders[index] === header);

  if (exactMatch) {
    sheet.setFrozenRows(1);
    return;
  }

  /*
   * Safe automatic migration:
   *
   * If the existing table contains exactly the same named columns but in
   * another order, rewrite the table into the preferred HEADERS order.
   * Data is mapped by header name, so no values are lost.
   */
  const currentSet = new Set(populatedHeaders);
  const targetSet = new Set(HEADERS);

  const sameColumns =
    currentSet.size === HEADERS.length &&
    targetSet.size === HEADERS.length &&
    HEADERS.every(header => currentSet.has(header));

  if (sameColumns) {
    reorderExistingTable_(sheet, populatedHeaders);
    sheet.setFrozenRows(1);
    formatSheet_(sheet);
    return;
  }

  /*
   * Empty / header-only tabs may be repaired directly.
   */
  if (sheet.getLastRow() <= 1) {
    sheet.clearContents();

    sheet
      .getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS]);

    sheet.setFrozenRows(1);
    return;
  }

  throw new Error(
    'The existing "' +
    CONFIG.SHEET_NAME +
    '" tab contains a different set of columns. No data was changed.'
  );
}

function reorderExistingTable_(sheet, currentHeaders) {
  const lastRow = sheet.getLastRow();
  const oldColumnCount = currentHeaders.length;

  const rows =
    lastRow > 1
      ? sheet
          .getRange(2, 1, lastRow - 1, oldColumnCount)
          .getValues()
      : [];

  const indexByHeader = new Map();

  currentHeaders.forEach((header, index) => {
    if (header) {
      indexByHeader.set(header, index);
    }
  });

  const reorderedRows = rows.map(row =>
    HEADERS.map(header => {
      const sourceIndex = indexByHeader.get(header);
      return sourceIndex === undefined ? '' : row[sourceIndex];
    })
  );

  sheet
    .getRange(1, 1, Math.max(lastRow, 1), Math.max(oldColumnCount, HEADERS.length))
    .clearContent()
    .clearFormat();

  sheet
    .getRange(1, 1, 1, HEADERS.length)
    .setValues([HEADERS]);

  if (reorderedRows.length > 0) {
    sheet
      .getRange(2, 1, reorderedRows.length, HEADERS.length)
      .setValues(reorderedRows);
  }
}

function formatSheet_(sheet) {
  sheet.setFrozenRows(1);

  const dataRowCount = Math.max(sheet.getMaxRows() - 1, 1);
  const column = name => HEADERS.indexOf(name) + 1;

  sheet
    .getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold');

  const textColumns = [
    'Org',
    'Dst',
    'Out_DayTimeD',
    'Out_DayTimeL',
    'Out_Dur',
    'Out_Airlines',
    'In_DayTimeD',
    'In_DayTimeL',
    'In_Dur',
    'In_Airlines',
    'Curr',
    'cabin',
    'Search_URL',
    'source',
    'captured_at_client',
    'price_text',
    'dedupe_key',
    'itinerary_key',
    'config_url',
    'raw_text'
  ];

  textColumns.forEach(name => {
    sheet
      .getRange(2, column(name), dataRowCount, 1)
      .setNumberFormat('@');
  });

  for (const name of ['Price_PP', 'Price_Total']) {
    sheet
      .getRange(2, column(name), dataRowCount, 1)
      .setNumberFormat('#,##0.00');
  }

  for (const name of ['Out_Stop', 'In_Stop', 'AD', 'CH', 'seen_count']) {
    sheet
      .getRange(2, column(name), dataRowCount, 1)
      .setNumberFormat('0');
  }

  sheet
    .getRange(2, column('first_seen'), dataRowCount, 1)
    .setNumberFormat('yyyy-mm-dd hh:mm:ss');

  sheet
    .getRange(2, column('last_seen'), dataRowCount, 1)
    .setNumberFormat('yyyy-mm-dd hh:mm:ss');

  const widths = {
    Org: 55,
    Dst: 55,
    Out_DayTimeD: 118,
    Out_DayTimeL: 118,
    Out_Dur: 68,
    Out_Stop: 50,
    Out_Airlines: 120,
    Out_Self_T: 58,
    In_DayTimeD: 118,
    In_DayTimeL: 118,
    In_Dur: 68,
    In_Stop: 50,
    In_Airlines: 120,
    In_Self_T: 58,
    Price_PP: 76,
    Price_Total: 86,
    Curr: 52,
    AD: 38,
    CH: 38,
    cabin: 68,
    Search_URL: 180,
    source: 75,
    first_seen: 125,
    last_seen: 125,
    seen_count: 68,
    captured_at_client: 145,
    price_text: 82,
    dedupe_key: 210,
    itinerary_key: 185,
    config_url: 180,
    raw_text: 320
  };

  Object.entries(widths).forEach(([name, width]) => {
    sheet.setColumnWidth(column(name), width);
  });
}

function jsonResponse_(object) {
  return ContentService
    .createTextOutput(JSON.stringify(object))
    .setMimeType(ContentService.MimeType.JSON);
}

function testSpreadsheetConnection() {
  const spreadsheet = getSpreadsheetByExactName_();

  console.log('Found spreadsheet: ' + spreadsheet.getName());
  console.log('URL: ' + spreadsheet.getUrl());
  console.log(
    'Available tabs: ' +
    spreadsheet.getSheets().map(sheet => sheet.getName()).join(', ')
  );

  return {
    ok: true,
    name: spreadsheet.getName()
  };
}
