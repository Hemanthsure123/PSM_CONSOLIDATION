/**
 * PSM shortlisting automation — the Google Sheets side.
 *
 * Bound to the coordination spreadsheet (Extensions → Apps Script). Typing "start" in a row's
 * "Trigger" cell sends that row to the app, which plans, screens, evaluates, validates and
 * delivers the shortlist to psm_final_shortlisted_<date> in the row's Internal Sheets
 * spreadsheet, writing its progress to "Automation Status" / "Automation Details".
 *
 * One-time setup (docs/automation.md):
 *   1. Project Settings → Script properties: APP_URL and AUTOMATION_TOKEN.
 *   2. Run `setup` once and allow the permissions it asks for.
 *
 * This script never sees candidate data: it sends the row number and a request id; the app
 * reads the row itself. Its token is kept in Script properties, not in this code.
 */

var CONTROL_TAB = 'Profile Shortlisting - New';
var HEADERS = {
  instructions: 'Screening Instructions',
  trigger: 'Trigger',
  status: 'Automation Status',
  details: 'Automation Details',
};
var ACTIVE = ['PENDING', 'PROCESSING'];
/** How long to wait for a sleeping server to wake (Apps Script runs may last 6 minutes). */
var WAKE_SECONDS = 240;

// ── Setup ────────────────────────────────────────────────────────────────────

/** Run once: adds the four columns (if missing), the Trigger dropdown, and the two triggers. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('APP_URL') || !props.getProperty('AUTOMATION_TOKEN')) {
    throw new Error('Set APP_URL and AUTOMATION_TOKEN in Project Settings → Script properties first.');
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONTROL_TAB);
  if (!sheet) throw new Error('No tab named "' + CONTROL_TAB + '".');
  var headerRow = findHeaderRow_(sheet);
  var width = Math.max(sheet.getLastColumn(), 1);
  var head = sheet.getRange(headerRow, 1, 1, width).getValues()[0].map(clean_);
  var last = lastNonEmpty_(head);
  ['instructions', 'trigger', 'status', 'details'].forEach(function (key) {
    if (head.indexOf(clean_(HEADERS[key])) >= 0) return;
    last += 1;
    if (last > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), last - sheet.getMaxColumns());
    sheet.getRange(headerRow, last).setValue(HEADERS[key]).setFontWeight('bold');
    head[last - 1] = clean_(HEADERS[key]);
  });
  var cols = columns_(sheet);
  sheet.getRange(cols.headerRow, cols.instructions).setNote(
    'One item per line, for example:\nSubsheets: Edge Applied, Academy Applied\nFocus: Flutter developers who shipped apps\nGitHub: (domain-fit candidates)   or (all candidates) / no\nDSA: yes   or no / CF 1400 / 300 solved\nTop: 10   (optional; else No. of Profiles Required)'
  );
  sheet.getRange(cols.headerRow, cols.trigger).setNote('Type start to run the shortlisting for this row. Type start again later to re-run it.');
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(['start'], true).setAllowInvalid(true).build();
  sheet.getRange(cols.headerRow + 1, cols.trigger, Math.max(sheet.getMaxRows() - cols.headerRow, 1), 1).setDataValidation(rule);
  sheet.getRange(cols.headerRow + 1, cols.details, Math.max(sheet.getMaxRows() - cols.headerRow, 1), 1).setWrap(true);

  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'onEditTrigger' || fn === 'sweep') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onEditTrigger').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('sweep').timeBased().everyMinutes(5).create();
  var ok = wakeServer_(60);
  SpreadsheetApp.getActive().toast(ok ? 'Automation is set up and the app answered.' : 'Automation is set up. The app is waking up — that can take a minute.', 'PSM automation', 8);
}

// ── Triggers ─────────────────────────────────────────────────────────────────

/** Installable on-edit trigger: "start" in a Trigger cell queues that row. */
function onEditTrigger(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (sheet.getName() !== CONTROL_TAB) return;
  var cols = columns_(sheet);
  if (!cols) return;
  var c0 = e.range.getColumn();
  var c1 = c0 + e.range.getNumColumns() - 1;
  if (cols.trigger < c0 || cols.trigger > c1) return;
  var r0 = Math.max(e.range.getRow(), cols.headerRow + 1);
  var r1 = e.range.getRow() + e.range.getNumRows() - 1;
  if (r1 < r0) return;

  var queued = [];
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) return;
  try {
    var n = r1 - r0 + 1;
    var triggers = sheet.getRange(r0, cols.trigger, n, 1).getValues();
    var statuses = sheet.getRange(r0, cols.status, n, 1).getValues();
    var instructions = sheet.getRange(r0, cols.instructions, n, 1).getValues();
    for (var i = 0; i < n; i++) {
      if (clean_(triggers[i][0]) !== 'start') continue;
      var row = r0 + i;
      var status = String(statuses[i][0]).trim().toUpperCase();
      if (ACTIVE.indexOf(status) >= 0) {
        SpreadsheetApp.getActive().toast('Row ' + row + ' is already running — this start was ignored.', 'PSM automation', 6);
        continue;
      }
      if (!String(instructions[i][0]).trim()) {
        setStatus_(sheet, cols, row, 'FAILED', 'Add Screening Instructions first, then type start again.');
        continue;
      }
      var requestId = Utilities.getUuid();
      setStatus_(sheet, cols, row, 'PENDING', 'Waiting for the app to wake up · request ' + requestId);
      queued.push({ row: row, requestId: requestId });
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  if (!queued.length) return;
  if (!wakeServer_(WAKE_SECONDS)) return; // the 5-minute sweep sends them once the app answers
  queued.forEach(function (q) {
    submit_(sheet, cols, q.row, q.requestId);
  });
}

/**
 * Every 5 minutes: rows still waiting for the app are sent again, and running jobs are checked
 * (which also keeps a sleeping server awake while it works). Does nothing — and wakes nothing —
 * when no row is PENDING or PROCESSING.
 */
function sweep() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONTROL_TAB);
  if (!sheet) return;
  var cols = columns_(sheet);
  if (!cols) return;
  var last = sheet.getLastRow();
  if (last <= cols.headerRow) return;
  var n = last - cols.headerRow;
  var statuses = sheet.getRange(cols.headerRow + 1, cols.status, n, 1).getValues();
  var details = sheet.getRange(cols.headerRow + 1, cols.details, n, 1).getValues();
  var work = [];
  for (var i = 0; i < n; i++) {
    var s = String(statuses[i][0]).trim().toUpperCase();
    if (ACTIVE.indexOf(s) >= 0) work.push({ row: cols.headerRow + 1 + i, status: s, details: String(details[i][0]) });
  }
  if (!work.length) return;
  if (!wakeServer_(WAKE_SECONDS)) return;
  work.forEach(function (w) {
    var job = w.details.match(/job ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    var request = w.details.match(/request ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (job) {
      var res = api_('get', '/api/automation/jobs/' + job[1]);
      // The app writes its own status; this only catches up a row whose last write was lost.
      if (res.code === 200 && res.body && res.body.job && res.body.job.status !== w.status) {
        setStatus_(sheet, cols, w.row, res.body.job.status, res.body.job.details);
      } else if (res.code === 404) {
        setStatus_(sheet, cols, w.row, 'FAILED', 'The app has no record of this job — type start again. · ' + w.details);
      }
    } else if (request) {
      submit_(sheet, cols, w.row, request[1]);
    }
  });
}

// ── Talking to the app ───────────────────────────────────────────────────────

/** Send one row. The app reads the row itself and writes the status back. */
function submit_(sheet, cols, row, requestId) {
  var res = api_('post', '/api/automation/jobs', {
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheetName: CONTROL_TAB,
    row: row,
    requestId: requestId,
  });
  if (res.code === 200 || res.code === 202) return true;
  if (res.code === 409 && res.body && res.body.job) {
    SpreadsheetApp.getActive().toast('Row ' + row + ' is already running.', 'PSM automation', 6);
    setStatus_(sheet, cols, row, res.body.job.status, res.body.job.details);
    return true;
  }
  if (res.code >= 400 && res.code < 500) {
    setStatus_(sheet, cols, row, 'FAILED', (res.body && res.body.error) || 'The app refused the request (HTTP ' + res.code + ').');
    return false;
  }
  return false; // 5xx / network: stays PENDING, the sweep tries again
}

/** Poll the open health endpoint until the app answers (a sleeping instance takes about a minute). */
function wakeServer_(seconds) {
  var url = PropertiesService.getScriptProperties().getProperty('APP_URL');
  var until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      var r = UrlFetchApp.fetch(url.replace(/\/$/, '') + '/api/health', { muteHttpExceptions: true, followRedirects: true });
      if (r.getResponseCode() === 200) return true;
    } catch (err) {
      // asleep / starting — try again
    }
    Utilities.sleep(10000);
  }
  return false;
}

function api_(method, path, payload) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('APP_URL').replace(/\/$/, '') + path;
  var options = {
    method: method,
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + props.getProperty('AUTOMATION_TOKEN') },
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  try {
    var r = UrlFetchApp.fetch(url, options);
    var body = null;
    try {
      body = JSON.parse(r.getContentText());
    } catch (err) {
      body = null;
    }
    return { code: r.getResponseCode(), body: body };
  } catch (err) {
    return { code: 0, body: { error: String(err) } };
  }
}

// ── Sheet helpers ────────────────────────────────────────────────────────────

function setStatus_(sheet, cols, row, status, details) {
  sheet.getRange(row, cols.status).setValue(status);
  sheet.getRange(row, cols.details).setValue(details);
}

function clean_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
}

function lastNonEmpty_(arr) {
  for (var i = arr.length - 1; i >= 0; i--) if (arr[i]) return i + 1;
  return 0;
}

/** The header row: the one with "Screening Instructions", else the fullest of the first 6. */
function findHeaderRow_(sheet) {
  var rows = sheet.getRange(1, 1, Math.min(6, Math.max(sheet.getLastRow(), 1)), Math.max(sheet.getLastColumn(), 1)).getValues();
  var best = 1;
  var bestCount = -1;
  for (var r = 0; r < rows.length; r++) {
    var cells = rows[r].map(clean_);
    if (cells.indexOf(clean_(HEADERS.instructions)) >= 0) return r + 1;
    var count = cells.filter(function (c) {
      return c;
    }).length;
    if (count > bestCount) {
      bestCount = count;
      best = r + 1;
    }
  }
  return best;
}

/** The four columns by header text (null when setup hasn't run). */
function columns_(sheet) {
  var headerRow = findHeaderRow_(sheet);
  var head = sheet.getRange(headerRow, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(clean_);
  var col = function (name) {
    return head.indexOf(clean_(name)) + 1;
  };
  var out = {
    headerRow: headerRow,
    instructions: col(HEADERS.instructions),
    trigger: col(HEADERS.trigger),
    status: col(HEADERS.status),
    details: col(HEADERS.details),
  };
  return out.instructions && out.trigger && out.status && out.details ? out : null;
}
