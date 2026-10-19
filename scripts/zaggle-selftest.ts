/**
 * Zaggle SDE 1 screening — deterministic self-test (no network, no models).
 * Dates, month counting (overlaps once), the IT services list, scoring and ranking.
 *
 *   npx tsx scripts/zaggle-selftest.ts
 */
import { knownServicesFirm } from "@/lib/zaggle/companies";
import { monthIndex, readDates, unionMonths, ymOf, type MonthIndex } from "@/lib/zaggle/dates";
import { rankZg, scoreZg } from "@/lib/zaggle/scoring";
import { DEFAULT_ZG_RULES, ZG_SKILLS, failedZgEvaluation, type ZgEvaluation, type ZgJob } from "@/lib/zaggle/types";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
const section = (s: string) => console.log(`\n${s}`);

// ── Dates ────────────────────────────────────────────────────────────────────
section("dates");
const asOf: MonthIndex = monthIndex(2026, 10);
const months = (text: string) => {
  const r = readDates(text, asOf);
  return r.kind === "range" ? r.end - r.start + 1 : r.kind === "duration" ? r.months : null;
};
ok("Jan 2025 – Present = 22 (to Oct 2026)", months("Jan 2025 – Present") === 22, months("Jan 2025 – Present"));
ok("January 2025 - December 2025 = 12", months("January 2025 - December 2025") === 12);
ok("06/2024 - 12/2024 = 7", months("06/2024 - 12/2024") === 7);
ok("Mar'25 to Aug'25 = 6", months("Mar'25 to Aug'25") === 6);
ok("Jan-2025 – Mar-2025 = 3", months("Jan-2025 – Mar-2025") === 3);
ok("2024-01 to 2024-06 = 6", months("2024-01 to 2024-06") === 6);
ok("Sept 2025 – Till Date = 14", months("Sept 2025 – Till Date") === 14, months("Sept 2025 – Till Date"));
ok("Aug 2025 - CURRENT = 15", months("Aug 2025 - CURRENT") === 15);
ok("6 months (duration only)", months("6 months") === 6);
ok("1 yr 2 mos = 14", months("1 yr 2 mos") === 14);
{
  const r = readDates("2023 – 2024", asOf);
  ok("2023 – 2024 = 12, approximate", r.kind === "range" && r.end - r.start + 1 === 12 && !r.precise, r);
}
{
  const r = readDates("Jan 2025 – Dec 2027", asOf);
  ok("future end capped at today", r.kind === "range" && ymOf(r.end) === "2026-10", r);
}
ok("no dates", readDates("Bengaluru, India", asOf).kind === "none");
ok("'Summary 2024' is not March", readDates("Summary 2024", asOf).kind !== "range" || (readDates("Summary 2024", asOf) as { precise: boolean }).precise === false);
ok("overlaps once: Jan–Dec 2025 + Jun 2025–Mar 2026 = 15", unionMonths([
  { start: monthIndex(2025, 1), end: monthIndex(2025, 12) },
  { start: monthIndex(2025, 6), end: monthIndex(2026, 3) },
]) === 15);
ok("6 + 3 + 3 back to back = 12", unionMonths([
  { start: monthIndex(2025, 1), end: monthIndex(2025, 6) },
  { start: monthIndex(2025, 7), end: monthIndex(2025, 9) },
  { start: monthIndex(2025, 10), end: monthIndex(2025, 12) },
]) === 12);

// ── IT services / consulting list ────────────────────────────────────────────
section("IT services / consulting list");
for (const [name, want] of [
  ["Tata Consultancy Services", "TCS"],
  ["TCS", "TCS"],
  ["Infosys Limited", "Infosys"],
  ["HCL Technologies", "HCLTech"],
  ["Cognizant Technology Solutions", "Cognizant"],
  ["Accenture Solutions Pvt Ltd", "Accenture"],
  ["LTIMindtree", "LTIMindtree"],
  ["EY GDS", "EY"],
  ["Capgemini India", "Capgemini"],
] as const) {
  ok(`${name} → ${want}`, knownServicesFirm(name)?.name === want, knownServicesFirm(name));
}
for (const name of ["Razorpay", "Zaggle Prepaid Ocean Services", "Swiggy", "Products Labs Inc", "Just Dial", "Hey Coach", "Infosys Finacle"]) {
  ok(`${name} is not on the list`, knownServicesFirm(name) === null, knownServicesFirm(name));
}

// ── Scoring ──────────────────────────────────────────────────────────────────
section("scoring");
const allSkills = () =>
  Object.fromEntries(ZG_SKILLS.map((d) => [d.key, { skills: "x", projects: "", experience: "y" }])) as ZgEvaluation["skills"];
const job = (o: Partial<ZgJob>): ZgJob => ({
  company: "Razorpay",
  title: "Software Engineer",
  employmentType: "full-time",
  roleFocus: "backend",
  datesText: "",
  start: "2025-01",
  end: "2025-12",
  current: false,
  datesVerified: true,
  datesApproximate: false,
  durationOnlyMonths: null,
  companyType: "product",
  companyTypeSource: "model",
  companyTypeReason: "",
  work: "",
  tech: [],
  ...o,
});
const ev = (id: string, jobs: ZgJob[], o: Partial<ZgEvaluation> = {}): ZgEvaluation => ({
  ...failedZgEvaluation({ id, mobile: id, name: id, resumeUrl: "x" }, "", false),
  status: "ok",
  evidenceVerified: true,
  skills: allSkills(),
  jobs,
  ...o,
});
const R = DEFAULT_ZG_RULES;

{
  const s = scoreZg(ev("a", [job({ start: "2025-01", end: "2025-06" }), job({ company: "CRED", start: "2025-07", end: "2025-09" }), job({ company: "Jupiter", start: "2025-10", end: "2025-12" })]), R);
  ok("6 + 3 + 3 months across 3 product companies = 12 → every mandatory met", s.months === 12 && s.complete && s.finalScore >= 100, s);
}
{
  const s = scoreZg(ev("b", [job({ start: "2025-01", end: "2025-12" }), job({ company: "CRED", start: "2025-06", end: "2026-03" })]), R);
  ok("overlapping jobs counted once (15, not 22)", s.months === 15 && s.complete, s.months);
}
{
  const s = scoreZg(ev("c", [job({ company: "Tata Consultancy Services", companyType: "it-services", start: "2025-01", end: "2025-12" })]), R);
  ok("12 months at TCS → IT services background, not 100%", !s.complete && !s.met.noServices && s.finalScore <= 99, s);
}
{
  const s = scoreZg(ev("d", [job({ start: "2025-01", end: "2025-08" }), job({ company: "CRED", employmentType: "internship", start: "2024-06", end: "2024-11" })]), R);
  ok("8 months full-time + a 6-month internship → 8 (internships don't count)", s.months === 8 && !s.met.experience, s.months);
  const t = scoreZg(ev("d", s.jobs.map((j) => j.job)), { ...R, countInternships: true });
  ok("…with 'count internships' on → 14 and qualifies", t.months === 14 && t.complete, t.months);
}
{
  const s = scoreZg(ev("e", [job({ start: "2024-01", end: "2026-06" })]), R);
  ok("30 months → above the 12–23 window", s.months === 30 && !s.met.experience, s.months);
}
{
  const s = scoreZg(ev("f", [job({ start: "2025-01", end: "2025-12", roleFocus: "frontend" })]), R);
  ok("frontend-only role not counted", s.months === 0, s.months);
  const t = scoreZg(ev("f", [job({ start: "2025-01", end: "2025-12", roleFocus: "frontend" })]), { ...R, countFrontendMobile: true });
  ok("…counted with 'count frontend / mobile' on", t.months === 12 && t.complete, t.months);
}
{
  const s = scoreZg(ev("g", [job({ company: "Infosys", companyType: "it-services", employmentType: "internship", start: "2024-01", end: "2024-06" }), job({ start: "2025-01", end: "2025-12" })]), R);
  ok("an IT-services internship doesn't disqualify by default", s.complete, s.missing);
  const t = scoreZg(ev("g", s.jobs.map((j) => j.job)), { ...R, servicesInternshipDisqualifies: true });
  ok("…it does with the stricter rule on", !t.complete && !t.met.noServices, t.missing);
}
{
  const e = ev("h", [job({})]);
  e.skills.sql = { skills: "", projects: "", experience: "" };
  const s = scoreZg(e, R);
  ok("missing SQL → capped at 99 and named", !s.complete && s.finalScore <= 99 && s.missing.some((m) => /SQL/.test(m)), s);
}
{
  const s = scoreZg(ev("i", [job({ companyType: "unknown" })]), R);
  ok("employer type unclear → product not confirmed", !s.met.product && s.productUnclear, s);
}
{
  const s = scoreZg(ev("j", [job({ start: "2025-01", end: "2025-12", employmentType: "part-time" })]), R);
  ok("part-time not counted", s.months === 0, s.months);
}

section("statuses and ranking");
{
  const rich = ev("rich", [job({})], { goodToHave: { spring_boot: { skills: "", projects: "", experience: "Spring Boot" }, payments: { skills: "", projects: "x", experience: "" } } });
  const plain = ev("plain", [job({})]);
  const unclear = ev("unclear", [job({ companyType: "unknown" })]);
  const approx = ev("approx", [job({ datesApproximate: true })]);
  const tcs = ev("tcs", [job({ company: "TCS", companyType: "it-services" })]);
  const fresher = ev("fresher", [job({ employmentType: "internship" })]);
  const notResume = { ...failedZgEvaluation({ id: "photo", mobile: "photo", name: "", resumeUrl: "x" }, "a photograph", false), status: "invalid" as const };
  const cands = ["rich", "plain", "unclear", "approx", "tcs", "fresher", "photo", "pending"].map((id, i) => ({ id, mobile: id, name: id, resumeUrl: "x", batch: 1 + (i % 1) }));
  const ranked = rankZg(cands, { rich, plain, unclear, approx, tcs, fresher, photo: notResume }, R);
  const status = Object.fromEntries(ranked.map((r) => [r.id, r.status]));
  ok("full match with good-to-haves → Shortlisted", status.rich === "Shortlisted");
  ok("full match → Shortlisted", status.plain === "Shortlisted");
  ok("unclear product company, all else met → Review", status.unclear === "Review – Check Manually", ranked.find((r) => r.id === "unclear")?.reasons);
  ok("approximate dates → Review", status.approx === "Review – Check Manually");
  ok("TCS → Not Shortlisted", status.tcs === "Not Shortlisted");
  ok("internships only → No Relevant Full-time Experience", status.fresher === "No Relevant Full-time Experience", status.fresher);
  ok("photo → Invalid", status.photo === "Invalid – Not a Resume");
  ok("not screened yet → Pending", status.pending === "Pending");
  ok("good-to-haves rank first", ranked[0].id === "rich" && ranked[0].shortlistRank === 1 && (ranked[0].score?.finalScore ?? 0) > 100, ranked.map((r) => [r.id, r.score?.finalScore]));
  const top1 = rankZg(cands, { rich, plain }, { ...R, topN: 1 });
  ok("top-N cap moves the rest to 'Outside Top N'", top1.find((r) => r.id === "plain")?.status === "Qualified – Outside Top N");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
