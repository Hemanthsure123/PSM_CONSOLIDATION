/**
 * Self-test for PSM 1.12.0 (pure parts only: no network, no database):
 *   npx tsx scripts/companies-selftest.ts
 * Share status (the owner's example: Selected → Rejected → "Interview status: Done" is Rejected),
 * requirement state, CRP periods, CTC, the master's requirement rows, applications tabs, round
 * headers of platform exports, Companies (state, verified counts, checks, JD / HubSpot remarks,
 * tentative starts), filters / sorts, and the Excel export read back by the import. Every company,
 * person and phone here is made up.
 */
import "./server-only-shim";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { dealFacts } from "@/lib/hubspot/deals";
import {
  attachStarts,
  buildCompanies,
  checkText,
  companyDto,
  crpLabel,
  exportRows,
  filterCompanies,
  type PersonFact,
  type RequirementRecord,
  type ShareFact,
  sortCompanies,
  type StartRecord,
} from "@/lib/mobile/pool/companies-model";
import { companiesWorkbook, dayOfCell, readStartsWorkbook, REF_HEADER, START_HEADER } from "@/lib/mobile/pool/companies-xlsx";
import {
  bestStatus,
  cellSignal,
  combinedState,
  countOf,
  crpPeriod,
  ctcLabel,
  effectiveStatus,
  hubspotDealIdOf,
  inferCrpYear,
  isApplicationsTab,
  linkOf,
  masterClosed,
  outcomeOfStatus,
  ownStatusOf,
  parseCrpMonth,
  parseCrpsMaster,
  parseCtc,
  pickRequirement,
  requirementState,
  type Round,
  shareDto,
  shareVerdict,
  tabColumns,
} from "@/lib/mobile/pool/shares";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${(e as Error).message}`);
  }
}
const R = (name: string, value: string): Round => ({ name, value });

async function main() {
  // ── Share status ──────────────────────────────────────────────────────────
  await test("the owner's example: Screening Selected, TR 1 Rejected, Interview status Done → Rejected at TR Round 1", () => {
    const v = shareVerdict([R("Screening Round", "Selected"), R("TR Round 1", "Rejected"), R("Interview status", "Done")], "");
    assert.equal(v.status, "rejected");
    assert.equal(v.stage, "TR Round 1 · Rejected");
    assert.equal(outcomeOfStatus(v.status), "rejected");
  });
  await test("weak values never reopen a rejection or a no show", () => {
    assert.equal(shareVerdict([R("Screening Round", "Rejected"), R("TR Round 1", "Yet to Schedule")], "").status, "rejected");
    assert.equal(shareVerdict([R("Assessment Round", "No Show"), R("TR Round 1", "Yet to Schedule")], "").status, "no_show");
    assert.equal(shareVerdict([R("Interview status", "Done"), R("Screening Round", "Selected"), R("TR Round 1", "Rejected"), R("Interview status", "Done")], "").status, "rejected");
  });
  await test("a done round with no result is awaiting; a cleared round then an upcoming one is in process", () => {
    assert.deepEqual(shareVerdict([R("Assessment Round", "Completed & Waiting for Results")], ""), { status: "awaiting", stage: "Assessment Round · Completed & Waiting for Results" });
    assert.equal(shareVerdict([R("Screening Round", "Selected"), R("TR Round 1", "Completed and Waiting for results")], "").status, "awaiting");
    const v = shareVerdict([R("TR Round 1", "Selected"), R("TR Round 2", "Selected"), R("MR Round", "Selected"), R("HR Round", "Yet to Schedule")], "", "HR Round");
    assert.deepEqual(v, { status: "in_process", stage: "HR Round · Yet to Schedule" });
    assert.equal(shareVerdict([R("Screening Round", "Selected")], "").status, "in_process");
    assert.equal(shareVerdict([R("Pre Assignment Session", "Attended")], "").status, "awaiting");
    assert.equal(shareVerdict([R("TR Round 1", "Interviewing")], "").status, "in_process");
  });
  await test("selected only in the last (non-screening) round or the final status", () => {
    assert.equal(shareVerdict([R("TR Round 1", "Selected"), R("HR Round", "Selected")], "", "HR Round").status, "selected");
    assert.equal(shareVerdict([R("Screening Round", "Selected")], "", "Screening Round").status, "in_process");
    assert.equal(shareVerdict([R("TR Round 1", "Cleared")], "Hired").status, "selected");
    assert.equal(shareVerdict([R("TR Round 1", "Cleared")], "Reject").status, "rejected");
  });
  await test("closed: not reached, requirement closed", () => {
    assert.equal(shareVerdict([R("Technical round 1", "Not reached")], "Not reached").status, "closed");
    assert.equal(shareVerdict([R("Technical round 1", "Cleared")], "Not reached").status, "closed");
    assert.equal(cellSignal("Requirement Closed")?.status, "closed");
    assert.equal(outcomeOfStatus("closed"), "rejected");
  });
  await test("nothing filled in is shared; a typed note alone stays shared with the note as stage", () => {
    assert.deepEqual(shareVerdict([], ""), { status: "shared", stage: "Shared" });
    assert.deepEqual(shareVerdict([], "Will confirm"), { status: "shared", stage: "Will confirm" });
    assert.equal(shareVerdict([R("TR Round 1", "Cleared"), R("TR Round 2", "Panel: Asha")], "").status, "in_process");
  });
  await test("platform export: Not Shortlisted then ATTEMPTED is rejected; pass is cleared", () => {
    assert.equal(shareVerdict([R("dsaInterviewQualifyingStatus", "Not Shortlisted"), R("dsaInterviewAttemptStatus", "ATTEMPTED")], "").status, "rejected");
    assert.equal(shareVerdict([R("dsaInterviewQualifyingStatus", "Shortlisted"), R("tr1Status", "pass")], "").status, "in_process");
    assert.equal(shareVerdict([R("dsaInterviewQualifyingStatus", "Shortlisted"), R("tr1Status", "fail")], "").status, "rejected");
  });
  await test("the requirement's state: closed / on hold override open statuses only", () => {
    assert.equal(effectiveStatus("in_process", "shared", "closed"), "closed");
    assert.equal(effectiveStatus("awaiting", "shared", "on_hold"), "on_hold");
    assert.equal(effectiveStatus("shared", "applied", "open"), "applied");
    assert.equal(effectiveStatus("shared", "applied", "closed"), "closed");
    assert.equal(effectiveStatus("rejected", "shared", "closed"), "rejected");
    assert.equal(effectiveStatus("selected", "shared", "closed"), "selected");
    assert.equal(effectiveStatus("in_process", "shared", "unknown"), "in_process");
    assert.equal(bestStatus(["rejected", "closed", "awaiting"]), "awaiting");
    assert.equal(bestStatus([]), null);
  });
  await test("stored rows: the stored status wins; older rows are worked out from their rounds", () => {
    assert.equal(ownStatusOf({ rounds: [], final_status: "", outcome: "unknown", status: "awaiting" }).status, "awaiting");
    const old = ownStatusOf({ rounds: [R("Screening Round", "Selected"), R("TR Round 1", "Rejected"), R("Interview status", "Done")], final_status: "", outcome: "in_process", status: null });
    assert.equal(old.status, "rejected");
    // Stored selected (decided with the tab's last round) stays selected.
    assert.equal(ownStatusOf({ rounds: [R("TR Round 1", "Selected"), R("HR Round", "Selected")], final_status: "", outcome: "selected", status: null }).status, "selected");
  });
  await test("share DTO: applications tab, company status", () => {
    const base = {
      id: "1",
      sheet_id: "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tab_gid: 0,
      company: "Acme",
      role: "SDE",
      rounds: [],
      final_status: "",
      stage: "Shared",
      outcome: "unknown",
      first_seen_at: new Date("2026-10-27T05:00:00Z"),
      changed_at: new Date("2026-10-27T05:00:00Z"),
    };
    const applied = shareDto({ ...base, tab: "Applied Users" }, { state: "open", statusText: "Process in Progress" });
    assert.equal(applied.kind, "applied");
    assert.equal(applied.status, "applied");
    assert.equal(applied.companyStatus, "Process in Progress");
    const closed = shareDto({ ...base, tab: "JD-1", rounds: [R("Screening Round", "Selected")] }, { state: "closed", statusText: "Position closed from NxtWave" });
    assert.equal(closed.status, "closed");
    assert.equal(closed.outcome, "in_process");
  });

  // ── Master ────────────────────────────────────────────────────────────────
  await test("requirement state: final status, then stage, then ID status; a sheet is closed only when every requirement is", () => {
    assert.equal(requirementState("Position closed from NxtWave"), "closed");
    assert.equal(requirementState("No candidate selected"), "closed");
    assert.equal(requirementState("Requirement went on-hold"), "on_hold");
    assert.equal(requirementState("Process in Progress", "Requirement Closed"), "open");
    assert.equal(requirementState("", "Requirement Closed"), "closed");
    assert.equal(requirementState("", "Hold"), "on_hold");
    assert.equal(requirementState("", "Interview Done"), "open");
    assert.equal(requirementState("", "", "ID Done & Hired"), "closed");
    assert.equal(requirementState(""), "unknown");
    assert.equal(combinedState(["closed", "open"]), "open");
    assert.equal(combinedState(["closed", "on_hold"]), "on_hold");
    assert.equal(combinedState(["closed", "closed"]), "closed");
    assert.equal(masterClosed("No candidate selected / Process in Progress"), false);
    assert.equal(masterClosed("No candidate selected / Position closed from NxtWave"), true);
  });
  await test("CRP month, year and period", () => {
    assert.deepEqual(parseCrpMonth("Nov"), { month: 10, year: null });
    assert.deepEqual(parseCrpMonth("October 2026"), { month: 9, year: 2026 });
    assert.deepEqual(parseCrpMonth("Oct'26"), { month: 9, year: 2026 });
    assert.equal(parseCrpMonth(""), null);
    const now = new Date("2026-11-27T10:00:00Z");
    assert.equal(inferCrpYear(3, now), 2026); // Apr
    assert.equal(inferCrpYear(11, now), 2026); // Dec
    assert.equal(inferCrpYear(0, now), 2027); // Jan (upcoming)
    assert.equal(inferCrpYear(1, now), 2026); // Feb 2027 is too far ahead → Feb 2026
    assert.deepEqual(crpPeriod(2026, 10, 2), { from: "2026-11-08", to: "2026-11-14" });
    assert.deepEqual(crpPeriod(2026, 10, 5), { from: "2026-11-29", to: "2026-11-30" });
    assert.deepEqual(crpPeriod(2026, 1, null), { from: "2026-02-01", to: "2026-02-28" });
  });
  await test("CTC in LPA", () => {
    assert.deepEqual(parseCtc("8-12"), { min: 8, max: 12 });
    assert.deepEqual(parseCtc("8 - 10"), { min: 8, max: 10 });
    assert.deepEqual(parseCtc("7.5–8"), { min: 7.5, max: 8 });
    assert.deepEqual(parseCtc("50000"), { min: 6, max: 6 });
    assert.deepEqual(parseCtc("₹12,00,000"), { min: 12, max: 12 });
    assert.deepEqual(parseCtc("50k"), { min: 6, max: 6 });
    assert.equal(parseCtc("-"), null);
    assert.equal(parseCtc(""), null);
    assert.equal(ctcLabel("8-12"), "8–12 LPA");
    assert.equal(ctcLabel("15"), "15 LPA");
    assert.equal(ctcLabel("50000"), "50000 (≈6 LPA)");
    assert.equal(ctcLabel(""), "");
  });
  await test("cells: counts, links, HubSpot deal ids", () => {
    assert.equal(countOf("2"), 2);
    assert.equal(countOf("2-3"), 3);
    assert.equal(countOf(""), null);
    assert.equal(countOf("-"), null);
    assert.equal(linkOf("https://example.com/jd.pdf"), "https://example.com/jd.pdf");
    assert.equal(linkOf("NA"), null);
    assert.equal(linkOf("#REF!"), null);
    assert.equal(linkOf("javascript:alert(1)"), null);
    assert.equal(hubspotDealIdOf("https://app.hubspot.com/contacts/1/record/0-3/58635688970/"), "58635688970");
    assert.equal(hubspotDealIdOf("https://app.hubspot.com/contacts/1/record/0-1/123456/"), null);
  });
  const ID_A = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const ID_B = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const sheet = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;
  const HEAD = [
    "Company Name", "Role", "JOB ID", "CRP Month", "CRP Week", "Hubspot link", "Job Type", "No of openings", "CTC", "JD", "Final Status",
    "Current Stage of Interview", "Company ID Status", "No. of Assessed academy shared", "No. of Non Assessed Academy Profiles shared",
    "Total academy pool shared", "ISE", "Company Sheet Link",
  ];
  const masterRows = [
    HEAD,
    ["Acme Labs", "Backend Intern", "job-1", "Nov", "2", "https://app.hubspot.com/contacts/9/record/0-3/1111111/", "Internship", "2", "8-12", "#REF!", "Process in Progress", "Interview in progress", "", "3", "1", "4", "Asha", sheet(ID_A)],
    ["", "Frontend Intern", "job-2", "Nov", "2", "", "Internship", "1", "10", "https://example.com/fe-jd", "No candidate selected", "Interview Done", "", "1", "0", "1", "Asha", sheet(ID_A)],
    ["Beta Co", "SDE", "", "Oct", "4", "https://app.hubspot.com/contacts/9/record/0-3/2222222/", "Full time", "5", "15-20", "", "", "Yet to start", "", "", "", "", "Ravi", ""],
    ["Gamma", "QA", "job-9", "Oct", "", "", "", "", "", "", "", "", "", "0", "0", "0", "", ""],
    ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  ];
  await test("master: every requirement row, typed counts, JD link from the cell or its hyperlink, stable keys", () => {
    const m = parseCrpsMaster(masterRows, [null, "https://example.com/be-jd", null, null, null, null]);
    assert.equal(m.requirements.length, 4);
    const [be, fe, beta] = m.requirements;
    assert.equal(be.company, "Acme Labs");
    assert.equal(fe.company, "Acme Labs");
    assert.equal(be.jdUrl, "https://example.com/be-jd");
    assert.equal(fe.jdUrl, "https://example.com/fe-jd");
    assert.equal(be.hubspotDealId, "1111111");
    assert.equal(be.assessedSent, 3);
    assert.equal(be.nonAssessedSent, 1);
    assert.equal(be.academySent, 4);
    assert.equal(be.openings, 2);
    assert.equal(be.crpWeek, 2);
    assert.equal(beta.sheetId, null);
    assert.equal(beta.assessedSent, null);
    assert.match(be.key, /^[0-9a-f]{24}$/);
    assert.notEqual(be.key, fe.key);
    // Same input → same keys; an exact duplicate row gets its own key.
    assert.equal(parseCrpsMaster(masterRows).requirements[0].key, be.key);
    const dup = parseCrpsMaster([...masterRows.slice(0, 2), masterRows[1]]).requirements;
    assert.equal(dup.length, 2);
    assert.notEqual(dup[0].key, dup[1].key);
    assert.equal(m.sheets.length, 1);
  });

  // ── Company sheet tabs ────────────────────────────────────────────────────
  await test("applications tabs", () => {
    for (const t of ["Applied Users", "Total Applications", "Academy Applied", "Form Responses 1", "Applicants"]) assert.equal(isApplicationsTab(t), true, t);
    for (const t of ["JD-1", "Batch2 || 25 Aug 2026", "Sheet3", "Shortlisted"]) assert.equal(isApplicationsTab(t), false, t);
  });
  await test("platform export headers: data columns (ids, ratings, urls, read-only, dates) are not rounds", () => {
    const head = [
      "name", "phone", "email", "dsaInterviewQualifyingStatus", "dsaInterviewAttemptStatus", "tr1InterviewAttemptId", "tr1InterviewAttemptDatetime", "tr1InterviewTitle",
      "tr1InterviewTag", "tr1SelfIntroRating", "tr1ProblemSolvingAbility", "tr1ReportUrl", "tr1Status", "interviewPath (read-only)", "TR2 Dates", "Interview Updates - NxtWave",
      "Candidate Assessment Report PDF", "TR Round 1", "Interview status",
    ];
    const cols = tabColumns([head, ["Test Person", "9000000001", "t@example.com"]])!;
    assert.deepEqual(cols.rounds.map((r) => r.name), ["dsaInterviewQualifyingStatus", "dsaInterviewAttemptStatus", "tr1Status", "TR Round 1", "Interview status"]);
  });
  await test("a tab finds its requirement by role words; ambiguous or one-requirement cases", () => {
    const reqs = [
      { role: "Backend Intern", crpMonth: "Nov" },
      { role: "Frontend Intern", crpMonth: "Nov" },
    ];
    assert.equal(pickRequirement({ tab: "Backend Intern || Batch 1 || JD-2", role: "" }, reqs)?.role, "Backend Intern");
    assert.equal(pickRequirement({ tab: "Frontend Intern || Batch 1", role: "" }, reqs)?.role, "Frontend Intern");
    assert.equal(pickRequirement({ tab: "JD-1", role: "" }, reqs), null);
    assert.equal(pickRequirement({ tab: "anything", role: "" }, [reqs[0]])?.role, "Backend Intern");
  });

  // ── Companies ─────────────────────────────────────────────────────────────
  const m = parseCrpsMaster(masterRows, [null, "https://example.com/be-jd"]);
  const requirements: RequirementRecord[] = m.requirements.map((r) => ({ ...r, rowIndex: r.row, crpYear: 2026 }));
  const people = new Map<string, PersonFact>([
    ["u1", { uid: "u1", name: "Asha Test", mentor: { name: "Mentor One", email: "m1@example.com" }, mine: false }],
    ["u2", { uid: "u2", name: "Bala Test", mentor: { name: "Mentor Two", email: "m2@example.com" }, mine: false }],
    ["u3", { uid: "u3", name: "Chitra Test", mentor: null, mine: false }],
  ]);
  const at = (d: string) => new Date(`${d}T06:00:00Z`);
  const fact = (uid: string, tab: string, own: ShareFact["own"], stage = "Shared", sheetId = ID_A): ShareFact => ({ sheetId, tab, role: tab, uid, own, stage, firstSeen: at("2026-11-10"), changed: at("2026-11-20") });
  const shares: ShareFact[] = [
    fact("u1", "Backend Intern || Batch 1", "awaiting", "Assessment Round · Completed & Waiting for Results"),
    fact("u1", "Applied Users", "shared"),
    fact("u2", "Frontend Intern || Batch 1", "in_process", "TR Round 1 · Cleared"),
    fact("u3", "Applied Users", "shared"),
    fact("gone", "Backend Intern || Batch 1", "selected"),
  ];
  const deals = new Map([
    ["1111111", { dealId: "1111111", dealName: "Acme Labs - Backend Intern", jdUrl: null, remarks: "Strong DSA; Bangalore office", error: null, fetchedAt: at("2026-11-26") }],
    ["2222222", { dealId: "2222222", dealName: "Beta Co - SDE", jdUrl: null, remarks: "Tier 1 only", error: null, fetchedAt: at("2026-11-26") }],
  ]);
  const starts: StartRecord[] = [
    { key: requirements[0].key, jobId: "job-1", company: "Acme Labs", role: "Backend Intern", crpMonth: "Nov", date: "2026-12-03", by: "Mentor One", at: at("2026-11-27"), source: "app" },
    // Its key changed (the row was edited): found again by job id + month.
    { key: "f".repeat(24), jobId: "job-2", company: "Acme Labs", role: "Frontend Intern", crpMonth: "Nov", date: "2026-12-05", by: "Mentor Two", at: at("2026-11-27"), source: "import" },
  ];
  const companies = buildCompanies({ requirements, shares, people, deals, starts });

  await test("companies: one drive per sheet, requirements without a sheet on their own, nothing sent → left out", () => {
    assert.equal(companies.length, 1);
    const acme = companies.find((c) => c.company === "Acme Labs")!;
    const beta = companies.find((c) => c.company === "Beta Co");
    assert.equal(acme.requirements.length, 2);
    assert.equal(beta, undefined); // master counts blank and no sheet
    assert.ok(companies.some((c) => c.company === "Gamma") === false);
  });
  await test("companies: per-candidate status with each requirement's state, counts, state, verified, check", () => {
    const acme = companies.find((c) => c.company === "Acme Labs")!;
    const byUid = new Map(acme.candidates.map((c) => [c.uid, c]));
    assert.equal(byUid.get("u1")!.status, "awaiting"); // the shared tab wins over Applied Users
    assert.equal(byUid.get("u2")!.status, "closed"); // Frontend requirement: No candidate selected
    assert.equal(byUid.get("u3")!.status, "applied");
    assert.equal(byUid.has("gone"), false);
    assert.equal(acme.counts.shared, 2);
    assert.equal(acme.counts.applied, 1);
    assert.equal(acme.counts.awaiting, 1);
    assert.equal(acme.counts.closed, 1);
    assert.equal(acme.state, "in_progress");
    assert.equal(acme.masterState, "open");
    const [be, fe] = acme.requirements;
    assert.equal(be.verifiedAssessed, 1);
    assert.equal(fe.verifiedAssessed, 1);
    assert.equal(be.check, "Master says 3 assessed; the company sheet has 1");
    assert.equal(fe.check, "");
    assert.equal(acme.academy.assessed, 4);
    assert.equal(acme.openings, 3);
    assert.equal(acme.ctc.min, 8);
    assert.equal(acme.ctc.max, 12);
    assert.equal(acme.crp.label, "Nov 2026 · Wk 2");
    assert.deepEqual([acme.crp.from, acme.crp.to], ["2026-11-08", "2026-11-14"]);
  });
  await test("companies: JD link from the master (cell or hyperlink); HubSpot remarks only when there is no JD link", () => {
    const acme = companies.find((c) => c.company === "Acme Labs")!;
    const [be, fe] = acme.requirements;
    assert.equal(be.jdUrl, "https://example.com/be-jd");
    assert.equal(be.jdSource, "master");
    assert.equal(be.remarks, null);
    assert.equal(fe.jdSource, "master");
    const noJd = buildCompanies({ requirements: requirements.map((r) => ({ ...r, jdUrl: null })), shares, people, deals, starts });
    const be2 = noJd.find((c) => c.company === "Acme Labs")!.requirements[0];
    assert.equal(be2.jdUrl, null);
    assert.equal(be2.remarks, "Strong DSA; Bangalore office");
    assert.equal(be2.jdSource, null);
  });
  await test("tentative starts: by key, and found again after the row's key changed", () => {
    const acme = companies.find((c) => c.company === "Acme Labs")!;
    assert.equal(acme.requirements[0].tentativeStart?.date, "2026-12-03");
    assert.equal(acme.requirements[1].tentativeStart?.date, "2026-12-05");
    assert.equal(attachStarts(requirements, [{ ...starts[1], jobId: "", role: "Nobody" }]).size, 0);
  });
  await test("a sheet with several requirements and tabs that don't say which: verified unknown, explained", () => {
    const list = buildCompanies({ requirements, shares: [fact("u1", "JD-1", "in_process")], people, deals, starts: [] });
    const acme = list.find((c) => c.company === "Acme Labs")!;
    assert.equal(acme.requirements[0].verifiedAssessed, null);
    assert.match(acme.requirements[0].check, /serves 2 requirements and has 1 Academy assessed/);
  });
  await test("check text", () => {
    assert.equal(checkText({ academySent: 4, assessedSent: 3, nonAssessedSent: 1 }, 3), "");
    assert.equal(checkText({ academySent: 5, assessedSent: 3, nonAssessedSent: 1 }, 3), "Master total 5 ≠ assessed 3 + non-assessed 1");
    assert.equal(checkText({ academySent: null, assessedSent: null, nonAssessedSent: null }, 2), "Master count is blank; the company sheet has 2 assessed");
  });
  await test("crp labels across months and years", () => {
    assert.equal(crpLabel([{ crpMonth: "Oct", crpYear: 2026, crpWeek: 3 }, { crpMonth: "Nov", crpYear: 2026, crpWeek: 1 }]), "Oct–Nov 2026");
    assert.equal(crpLabel([{ crpMonth: "Dec", crpYear: 2026, crpWeek: null }, { crpMonth: "Jan", crpYear: 2027, crpWeek: null }]), "Dec 2026 – Jan 2027");
    assert.equal(crpLabel([{ crpMonth: "Nov", crpYear: 2026, crpWeek: 2 }, { crpMonth: "Nov", crpYear: 2026, crpWeek: 3 }]), "Nov 2026 · Wk 2–3");
    assert.equal(crpLabel([{ crpMonth: "", crpYear: null, crpWeek: null }]), "");
  });
  await test("filters and sorts", () => {
    const mk = (company: string, state: "in_progress" | "done", from: string | null, max: number | null, openings: number | null, mine = 0) => ({
      company,
      state,
      crp: { from, to: from ? `${from.slice(0, 8)}28` : null, label: "" },
      ctc: { text: "", min: max, max },
      openings,
      mine,
      lastActivityAt: null,
      requirements: [{ role: "SDE" }],
    });
    const list = [mk("A", "in_progress", "2026-10-01", 10, 2, 1), mk("B", "done", "2026-11-01", 20, 1), mk("C", "in_progress", null, null, 5)];
    assert.deepEqual(filterCompanies(list, { state: "in_progress" }).map((c) => c.company), ["A", "C"]);
    assert.deepEqual(filterCompanies(list, { state: "active" }).map((c) => c.company), ["A", "C"]);
    assert.deepEqual(filterCompanies(list, { from: "2026-11-01", to: "2026-11-30" }).map((c) => c.company), ["B"]);
    assert.deepEqual(filterCompanies(list, { mine: true }).map((c) => c.company), ["A"]);
    assert.deepEqual(filterCompanies(list, { q: "sde" }).length, 3);
    assert.deepEqual(sortCompanies(list, "ctc").map((c) => c.company), ["B", "A", "C"]);
    assert.deepEqual(sortCompanies(list, "openings").map((c) => c.company), ["C", "A", "B"]);
  });
  await test("export rows: CTC sort orders the requirements themselves", () => {
    const rows = exportRows(companies, "ctc");
    assert.deepEqual(rows.map((r) => r.req.role), ["Backend Intern", "Frontend Intern"]);
    const dto = companyDto(companies[0]);
    assert.equal("remarksFull" in dto.requirements[0], false);
  });

  // ── Excel ─────────────────────────────────────────────────────────────────
  await test("Excel: export, fill a date, import reads it back; bad cells are reported", async () => {
    const bytes = await companiesWorkbook(companies, "ctc", {
      generatedAt: new Date("2026-11-27T10:00:00Z"),
      generatedBy: "Test Lead",
      filters: "All",
      sharesSyncedAt: null,
      masterReadAt: null,
      hubspotReadAt: null,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Companies")!;
    const head = ws.getRow(1).values as unknown[];
    const startCol = head.indexOf(START_HEADER);
    const refCol = head.indexOf(REF_HEADER);
    assert.ok(startCol > 0 && refCol > 0);
    assert.equal(ws.rowCount, 3);
    assert.ok(head.includes("Assessed academy sent (master)") && head.includes("Non-assessed academy sent (master)") && head.includes("Openings") && head.includes("JD link"));
    // Row 2 already has 3 Dec; set row 3 to a typed date and add a bad row.
    ws.getRow(3).getCell(startCol).value = "07-12-2026";
    const bad = ws.addRow([]);
    bad.getCell(refCol).value = "0".repeat(24);
    bad.getCell(startCol).value = "soon";
    const out = Buffer.from(await wb.xlsx.writeBuffer());
    const read = await readStartsWorkbook(out);
    assert.deepEqual(
      read.rows.map((r) => r.day),
      ["2026-12-03", "2026-12-07"],
    );
    assert.deepEqual(read.invalid, [{ row: 4, reason: '"soon" is not a date' }]);
    await assert.rejects(readStartsWorkbook(Buffer.from("not a zip")), /not_xlsx/);
  });
  await test("Excel dates in the forms people type", () => {
    assert.equal(dayOfCell(new Date("2026-12-03T00:00:00Z")), "2026-12-03");
    assert.equal(dayOfCell(46359), "2026-12-03");
    assert.equal(dayOfCell("2026-12-03"), "2026-12-03");
    assert.equal(dayOfCell("03/12/2026"), "2026-12-03");
    assert.equal(dayOfCell("3 Dec 2026"), "2026-12-03");
    assert.equal(dayOfCell("03-Dec-2026"), "2026-12-03");
    assert.equal(dayOfCell("Dec 3, 2026"), "2026-12-03");
    assert.equal(dayOfCell("3rd December 2026"), "2026-12-03");
    assert.equal(dayOfCell("31/02/2026"), null);
    assert.equal(dayOfCell("tomorrow"), null);
    assert.equal(dayOfCell(""), null);
  });
  await test("HubSpot deal facts: the first real JD link; remarks tidied", () => {
    const d = dealFacts({ dealname: "Acme - SDE", jd_link: "NA", job_description_link: "https://example.com/jd", nurturing_team_remarks: "Line 1\r\n\r\n\r\nLine 2  " });
    assert.equal(d.jdUrl, "https://example.com/jd");
    assert.equal(d.remarks, "Line 1\n\nLine 2");
    assert.equal(dealFacts({}).remarks, null);
  });

  if (failures.length) {
    console.error(`companies selftest: FAILED (${passed} passed, ${failures.length} failed)`);
    process.exit(1);
  }
  console.log(`${passed} companies tests passed`);
}

void main();
