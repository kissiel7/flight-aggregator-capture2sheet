/**
 * Flight Aggregator Capture - Skyscanner Collector Backend
 *
 * Target spreadsheet: exact Google Drive name "Flight Aggregator Capture"
 * Target tab: "Skyscanner Results"
 */

const CONFIG = {
  SPREADSHEET_NAME: 'Flight Aggregator Capture',
  SHEET_NAME: 'Skyscanner Results',
  API_KEY_PROPERTY: 'SKYSCANNER_API_KEY'
};

const HEADERS = [
  'origin',
  'destination',
  'outbound_date',
  'depart_time',
  'inbound_date',
  'arrive_time',
  'duration',
  'stops',
  'price',
  'total_price',
  'currency',
  'airlines',
  'self_transfer',
  'adults',
  'children',
  'cabin',
  'search_url',
  'dedupe_key',
  'itinerary_key',
  'first_seen',
  'last_seen',
  'seen_count',
  'captured_at_client',
  'source',
  'price_text',
  'config_url',
  'raw_text'
];

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
        updated: 0
      });
    }

    const spreadsheet = getSpreadsheetByExactName_();
    const sheet = getOrCreateSheet_(spreadsheet);
    ensureHeaders_(sheet);

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
      updated: updates.length
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
  return HEADERS.map(header => {
    if (
      header === 'first_seen' ||
      header === 'last_seen' ||
      header === 'seen_count'
    ) {
      return '';
    }

    const value = result[header];

    if (value === undefined || value === null) {
      return '';
    }

    if (typeof value === 'object' && !(value instanceof Date)) {
      return JSON.stringify(value);
    }

    return value;
  });
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

  /*
   * Reset data-cell number formats first. This is essential after a
   * column-order migration; otherwise a time/date format left behind by
   * an old column can be applied to a completely different field.
   */
  sheet
    .getRange(2, 1, dataRowCount, HEADERS.length)
    .setNumberFormat('@');

  sheet
    .getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold');

  const column = name => HEADERS.indexOf(name) + 1;

  // Server timestamps are real date/time values.
  sheet
    .getRange(2, column('first_seen'), dataRowCount, 1)
    .setNumberFormat('yyyy-mm-dd hh:mm:ss');

  sheet
    .getRange(2, column('last_seen'), dataRowCount, 1)
    .setNumberFormat('yyyy-mm-dd hh:mm:ss');

  // Numeric fields.
  sheet
    .getRange(2, column('price'), dataRowCount, 1)
    .setNumberFormat('#,##0.00');

  sheet
    .getRange(2, column('total_price'), dataRowCount, 1)
    .setNumberFormat('#,##0.00');

  for (const name of ['stops', 'adults', 'children', 'seen_count']) {
    sheet
      .getRange(2, column(name), dataRowCount, 1)
      .setNumberFormat('0');
  }

  // Explicitly keep route/date/time fields as text.
  for (const name of [
    'origin',
    'destination',
    'outbound_date',
    'depart_time',
    'inbound_date',
    'arrive_time',
    'duration',
    'cabin',
    'currency',
    'airlines',
    'captured_at_client'
  ]) {
    sheet
      .getRange(2, column(name), dataRowCount, 1)
      .setNumberFormat('@');
  }

  sheet.setColumnWidth(column('origin'), 80);
  sheet.setColumnWidth(column('destination'), 100);
  sheet.setColumnWidth(column('price'), 90);
  sheet.setColumnWidth(column('total_price'), 100);
  sheet.setColumnWidth(column('currency'), 70);
  sheet.setColumnWidth(column('airlines'), 180);
  sheet.setColumnWidth(column('search_url'), 250);
  sheet.setColumnWidth(column('config_url'), 250);
  sheet.setColumnWidth(column('raw_text'), 400);
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
