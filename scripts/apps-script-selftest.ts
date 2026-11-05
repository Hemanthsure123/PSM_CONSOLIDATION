/**
 * The sheet's Apps Script (integrations/google-sheets/psm-automation.gs), run against a
 * simulated spreadsheet and a simulated app — no Google account needed:
 *   npx tsx scripts/apps-script-selftest.ts
 *
 * Covers setup (columns added after the last header, triggers installed), "start" detection
 * (other values ignored, a running row not started twice, missing instructions), what is sent
 * to the app, the server answers (202 / 409 / 4xx / down), and the 5-minute sweep (re-sending
 * waiting rows, catching up a finished job's status, and not waking the app when idle).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
  }
};

// ── A tiny spreadsheet ───────────────────────────────────────────────────────
class Sheet {
  grid: unknown[][];
  notes = new Map<string, string>();
  constructor(
    public name: string,
    rows: unknown[][],
    public maxCols = 36,
  ) {
    this.grid = rows.map((r) => [...r]);
  }
  getName() {
    return this.name;
  }
  cell(r: number, c: number) {
    return this.grid[r - 1]?.[c - 1] ?? "";
  }
  set(r: number, c: number, v: unknown) {
    while (this.grid.length < r) this.grid.push([]);
    this.grid[r - 1][c - 1] = v;
  }
  getLastRow() {
    for (let r = this.grid.length; r > 0; r--) if (this.grid[r - 1].some((v) => String(v ?? "").trim())) return r;
    return 0;
  }
  getLastColumn() {
    let m = 0;
    for (const row of this.grid) for (let c = row.length; c > 0; c--) if (String(row[c - 1] ?? "").trim()) { m = Math.max(m, c); break; }
    return m;
  }
  getMaxColumns() {
    return this.maxCols;
  }
  getMaxRows() {
    return 1000;
  }
  insertColumnsAfter(_after: number, n: number) {
    this.maxCols += n;
  }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    const sheet = this;
    return {
      getSheet: () => sheet,
      getRow: () => row,
      getColumn: () => col,
      getNumRows: () => numRows,
      getNumColumns: () => numCols,
      getValue: () => sheet.cell(row, col),
      getValues: () => Array.from({ length: numRows }, (_, i) => Array.from({ length: numCols }, (_, j) => sheet.cell(row + i, col + j))),
      setValue(v: unknown) {
        sheet.set(row, col, v);
        return this;
      },
      setFontWeight() {
        return this;
      },
      setNote(n: string) {
        sheet.notes.set(`${row}:${col}`, n);
        return this;
      },
      setDataValidation() {
        return this;
      },
      setWrap() {
        return this;
      },
    };
  }
}

const header = ["Date", "Job ID", "Product", "Company Name", "PC", "CRM", "Tech Stack", "Hubspot Link", "Remarks", "Internal Sheets", "JD", "Assigned", "Deadline", "Openings", "No. of Profiles Required"];
function makeWorld(opts: { server: (method: string, path: string, body: Record<string, unknown> | null) => { code: number; body: unknown } | "down" }) {
  const sheet = new Sheet("Profile Shortlisting - New", [
    ["", "", "", "", "", "", "ISE / PC — Handover"],
    header,
    ["15 Oct 2026", "x", "Edge", "Uni Cards", "A", "B", "Flutter", "", "", "https://docs.google.com/spreadsheets/d/AAA/edit", "", "", "", "1", "5"],
    ["16 Oct 2026", "y", "Edge", "Zaggle", "A", "B", "Java", "", "", "https://docs.google.com/spreadsheets/d/BBB/edit", "", "", "", "2", "10"],
  ]);
  const calls: { method: string; path: string; body: Record<string, unknown> | null; auth: string }[] = [];
  const triggers: { fn: string }[] = [];
  const toasts: string[] = [];
  let uuid = 0;
  let clock = Date.parse("2026-10-28T09:00:00Z");
  const props = new Map<string, string>([
    ["APP_URL", "https://app.example.com/"],
    ["AUTOMATION_TOKEN", "tok-123"],
  ]);
  const triggerBuilder = (fn: string) => {
    const b = { forSpreadsheet: () => b, onEdit: () => b, timeBased: () => b, everyMinutes: () => b, create: () => triggers.push({ fn }) };
    return b;
  };
  const ctx = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (n: string) => (n === sheet.name ? sheet : null), getId: () => "CONTROL_ID" }),
      getActive: () => ({ toast: (m: string) => toasts.push(m) }),
      flush: () => undefined,
      newDataValidation: () => {
        const b = { requireValueInList: () => b, setAllowInvalid: () => b, build: () => ({}) };
        return b;
      },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null }) },
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => undefined }) },
    // A simulated clock: sleeping advances it, so waiting for a "sleeping" app takes no real time.
    Utilities: {
      getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
      sleep: (ms: number) => void (clock += ms),
      formatDate: () => "5 Nov 10:00",
    },
    Session: { getScriptTimeZone: () => "Asia/Kolkata" },
    ScriptApp: {
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.fn })),
      deleteTrigger: (t: { getHandlerFunction: () => string }) => triggers.splice(triggers.findIndex((x) => x.fn === t.getHandlerFunction()), 1),
      newTrigger: (fn: string) => triggerBuilder(fn),
    },
    UrlFetchApp: {
      fetch(url: string, o: { method?: string; payload?: string; headers?: Record<string, string> } = {}) {
        const path = url.replace("https://app.example.com", "");
        const method = (o.method ?? "get").toLowerCase();
        const body = o.payload ? (JSON.parse(o.payload) as Record<string, unknown>) : null;
        if (path !== "/api/health") calls.push({ method, path, body, auth: o.headers?.Authorization ?? "" });
        const res = path === "/api/health" ? opts.server("get", "/api/health", null) : opts.server(method, path, body);
        if (res === "down") throw new Error("DNS error");
        return { getResponseCode: () => res.code, getContentText: () => JSON.stringify(res.body) };
      },
    },
    Date: class extends Date {
      static now() {
        return clock;
      }
    },
    JSON,
    String,
    Math,
    console,
  };
  vm.createContext(ctx);
  const mocks = new Set(Object.keys(ctx));
  vm.runInContext(readFileSync(join(process.cwd(), "integrations/google-sheets/psm-automation.gs"), "utf8"), ctx);
  // What the script itself defines at the top level (shared with every other file in the Apps Script project).
  const globals = Object.fromEntries(Object.keys(ctx).filter((k) => !mocks.has(k)).map((k) => [k, true]));
  const fn = (name: string) => (ctx as unknown as Record<string, (...a: unknown[]) => any>)[name];
  return { sheet, calls, triggers, toasts, fn, globals };
}

const ok202 = (method: string, path: string) =>
  path === "/api/health" ? { code: 200, body: { status: "ok" } } : method === "post" ? { code: 202, body: { job: { id: "J", status: "PENDING", details: "Queued" } } } : { code: 200, body: {} };

// ── setup ────────────────────────────────────────────────────────────────────
{
  const w = makeWorld({ server: ok202 });
  w.fn("psmAutomationSetup")();
  const head = w.sheet.grid[1];
  const cols = w.fn("psmColumns_")(w.sheet);
  check("setup adds the columns after the last header", Boolean(cols.instructions && cols.github && cols.dsa && cols.experience && cols.trigger && cols.status && cols.details), head.slice(14));
  check("setup installs the edit and sweep triggers", w.triggers.map((t) => t.fn).sort().join() === "psmAutomationOnEdit,psmAutomationSweep", w.triggers);
  w.fn("psmAutomationSetup")();
  check("running setup again changes nothing (no duplicate columns or triggers)", w.sheet.grid[1].length === 23 && w.triggers.length === 2);
  check("every global the script defines is psm-prefixed (no clash with other scripts)", Object.keys(w.globals).every((k) => /^(psm|PSM_)/.test(k)), Object.keys(w.globals));
  check("the instructions header explains the format", (w.sheet.notes.get(`2:${cols.instructions}`) ?? "").includes("Screening focus"));
}

// ── start ────────────────────────────────────────────────────────────────────
const edit = (w: ReturnType<typeof makeWorld>, row: number, value: string) => {
  const cols = w.fn("psmColumns_")(w.sheet);
  w.sheet.set(row, cols.trigger, value);
  w.fn("psmAutomationOnEdit")({ range: w.sheet.getRange(row, cols.trigger) });
};
{
  const w = makeWorld({ server: ok202 });
  w.fn("psmAutomationSetup")();
  const cols = w.fn("psmColumns_")(w.sheet);
  w.sheet.set(3, cols.instructions, "Subsheets: Edge Applied\nFocus: Flutter");
  edit(w, 3, "Start ");
  const post = w.calls.find((c) => c.method === "post");
  check("'Start ' (any case, spaces) is sent", Boolean(post) && post!.body!.row === 3 && post!.body!.sheetName === "Profile Shortlisting - New" && post!.body!.spreadsheetId === "CONTROL_ID", w.calls);
  check("with the token and a request id", post?.auth === "Bearer tok-123" && /^[0-9a-f-]{36}$/.test(String(post?.body?.requestId)));
  check("the row shows PENDING with the request id", w.sheet.cell(3, cols.status) === "PENDING" && String(w.sheet.cell(3, cols.details)).includes(`request ${post?.body?.requestId}`));
  check("no candidate data is sent", !JSON.stringify(post?.body).includes("Flutter"));

  const before = w.calls.length;
  edit(w, 3, "start");
  check("a second start while it runs is ignored", w.calls.length === before && w.toasts.some((t) => t.includes("already running")));

  edit(w, 4, "started?");
  edit(w, 4, "done");
  check("other values never start anything", w.calls.length === before);

  edit(w, 4, "start");
  check("no instructions → FAILED with what to do, nothing sent", w.sheet.cell(4, cols.status) === "FAILED" && String(w.sheet.cell(4, cols.details)).includes("Add Screening Instructions") && w.calls.length === before);

  w.sheet.set(4, cols.instructions, "Subsheets: Edge Applied\nFocus: Java");
  w.sheet.set(3, 3, "edited product");
  w.fn("psmAutomationOnEdit")({ range: w.sheet.getRange(3, 3) });
  check("edits in other columns are ignored", w.calls.length === before);
}

// ── server answers ───────────────────────────────────────────────────────────
{
  const w = makeWorld({
    server: (m, p) =>
      p === "/api/health" ? { code: 200, body: {} } : m === "post" ? { code: 409, body: { error: "busy", job: { status: "PROCESSING", details: "Screening 3 / 9 · job J" } } } : { code: 200, body: {} },
  });
  w.fn("psmAutomationSetup")();
  const cols = w.fn("psmColumns_")(w.sheet);
  w.sheet.set(3, cols.instructions, "Subsheets: Edge Applied\nFocus: Flutter");
  edit(w, 3, "start");
  check("409: the running job's status is shown", w.sheet.cell(3, cols.status) === "PROCESSING" && String(w.sheet.cell(3, cols.details)).includes("Screening 3 / 9"));
}
{
  const w = makeWorld({ server: (m, p) => (p === "/api/health" ? { code: 200, body: {} } : { code: 422, body: { error: "Row 3's Trigger says \"x\", not \"start\"" } }) });
  w.fn("psmAutomationSetup")();
  const cols = w.fn("psmColumns_")(w.sheet);
  w.sheet.set(3, cols.instructions, "Subsheets: Edge Applied\nFocus: Flutter");
  edit(w, 3, "start");
  check("4xx: FAILED with the app's reason", w.sheet.cell(3, cols.status) === "FAILED" && String(w.sheet.cell(3, cols.details)).includes("not \"start\""));
}
{
  let up = false;
  const w = makeWorld({ server: (m, p) => (!up ? "down" : ok202(m, p)) });
  w.fn("psmAutomationSetup")();
  const cols = w.fn("psmColumns_")(w.sheet);
  w.sheet.set(3, cols.instructions, "Subsheets: Edge Applied\nFocus: Flutter");
  edit(w, 3, "start");
  const requestId = String(w.sheet.cell(3, cols.details)).match(/request (\S+)/)?.[1];
  check("app down: the row stays PENDING with its request id", w.sheet.cell(3, cols.status) === "PENDING" && Boolean(requestId) && !w.calls.some((c) => c.method === "post"));
  up = true;
  w.fn("psmAutomationSweep")();
  const post = w.calls.find((c) => c.method === "post");
  check("the sweep sends it once the app is up — same request id (no duplicate job)", post?.body?.requestId === requestId, post);
}
{
  // Up but unable to take jobs (e.g. AUTOMATION_TOKEN missing on the server): says so, keeps retrying.
  let configured = false;
  const w = makeWorld({
    server: (m, p) =>
      p === "/api/health" ? { code: 200, body: {} } : !configured ? { code: 503, body: { error: "The automation isn't configured on this server (AUTOMATION_TOKEN)." } } : ok202(m, p),
  });
  w.fn("psmAutomationSetup")();
  const cols = w.fn("psmColumns_")(w.sheet);
  w.sheet.set(3, cols.instructions, "Subsheets: Edge Applied\nFocus: Flutter");
  edit(w, 3, "start");
  const details = String(w.sheet.cell(3, cols.details));
  const requestId = details.match(/request (\S+)/)?.[1];
  check("5xx: stays PENDING, the row shows the app's reason", w.sheet.cell(3, cols.status) === "PENDING" && details.includes("HTTP 503") && details.includes("AUTOMATION_TOKEN"), details);
  check("…and keeps its request id for the sweep", Boolean(requestId) && requestId === w.calls.find((c) => c.method === "post")?.body?.requestId);
  configured = true;
  w.fn("psmAutomationSweep")();
  const posts = w.calls.filter((c) => c.method === "post");
  check("the sweep re-sends the same request once the app can take it", posts.length === 2 && posts[1].body?.requestId === requestId, posts);
}

// ── sweep ────────────────────────────────────────────────────────────────────
{
  const job = "11111111-2222-3333-4444-555555555555";
  const w = makeWorld({
    server: (m, p) =>
      p === "/api/health"
        ? { code: 200, body: {} }
        : p === `/api/automation/jobs/${job}`
          ? { code: 200, body: { job: { status: "COMPLETED", details: `5 shortlisted → psm_final_shortlisted_2026-10-28 · job ${job}` } } }
          : { code: 404, body: {} },
  });
  w.fn("psmAutomationSetup")();
  const cols = w.fn("psmColumns_")(w.sheet);
  w.sheet.set(3, cols.status, "PROCESSING");
  w.sheet.set(3, cols.details, `Screening 3 / 9 · job ${job}`);
  w.fn("psmAutomationSweep")();
  check("sweep checks running jobs and catches up a finished one", w.sheet.cell(3, cols.status) === "COMPLETED" && String(w.sheet.cell(3, cols.details)).startsWith("5 shortlisted"));
}
{
  const w = makeWorld({ server: ok202 });
  w.fn("psmAutomationSetup")();
  const cols = w.fn("psmColumns_")(w.sheet);
  w.sheet.set(3, cols.instructions, "Subsheets: Edge Applied\nFocus: Flutter");
  w.sheet.set(3, cols.status, "PROCESSING");
  edit(w, 3, "stop");
  const stopPost = w.calls.find((c) => c.method === "post" && c.path === "/api/automation/jobs/stop");
  check("stop trigger sends stop request to server", Boolean(stopPost) && stopPost!.body!.row === 3);
}
{
  let woke = 0;
  const w = makeWorld({
    server: (m, p) => {
      if (p === "/api/health") woke++;
      return { code: 200, body: {} };
    },
  });
  w.fn("psmAutomationSetup")();
  const cols = w.fn("psmColumns_")(w.sheet);
  woke = 0;
  w.sheet.set(3, cols.status, "COMPLETED");
  w.fn("psmAutomationSweep")();
  check("an idle sheet never wakes the app", woke === 0 && w.calls.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
