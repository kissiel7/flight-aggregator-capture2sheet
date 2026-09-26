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
  'dedupe_key',
  'itinerary_key',
  'first_seen',
  'last_seen',
  'seen_count',
  'captured_at_client',
  'source',
  'search_url',
  'origin',
  'destination',
  'outbound_date',
  'inbound_date',
  'adults',
  'children',
  'cabin',
  'price',
  'currency',
  'price_text',
  'airlines',
  'depart_time',
  'arrive_time',
  'duration',
  'stops',
  'self_transfer',
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

  const currentHeaders = sheet
    .getRange(1, 1, 1, HEADERS.length)
    .getValues()[0];

  const different = HEADERS.some(
    (header, index) => currentHeaders[index] !== header
  );

  if (different && sheet.getLastRow() > 1) {
    throw new Error(
      'The existing "' +
      CONFIG.SHEET_NAME +
      '" tab has a different column structure. No data was changed.'
    );
  }

  if (different) {
    sheet
      .getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS]);
  }

  sheet.setFrozenRows(1);
}

function formatSheet_(sheet) {
  sheet.setFrozenRows(1);

  sheet
    .getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold');

  const dataRowCount = Math.max(sheet.getMaxRows() - 1, 1);

  const firstSeenColumn = HEADERS.indexOf('first_seen') + 1;
  const lastSeenColumn = HEADERS.indexOf('last_seen') + 1;
  const priceColumn = HEADERS.indexOf('price') + 1;

  sheet
    .getRange(2, firstSeenColumn, dataRowCount, 1)
    .setNumberFormat('yyyy-mm-dd hh:mm:ss');

  sheet
    .getRange(2, lastSeenColumn, dataRowCount, 1)
    .setNumberFormat('yyyy-mm-dd hh:mm:ss');

  sheet
    .getRange(2, priceColumn, dataRowCount, 1)
    .setNumberFormat('#,##0.00');

  sheet.setColumnWidth(HEADERS.indexOf('origin') + 1, 80);
  sheet.setColumnWidth(HEADERS.indexOf('destination') + 1, 100);
  sheet.setColumnWidth(HEADERS.indexOf('price') + 1, 90);
  sheet.setColumnWidth(HEADERS.indexOf('currency') + 1, 70);
  sheet.setColumnWidth(HEADERS.indexOf('airlines') + 1, 180);
  sheet.setColumnWidth(HEADERS.indexOf('search_url') + 1, 250);
  sheet.setColumnWidth(HEADERS.indexOf('config_url') + 1, 250);
  sheet.setColumnWidth(HEADERS.indexOf('raw_text') + 1, 400);
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
