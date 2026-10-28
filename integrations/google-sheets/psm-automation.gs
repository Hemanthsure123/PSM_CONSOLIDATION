/**
 * PSM shortlisting automation — the Google Sheets side.
 *
 * Bound to the coordination spreadsheet (Extensions → Apps Script). Typing "start" in a row's
 * "Trigger" cell sends that row to the app, which plans, screens, evaluates, validates and
 * delivers the shortlist to psm_final_shortlisted_<date> in the row's Internal Sheets
 * spreadsheet, writing its progress to "Automation Status" / "Automation Details".
 *
 * One-time setup (docs/automation.md):
 *   1. Add this as a new script file (any name) — don't replace the project's other files.
 *   2. Project Settings → Script properties: APP_URL and AUTOMATION_TOKEN.
 *   3. Run `psmAutomationSetup` once and allow the permissions it asks for.
 *
 * Every name here starts with psm / PSM_, so it can't clash with other scripts in the project.
 *
 * This script never sees candidate data: it sends the row number and a request id; the app
 * reads the row itself. Its token is kept in Script properties, not in this code.
 */

var PSM_CONTROL_TAB = 'Profile Shortlisting - New';
var PSM_HEADERS = {
  instructions: 'Screening Instructions',
  trigger: 'Trigger',
  status: 'Automation Status',
  details: 'Automation Details',
};
var PSM_ACTIVE = ['PENDING', 'PROCESSING'];
/** How long to wait for a sleeping server to wake (Apps Script runs may last 6 minutes). */
var PSM_WAKE_SECONDS = 240;

// ── Setup ────────────────────────────────────────────────────────────────────

/** Run once (psmAutomationSetup): adds the four columns (if missing), the Trigger dropdown, and the two triggers. */
function psmAutomationSetup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('APP_URL') || !props.getProperty('AUTOMATION_TOKEN')) {
    throw new Error('Set APP_URL and AUTOMATION_TOKEN in Project Settings → Script properties first.');
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PSM_CONTROL_TAB);
  if (!sheet) throw new Error('No tab named "' + PSM_CONTROL_TAB + '".');
  var headerRow = psmHeaderRow_(sheet);
  var width = Math.max(sheet.getLastColumn(), 1);
  var head = sheet.getRange(headerRow, 1, 1, width).getValues()[0].map(psmClean_);
  var last = psmLastNonEmpty_(head);
  ['instructions', 'trigger', 'status', 'details'].forEach(function (key) {
    if (head.indexOf(psmClean_(PSM_HEADERS[key])) >= 0) return;
    last += 1;
    if (last > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), last - sheet.getMaxColumns());
    sheet.getRange(headerRow, last).setValue(PSM_HEADERS[key]).setFontWeight('bold');
    head[last - 1] = psmClean_(PSM_HEADERS[key]);
  });
  var cols = psmColumns_(sheet);
  sheet.getRange(cols.headerRow, cols.instructions).setNote(
    'One item per line, for example:\nSubsheets: Edge Applied, Academy Applied\nFocus: Flutter developers who shipped apps\nGitHub: (domain-fit candidates)   or (all candidates) / no\nDSA: yes   or no / CF 1400 / 300 solved\nTop: 10   (optional; else No. of Profiles Required)'
  );
  sheet.getRange(cols.headerRow, cols.trigger).setNote('Type start to run the shortlisting for this row. Type start again later to re-run it.');
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(['start'], true).setAllowInvalid(true).build();
  sheet.getRange(cols.headerRow + 1, cols.trigger, Math.max(sheet.getMaxRows() - cols.headerRow, 1), 1).setDataValidation(rule);
  sheet.getRange(cols.headerRow + 1, cols.details, Math.max(sheet.getMaxRows() - cols.headerRow, 1), 1).setWrap(true);

  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'psmAutomationOnEdit' || fn === 'psmAutomationSweep') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('psmAutomationOnEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('psmAutomationSweep').timeBased().everyMinutes(5).create();
  var ok = psmWake_(60);
  SpreadsheetApp.getActive().toast(ok ? 'Automation is set up and the app answered.' : 'Automation is set up. The app is waking up — that can take a minute.', 'PSM automation', 8);
}

// ── Triggers ─────────────────────────────────────────────────────────────────

/** Installable on-edit trigger: "start" in a Trigger cell queues that row. */
function psmAutomationOnEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (sheet.getName() !== PSM_CONTROL_TAB) return;
  var cols = psmColumns_(sheet);
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
      if (psmClean_(triggers[i][0]) !== 'start') continue;
      var row = r0 + i;
      var status = String(statuses[i][0]).trim().toUpperCase();
      if (PSM_ACTIVE.indexOf(status) >= 0) {
        SpreadsheetApp.getActive().toast('Row ' + row + ' is already running — this start was ignored.', 'PSM automation', 6);
        continue;
      }
      if (!String(instructions[i][0]).trim()) {
        psmSetStatus_(sheet, cols, row, 'FAILED', 'Add Screening Instructions first, then type start again.');
        continue;
      }
      var requestId = Utilities.getUuid();
      psmSetStatus_(sheet, cols, row, 'PENDING', 'Waiting for the app to wake up · request ' + requestId);
      queued.push({ row: row, requestId: requestId });
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  if (!queued.length) return;
  if (!psmWake_(PSM_WAKE_SECONDS)) return; // the 5-minute sweep sends them once the app answers
  queued.forEach(function (q) {
    psmSubmit_(sheet, cols, q.row, q.requestId);
  });
}

/**
 * Every 5 minutes: rows still waiting for the app are sent again, and running jobs are checked
 * (which also keeps a sleeping server awake while it works). Does nothing — and wakes nothing —
 * when no row is PENDING or PROCESSING.
 */
function psmAutomationSweep() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PSM_CONTROL_TAB);
  if (!sheet) return;
  var cols = psmColumns_(sheet);
  if (!cols) return;
  var last = sheet.getLastRow();
  if (last <= cols.headerRow) return;
  var n = last - cols.headerRow;
  var statuses = sheet.getRange(cols.headerRow + 1, cols.status, n, 1).getValues();
  var details = sheet.getRange(cols.headerRow + 1, cols.details, n, 1).getValues();
  var work = [];
  for (var i = 0; i < n; i++) {
    var s = String(statuses[i][0]).trim().toUpperCase();
    if (PSM_ACTIVE.indexOf(s) >= 0) work.push({ row: cols.headerRow + 1 + i, status: s, details: String(details[i][0]) });
  }
  if (!work.length) return;
  if (!psmWake_(PSM_WAKE_SECONDS)) return;
  work.forEach(function (w) {
    var job = w.details.match(/job ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    var request = w.details.match(/request ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (job) {
      var res = psmApi_('get', '/api/automation/jobs/' + job[1]);
      // The app writes its own status; this only catches up a row whose last write was lost.
      if (res.code === 200 && res.body && res.body.job && res.body.job.status !== w.status) {
        psmSetStatus_(sheet, cols, w.row, res.body.job.status, res.body.job.details);
      } else if (res.code === 404) {
        psmSetStatus_(sheet, cols, w.row, 'FAILED', 'The app has no record of this job — type start again. · ' + w.details);
      }
    } else if (request) {
      psmSubmit_(sheet, cols, w.row, request[1]);
    }
  });
}

// ── Talking to the app ───────────────────────────────────────────────────────

/** Send one row. The app reads the row itself and writes the status back. */
function psmSubmit_(sheet, cols, row, requestId) {
  var res = psmApi_('post', '/api/automation/jobs', {
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheetName: PSM_CONTROL_TAB,
    row: row,
    requestId: requestId,
  });
  if (res.code === 200 || res.code === 202) return true;
  if (res.code === 409 && res.body && res.body.job) {
    SpreadsheetApp.getActive().toast('Row ' + row + ' is already running.', 'PSM automation', 6);
    psmSetStatus_(sheet, cols, row, res.body.job.status, res.body.job.details);
    return true;
  }
  if (res.code >= 400 && res.code < 500) {
    psmSetStatus_(sheet, cols, row, 'FAILED', (res.body && res.body.error) || 'The app refused the request (HTTP ' + res.code + ').');
    return false;
  }
  return false; // 5xx / network: stays PENDING, the sweep tries again
}

/** Poll the open health endpoint until the app answers (a sleeping instance takes about a minute). */
function psmWake_(seconds) {
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

function psmApi_(method, path, payload) {
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

function psmSetStatus_(sheet, cols, row, status, details) {
  sheet.getRange(row, cols.status).setValue(status);
  sheet.getRange(row, cols.details).setValue(details);
}

function psmClean_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
}

function psmLastNonEmpty_(arr) {
  for (var i = arr.length - 1; i >= 0; i--) if (arr[i]) return i + 1;
  return 0;
}

/** The header row: the one with "Screening Instructions", else the fullest of the first 6. */
function psmHeaderRow_(sheet) {
  var rows = sheet.getRange(1, 1, Math.min(6, Math.max(sheet.getLastRow(), 1)), Math.max(sheet.getLastColumn(), 1)).getValues();
  var best = 1;
  var bestCount = -1;
  for (var r = 0; r < rows.length; r++) {
    var cells = rows[r].map(psmClean_);
    if (cells.indexOf(psmClean_(PSM_HEADERS.instructions)) >= 0) return r + 1;
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
function psmColumns_(sheet) {
  var headerRow = psmHeaderRow_(sheet);
  var head = sheet.getRange(headerRow, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(psmClean_);
  var col = function (name) {
    return head.indexOf(psmClean_(name)) + 1;
  };
  var out = {
    headerRow: headerRow,
    instructions: col(PSM_HEADERS.instructions),
    trigger: col(PSM_HEADERS.trigger),
    status: col(PSM_HEADERS.status),
    details: col(PSM_HEADERS.details),
  };
  return out.instructions && out.trigger && out.status && out.details ? out : null;
}
