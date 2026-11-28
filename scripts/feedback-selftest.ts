/**
 * Self-test for 1.13.0 applications and candidate feedback documents — pure parts only (no network,
 * no database, no model). Made-up people only.
 *   npx tsx scripts/feedback-selftest.ts
 */
import "./server-only-shim";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  buildApplications,
  dateOrderOf,
  findApplicationColumns,
  internalSheetsOf,
  jobOfTitle,
  matchApplicant,
  parseAppliedAt,
  poolLookup,
  readApplicationRows,
} from "@/lib/mobile/pool/applications";
import { parseCrpsMaster, resumeLinkOf, type Round } from "@/lib/mobile/pool/shares";
import { andList, jobSkills, roleFamily, skillShown, termInText } from "@/lib/feedback-docs/skills";
import {
  assembleJobs,
  buildContent,
  checkContent,
  chooseRequirement,
  comparisonGap,
  evaluateShare,
  factsFromLive,
  factsFromReview,
  type FbApplication,
  type FbJob,
  type FbRequirement,
  type FbShare,
  type FbSheet,
  type FeedbackInput,
  type ImportedReview,
  idDoneMonth,
  type JobFacts,
  jobsInPeriod,
  type JobReview,
  percentages,
  periodLabel,
  reasonOf,
  reasonText,
  type ResumeReview,
  resultText,
  resumeLabel,
  resumeLabels,
  roundLabelOf,
  skillNames,
} from "@/lib/feedback-docs/model";
import { assignmentRows, comparisonsOf, importRows, type ReviewAppRecord, type ReviewReasonRecord, tenDigits } from "@/lib/feedback-docs/review-import";
import { fallbackJob, hasNoProjectLinks, quoteShows, verifyJob } from "@/lib/feedback-docs/review";
import { feedbackText, renderFeedbackDocx } from "@/lib/feedback-docs/render";
import { evidenceText, workText } from "@/lib/resume-sections";
import { presets, validPeriod } from "@/lib/feedback-docs/service";
import { whatsappText } from "@/lib/feedback-docs/docs";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const tab = (title: string, gid = 0, hidden = false) => ({ title, gid, hidden, rowCount: 100, columnCount: 30 });
const IST = (s: string) => new Date(Date.parse(`${s.replace(" ", "T")}+05:30`));

// ── Applications (internal sheets) ──────────────────────────────────────────

const EXPORT_HEAD = ["Applied Datetime", "User Id", "Job Id", "Product", "Name", "Phone Number", "Email", "Bachelors Percentage", "Resume Link"];
const people = [
  { uid: "uid-asha-0001", phone: "9000000001", email: "asha@example.com" },
  { uid: "UID-Ravi-0002", phone: "9000000002", email: "ravi@example.com" },
  { uid: "uid-meena-0003", phone: "9000000003", email: "meena@example.com" },
];

test("platform export: header, rows, dates, resume links, UID match (case kept)", () => {
  const rows = [
    EXPORT_HEAD,
    ["2026-11-18 19:31:40", "uid-asha-0001", "JOB-A", "CCBP_ACADEMY", "Asha", "+91 90000 00001", "asha@example.com", "81", "https://files.example.com/resume/1795000000000_Asha_Resume_Data_Analyst_0a1b2c3d-1111-2222-3333-444455556666.pdf"],
    ["10/22/2026 19:18:16", "uid-ravi-0002", "job-a", "CCBP_ACADEMY", "Ravi", "9000000002", "", "75", "not a link"],
    ["2026-11-19 8:48:28", "uid-stranger", "JOB-A", "EDGE", "Someone", "9111111111", "x@example.com", "70", ""],
  ];
  const cols = findApplicationColumns(rows, "Applied Users")!;
  assert.equal(cols.source, "portal");
  const read = readApplicationRows(rows, cols, Date.UTC(2026, 11, 1));
  assert.equal(read.length, 3);
  assert.equal(read[0].appliedAt, IST("2026-11-18 19:31:40").getTime());
  assert.equal(read[1].appliedAt, IST("2026-10-22 19:18:16").getTime());
  assert.equal(read[1].resumeUrl, null);
  assert.equal(read[0].jobId, "job-a");
  const built = buildApplications({ jobIds: ["job-a"] }, [{ info: tab("Applied Users"), rows }], people, Date.UTC(2026, 11, 1));
  assert.equal(built.applications.length, 2);
  assert.deepEqual(built.applications.map((a) => a.uid).sort(), ["UID-Ravi-0002", "uid-asha-0001"]);
  assert.ok(!JSON.stringify(built).includes("9111111111"), "nobody else is kept");
});

test("older exports: snake / camel case headers (creation_datetime, user_id, registeredMobileNumber)", () => {
  const rows = [
    ["creation_datetime", "user_id", "resume", "product", "fullName", "registeredMobileNumber", "registeredEmailId", "job_id"],
    ["2026-06-05 10:05:36", "", "https://files.example.com/r.pdf", "ACADEMY", "Meena", "9000000003", "meena@example.com", "JOB-B"],
  ];
  const cols = findApplicationColumns(rows, "JD-1_Applied & PC Working")!;
  assert.ok(cols && cols.source === "portal" && cols.phones.length === 1 && cols.emails.length === 1 && cols.appliedAt === 0);
  const b = buildApplications({ jobIds: ["job-b"] }, [{ info: tab("JD-1_Applied & PC Working"), rows }], people, Date.UTC(2026, 11, 1));
  assert.equal(b.applications[0].uid, "uid-meena-0003");
  assert.equal(b.applications[0].appliedAt, IST("2026-06-05 10:05:36").getTime());
});

test("matching: a User Id outside the pool is nobody (even with a pool phone); shared phones match nobody", () => {
  const pool = poolLookup(people);
  assert.equal(matchApplicant({ userId: "uid-someone-else", phones: ["9000000001"], email: "asha@example.com" }, pool), null);
  assert.deepEqual(matchApplicant({ userId: null, phones: ["9000000001"], email: null }, pool), { uid: "uid-asha-0001", phone: "9000000001" });
  assert.deepEqual(matchApplicant({ userId: null, phones: [], email: "ravi@example.com" }, pool), { uid: "UID-Ravi-0002", phone: null });
  const twins = poolLookup([...people, { uid: "uid-twin-0004", phone: "9000000003", email: "twin@example.com" }]);
  assert.equal(matchApplicant({ userId: null, phones: ["9000000003"], email: null }, twins), null, "one phone, two people: no guess");
  assert.deepEqual(matchApplicant({ userId: null, phones: ["9000000003"], email: "twin@example.com" }, twins), { uid: "uid-twin-0004", phone: "9000000003" }, "the email decides; the row's phone is kept");
});

test("forms: application forms count, availability / assignment forms and our shortlists don't", () => {
  const form = [
    ["Timestamp", "Your Name", "Mobile Number\n\n👉 Enter a 10-digit mobile number", "Mail ID", "Upload your Updated Resume"],
    ["26/10/2026 18:33:56", "Asha", "9000000001", "asha@example.com", "https://drive.google.com/open?id=abc"],
    ["3/10/2026 9:00:00", "Ravi", "9000000002", "", ""],
  ];
  assert.equal(findApplicationColumns(form, "Total Applied")?.source, "form");
  assert.equal(findApplicationColumns(form, "Offline availability"), null);
  assert.equal(findApplicationColumns(form, "Assignment submissions"), null);
  const shortlist = [["Rank", "Name", "Phone", "Job Id", "Not shortlisted because"], ["1", "Asha", "9000000001", "JOB-A", ""]];
  assert.equal(findApplicationColumns(shortlist, "shortlist_final"), null);
  const profiles = [["Full Name", "Mobile Number", "Email Id", "Resume", "TR Round 1", "Final Status"], ["Asha", "9000000001", "a@example.com", "", "Selected", ""]];
  assert.equal(findApplicationColumns(profiles, "company Candidate Profiles"), null);
  // The column is day-first (26/10), so 3/10 is 3 October.
  const cols = findApplicationColumns(form, "Total Applied")!;
  const read = readApplicationRows(form, cols, Date.UTC(2026, 11, 1));
  assert.equal(read[1].appliedAt, IST("2026-10-03 09:00:00").getTime());
  // Nothing in the column decides it: a form is day-first (Indian locale), an export month-first.
  const undecided = [form[0], ["3/10/2026 9:00:00", "Ravi", "9000000002", "", ""]];
  assert.equal(readApplicationRows(undecided, findApplicationColumns(undecided, "Total Applied")!, Date.UTC(2026, 11, 1))[0].appliedAt, IST("2026-10-03 09:00:00").getTime());
  const exp = [EXPORT_HEAD, ["3/10/2026 9:00:00", "uid-ravi-0002", "JOB-A", "", "Ravi", "9000000002", "", "", ""]];
  assert.equal(readApplicationRows(exp, findApplicationColumns(exp, "Applied Users")!, Date.UTC(2026, 11, 1))[0].appliedAt, IST("2026-03-10 09:00:00").getTime());
  // A form belongs to the sheet's only job, or to the job whose role its title names.
  const one = buildApplications({ jobIds: ["job-a"] }, [{ info: tab("Total Applied"), rows: form }], people, Date.UTC(2026, 11, 1));
  assert.equal(one.applications.length, 2);
  assert.ok(one.applications.every((a) => a.jobId === "job-a" && a.source === "form"));
  const two = buildApplications(
    { jobIds: ["job-a", "job-b"], jobs: [{ jobId: "job-a", role: "Data Science Intern" }, { jobId: "job-b", role: "Software Engineer" }] },
    [{ info: tab("Data Science Intern Applied"), rows: form }],
    people,
    Date.UTC(2026, 11, 1),
  );
  assert.ok(two.applications.every((a) => a.jobId === "job-a"));
  const none = buildApplications({ jobIds: ["job-a", "job-b"] }, [{ info: tab("Applied"), rows: form }], people, Date.UTC(2026, 11, 1));
  assert.equal(none.applications.length, 0);
  assert.equal(none.noJob, 2);
});

test("dates: ISO, US, day-first, serial, zones; nonsense and the far future are null", () => {
  const now = Date.UTC(2026, 11, 1);
  assert.equal(parseAppliedAt("2026-11-18 19:31:40", "unknown", now), IST("2026-11-18 19:31:40").getTime());
  assert.equal(parseAppliedAt("2026-11-18T14:01:40Z", "unknown", now), Date.UTC(2026, 10, 18, 14, 1, 40));
  assert.equal(parseAppliedAt("11/2/2026 14:40:56", "mdy", now), IST("2026-11-02 14:40:56").getTime());
  assert.equal(parseAppliedAt("11/2/2026 14:40:56", "dmy", now), IST("2026-02-11 14:40:56").getTime());
  assert.equal(parseAppliedAt("26/10/2026 6:33 PM", "unknown", now), IST("2026-10-26 18:33:00").getTime());
  assert.equal(parseAppliedAt("46317.81682", "unknown", now) !== null, true);
  assert.equal(new Date(parseAppliedAt("46317.5", "unknown", now)! + 330 * 60_000).toISOString().slice(0, 13), "2026-10-22T12");
  assert.equal(parseAppliedAt("yesterday", "unknown", now), null);
  assert.equal(parseAppliedAt("2031-01-01 10:00:00", "unknown", now), null);
  assert.equal(parseAppliedAt("13/13/2026", "unknown", now), null);
  assert.equal(dateOrderOf(["10/22/2026 19:18:16", "11/2/2026"]), "mdy");
  assert.equal(dateOrderOf(["26/10/2026", "3/10/2026"]), "dmy");
  assert.equal(dateOrderOf(["1/2/2026"]), "unknown");
});

test("one application per candidate and job: the earliest, portal before form, resume from any row", () => {
  const exportRows = [EXPORT_HEAD, ["2026-11-10 10:00:00", "uid-asha-0001", "JOB-A", "", "Asha", "9000000001", "", "", ""]];
  const copy = [EXPORT_HEAD, ["2026-11-09 10:00:00", "uid-asha-0001", "JOB-A", "", "Asha", "9000000001", "", "", "https://files.example.com/a.pdf"]];
  const b = buildApplications({ jobIds: ["job-a"] }, [{ info: tab("Applied Users"), rows: exportRows }, { info: tab("Copy of Applied Users", 1, true), rows: copy }], people, Date.UTC(2026, 11, 1));
  assert.equal(b.applications.length, 1);
  assert.equal(b.applications[0].appliedAt, IST("2026-11-09 10:00:00").getTime());
  assert.equal(b.applications[0].resumeUrl, "https://files.example.com/a.pdf");
  assert.equal(b.tabsRead, 2);
});

test("internal sheets from the CRPs master: Internal sheet Link parsed, job ids per sheet, ID month", () => {
  const master = parseCrpsMaster([
    ["Company Name", "Role", "JOB ID", "CRP Month", "Company ID Status", "ID Month", "Internal sheet Link", "Company Sheet Link"],
    ["Acme", "Data Analyst", "JOB-A", "Nov", "ID Done", "Nov", "https://docs.google.com/spreadsheets/d/1InternalSheetAcme0000000000000/edit", "https://docs.google.com/spreadsheets/d/1CompanySheetAcme00000000000000/edit"],
    ["", "SDE", "JOB-B", "Nov", "", "", "https://docs.google.com/spreadsheets/d/1InternalSheetAcme0000000000000/edit#gid=3", ""],
    ["Globex", "QA", "JOB-C", "Oct", "", "", "not a link", ""],
  ]);
  assert.equal(master.requirements[0].internalSheetId, "1InternalSheetAcme0000000000000");
  assert.equal(master.requirements[0].idMonth, "Nov");
  assert.equal(master.requirements[2].internalSheetId, null);
  const sheets = internalSheetsOf(master.requirements);
  assert.equal(sheets.length, 1);
  assert.deepEqual(sheets[0].jobIds, ["job-a", "job-b"]);
  assert.equal(jobOfTitle("JD 2 Applied SDE", sheets[0].jobs), "job-b");
  assert.equal(jobOfTitle("Form Responses 1", sheets[0].jobs), "");
  assert.equal(resumeLinkOf("https://files.example.com/x.pdf"), "https://files.example.com/x.pdf");
  assert.equal(resumeLinkOf("Resume"), null);
});

// ── Skills ──────────────────────────────────────────────────────────────────

test("tech stack items, usual names, alternatives, lists in brackets, soft skills", () => {
  const s = jobSkills("Python, React js, Excel/Google Sheets, AWS, Azure, Google Cloud Platform (GCP), operational problem-solving, AI/ML");
  const by = (l: string) => s.find((x) => x.label === l)!;
  assert.ok(by("React").terms.includes("react"));
  assert.ok(by("Excel or Google Sheets").terms.includes("google sheets"));
  assert.ok(by("Google Cloud").terms.includes("gcp"));
  assert.equal(by("operational problem-solving").checkable, false);
  assert.ok(by("AI/ML").terms.includes("machine learning"));
  assert.equal(jobSkills("C, C++, Linux").length, 3);
  // "&" and " + " join two skills; brackets with a list are the items; "or" is one either-or skill.
  const t = jobSkills("HTML & CSS, React + Node.js, Python (Pandas, NumPy), Java or Python");
  assert.ok(["HTML", "CSS", "React", "Node.js", "Python", "Pandas", "NumPy"].every((l) => t.some((x) => x.label === l)), t.map((x) => x.label).join(" | "));
  const either = t.find((x) => x.terms.includes("java"))!;
  assert.ok(either.terms.includes("python") && either.checkable, "Java or Python: one skill, either is enough");
  assert.ok(jobSkills("C++").some((x) => x.terms.includes("c++")), "C++ keeps its pluses");
});

test("whole-word matching: java ≠ javascript, C ≠ C++, react ≠ reactive, excel ≠ excellent", () => {
  assert.equal(termInText("java", "Built with JavaScript"), false);
  assert.equal(termInText("java", "Java, Spring Boot"), true);
  assert.equal(termInText("c", "Languages: C++, Python"), false);
  assert.equal(termInText("c", "Languages: C, C++"), true);
  assert.equal(termInText("c", "C. Ramesh"), false);
  assert.equal(termInText("react", "a reactive system"), false);
  assert.equal(termInText("react", "React.js app"), true);
  assert.equal(termInText("excel", "excellent communication"), false);
  assert.equal(termInText("sql", "MySQL database"), false);
  assert.equal(termInText("mysql", "MySQL database"), true);
  assert.equal(termInText("node.js", "Node.js and Express"), true);
  assert.equal(termInText("power bi", "PowerBI dashboard"), true);
  assert.equal(termInText("power bi", "Power-BI dashboard"), true);
  assert.equal(termInText("powerbi", "PowerBI dashboard"), true);
});

const RESUME = [
  "Asha Rao",
  "asha@example.com | linkedin.com/in/asha",
  "SKILLS",
  "Python, SQL, Power BI, Linux, Docker",
  "PROJECTS",
  "Sales Dashboard — built a Power BI dashboard on 2 lakh rows with SQL views; cut report time by 40%.",
  "Chat Assistant — a RAG chatbot in Python with LangChain.",
  "EXPERIENCE",
  "Data Analyst Intern, Acme Retail (May–Jul 2026): wrote SQL reports for the sales team.",
  "EDUCATION",
  "B.Tech, Example University, 2026",
].join("\n");
const EVIDENCE = evidenceText(RESUME).text;
/** A resume's texts as the review reads them. */
const texts = (text: string) => {
  const w = workText(text);
  return { text, evidence: evidenceText(text).text, work: w.text, workTrusted: w.trusted };
};
const RT = texts(RESUME);

test("where a resume shows a skill: projects, only the Skills list, nowhere; the work part", () => {
  assert.equal(skillShown({ terms: ["sql"] }, RESUME, EVIDENCE), "in_projects");
  assert.equal(skillShown({ terms: ["linux"] }, RESUME, EVIDENCE), "listed_only");
  assert.equal(skillShown({ terms: ["kubernetes", "k8s"] }, RESUME, EVIDENCE), "not_shown");
  assert.equal(RT.workTrusted, true);
  assert.ok(RT.work.includes("Sales Dashboard") && RT.work.includes("Acme Retail") && !RT.work.includes("Example University") && !RT.work.includes("Linux"));
  assert.equal(workText("Asha Rao\nPython, SQL").trusted, false, "no headings: the work part can't be told apart");
  assert.equal(roleFamily("Data Analyst Intern"), "data analytics");
  assert.equal(roleFamily("Frontend Developer"), "frontend development");
  assert.equal(roleFamily("Agentic AI Intern"), "AI and machine learning");
  assert.equal(andList(["a", "b", "c"]), "a, b and c");
});

// ── Resume review checks (no model) ─────────────────────────────────────────

const JOB = { key: "job:j1", company: "Globex", role: "Data Engineer", techStack: "Python, SQL, Kubernetes, Linux", jdUrl: null };

test("the model's core skills are checked against the job and the resume", () => {
  const raw = {
    coreSkills: [
      { skill: "SQL", terms: ["SQL"], shown: "not_shown", quote: "" }, // the text has it: in_projects
      { skill: "Kubernetes", terms: ["Kubernetes"], shown: "in_projects", quote: "deployed on Kubernetes" }, // quote isn't there: unverified
      { skill: "Spark", terms: ["Spark"], shown: "not_shown", quote: "" }, // not in this job's stack: dropped
    ],
    fit: 2,
    fitNote: "\"Data profile, not frontend.\"",
    sameFieldInternship: false,
    internshipQuote: "",
  };
  const r = verifyJob(raw, JOB, null, RT);
  assert.deepEqual(r.core, [
    { skill: "SQL", shown: "in_projects" },
    { skill: "Kubernetes", shown: "unverified" },
  ]);
  assert.deepEqual(r.listedOnly, ["Linux"]);
  assert.deepEqual(r.mustNotShown, []);
  assert.deepEqual(r.shownSkills, ["SQL"]);
  assert.equal(r.fit, 2);
  assert.equal(r.fitNote, "data profile, not frontend");
  // The resume has an internship: "no internship in the same field" is never said then.
  assert.equal(r.sameFieldInternship, null);
  const none = texts("PROJECTS\nA Python ETL pipeline loading SQL tables.\nSKILLS\nLinux");
  assert.equal(verifyJob(raw, JOB, null, none).sameFieldInternship, false);
  // No answer for this job: the tech stack alone.
  assert.equal(verifyJob(undefined, JOB, null, RT).fallback, true);
});

test("quotes are checked strictly: long enough, word for word, naming the skill", () => {
  assert.equal(quoteShows("Power BI dashboard on 2 lakh rows", RESUME, ["power bi"]), true);
  assert.equal(quoteShows("Power BI", RESUME, ["power bi"]), false, "too short");
  assert.equal(quoteShows("Power BI dashboard on 3 lakh rows", RESUME, ["power bi"]), false, "not in the text");
  assert.equal(quoteShows("dashboard on 2 lakh rows with", RESUME, ["power bi"]), false, "doesn't name the skill");
});

test("without the model: the tech stack alone, never more than the text shows", () => {
  const small = fallbackJob({ ...JOB, techStack: "Python, Kubernetes" }, RT);
  assert.deepEqual(small.core, [
    { skill: "Python", shown: "in_projects" },
    { skill: "Kubernetes", shown: "not_shown" },
  ]);
  assert.deepEqual(small.shownSkills, ["Python"]);
  const big = fallbackJob({ ...JOB, techStack: "Python, SQL, Docker, Linux, Terraform" }, RT);
  assert.deepEqual(big.core, []);
  assert.deepEqual(big.mustNotShown, ["Terraform"]);
  assert.equal(big.fallback, true);
  assert.equal(hasNoProjectLinks(["https://linkedin.com/in/asha", "mailto:asha@example.com"]), true);
  assert.equal(hasNoProjectLinks(["https://github.com/asha"]), false);
  assert.equal(hasNoProjectLinks(["https://asha-dashboard.vercel.app"]), false);
});

test("alternatives: AWS shown, so Azure and Google Cloud aren't missing", () => {
  const t = texts("PROJECTS\nDeployed the API on AWS Lambda with Docker.\nSKILLS\nPython, React");
  const r = verifyJob({ coreSkills: [], fit: 4, fitNote: "", sameFieldInternship: true, internshipQuote: "" }, { ...JOB, techStack: "AWS, Azure, Google Cloud Platform (GCP), Python, Angular, React js, Terraform" }, null, t);
  assert.deepEqual(r.mustNotShown, ["Terraform"]);
  assert.deepEqual(r.listedOnly, ["Python", "React"]);
  const viaAlt = verifyJob(
    { coreSkills: [{ skill: "Google Cloud", terms: ["Google Cloud Platform (GCP)"], shown: "not_shown", quote: "" }], fit: 4, fitNote: "", sameFieldInternship: true, internshipQuote: "" },
    { ...JOB, techStack: "AWS, Google Cloud Platform (GCP)" },
    null,
    t,
  );
  // Shown through its alternative (AWS); the name printed is the job's own wording, not the model's.
  assert.deepEqual(viaAlt.core, [{ skill: "Google Cloud Platform (GCP)", shown: "in_projects" }]);
  const f = fallbackJob({ ...JOB, techStack: "AWS, Azure, Kubernetes" }, t);
  assert.deepEqual(f.core, [
    { skill: "AWS", shown: "in_projects" },
    { skill: "Kubernetes", shown: "not_shown" },
  ]);
});

// ── Jobs and outcomes ───────────────────────────────────────────────────────

const req = (o: Partial<FbRequirement> & Pick<FbRequirement, "key" | "company" | "role" | "jobId">): FbRequirement => ({
  sheetId: null,
  crpMonth: "Nov",
  crpYear: 2026,
  crpWeek: null,
  finalStatus: "",
  stage: "",
  idStatus: "",
  academySent: null,
  assessedSent: null,
  nonAssessedSent: null,
  techStack: "",
  jdUrl: null,
  ...o,
});
const R = (name: string, value: string): Round => ({ name, value });
const share = (o: Partial<FbShare> & Pick<FbShare, "sheetId" | "tab">): FbShare => ({
  id: "1",
  role: o.tab,
  company: "Acme",
  rounds: [],
  finalStatus: "",
  own: "shared",
  firstSeen: new Date(Date.UTC(2026, 10, 5)),
  resumeUrl: null,
  ...o,
});
const job = { jobId: "", company: "Acme" };
/** A company sheet: readable or not, and Academy rows per tab. */
const sheet = (readable: boolean, tabs: Record<string, number> = {}): FbSheet => ({ readable, tabs: new Map(Object.entries(tabs)) });

test("a company row: the resume stage, then the rounds (a rejection is never reopened)", () => {
  const tr1 = evaluateShare({ rounds: [R("Screening Round", "Selected"), R("TR Round 1", "Rejected"), R("Interview status", "Done")], finalStatus: "", own: "rejected" }, "open", job, []);
  assert.equal(tr1.outcome, "selected");
  assert.deepEqual(tr1.items.map((i) => [i.label, i.result]), [["TR1", "not cleared"]]);
  assert.equal(evaluateShare({ rounds: [R("Screening Round", "Rejected")], finalStatus: "", own: "rejected" }, "open", job, []).outcome, "not_forwarded");
  assert.equal(evaluateShare({ rounds: [], finalStatus: "Rejected", own: "rejected" }, "open", job, []).outcome, "not_forwarded");
  assert.equal(evaluateShare({ rounds: [R("TR Round 1", "Not shortlisted")], finalStatus: "", own: "rejected" }, "open", job, []).outcome, "not_forwarded");
  assert.equal(evaluateShare({ rounds: [], finalStatus: "", own: "shared" }, "open", job, []).outcome, "awaited");
  assert.equal(evaluateShare({ rounds: [], finalStatus: "", own: "shared" }, "closed", job, []).outcome, "closed");
  const hold = evaluateShare({ rounds: [], finalStatus: "", own: "shared" }, "on_hold", job, []);
  assert.equal(hold.outcome, "awaited");
  assert.deepEqual(hold.flags, ["on_hold"]);
  const absent = evaluateShare({ rounds: [R("Screening Round", "Selected"), R("TR Round 1", "Absent")], finalStatus: "", own: "no_show" }, "open", job, []);
  assert.equal(absent.outcome, "selected");
  assert.equal(absent.items[0].result, "did not attend");
  const asg = evaluateShare({ rounds: [R("Screening Round", "Selected"), R("Assignment Round", "Submitted")], finalStatus: "", own: "awaiting" }, "open", job, []);
  assert.deepEqual(asg.items.map((i) => [i.kind, i.result]), [["assignment", "submitted, result awaited"]]);
  const hired = evaluateShare({ rounds: [R("TR Round 1", "Cleared"), R("HR Round", "Cleared")], finalStatus: "Offer released", own: "selected" }, "open", job, []);
  assert.deepEqual(hired.items.map((i) => i.result), ["cleared", "cleared", "selected (offer)"]);
  assert.deepEqual(roundLabelOf("Technical Round 2"), { label: "TR2", kind: "interview" });
  assert.deepEqual(roundLabelOf("Online Assessment"), { label: "Online test", kind: "test" });
});

test("a company row: 'not shortlisted' after a cleared round is that round's result; closed-only rounds and bulk rejections", () => {
  const afterScreen = evaluateShare({ rounds: [R("Screening Round", "Selected"), R("TR Round 1", "Not shortlisted")], finalStatus: "", own: "rejected" }, "open", job, []);
  assert.equal(afterScreen.outcome, "selected");
  assert.deepEqual(afterScreen.items.map((i) => [i.label, i.result]), [["TR1", "not cleared"]]);
  const afterTr1 = evaluateShare({ rounds: [R("TR Round 1", "Cleared"), R("TR Round 2", "Not shortlisted")], finalStatus: "", own: "rejected" }, "open", job, []);
  assert.equal(afterTr1.outcome, "selected");
  assert.deepEqual(afterTr1.items.map((i) => [i.label, i.result]), [["TR1", "cleared"], ["TR2", "not cleared"]]);
  // A round that only says the requirement closed doesn't show the company took the profile forward.
  assert.equal(evaluateShare({ rounds: [R("TR Round 1", "Requirement closed")], finalStatus: "", own: "closed" }, "closed", job, []).outcome, "closed");
  // Every round "Rejected" at once: the row was marked, the profile wasn't taken forward.
  assert.equal(evaluateShare({ rounds: [R("HR Round", "Rejected"), R("Assessment Round", "Rejected")], finalStatus: "", own: "rejected" }, "open", job, []).outcome, "not_forwarded");
});

test("interview dates come from the drill-down (job id, else company), cancelled rows ignored", () => {
  const ivs = [
    { jobId: "JOB-A", company: "Acme - SDE", round: "TR1", day: "2026-11-03", cancelled: false },
    { jobId: "JOB-A", company: "Acme - SDE", round: "TR1", day: "2026-11-06", cancelled: true },
  ];
  const v = evaluateShare({ rounds: [R("Screening Round", "Selected"), R("TR Round 1", "Rejected")], finalStatus: "", own: "rejected" }, "open", { jobId: "job-a", company: "Acme" }, ivs);
  assert.equal(v.items[0].day, "2026-11-03");
});

const NOV = { from: "2026-11-01", to: "2026-11-30" };
const sheets = (o: Record<string, FbSheet>) => new Map(Object.entries(o));

function inputFor(o: Partial<FeedbackInput>): Omit<FeedbackInput, "period"> {
  return { candidate: { uid: "uid-asha-0001", name: "Asha Rao" }, requirements: [], applications: [], shares: [], sheets: new Map(), interviews: [], today: "2026-11-28", ...o };
}

test("applications without a company result: not selected, awaited, unverified, not known", () => {
  const requirements = [
    req({ key: "r1", company: "Acme", role: "Data Analyst", jobId: "JOB-A", sheetId: "sheetA", assessedSent: 4 }),
    req({ key: "r2", company: "Globex", role: "SDE", jobId: "JOB-B", sheetId: "sheetB" }),
    req({ key: "r3", company: "Initech", role: "QA", jobId: "JOB-C", sheetId: "sheetC" }),
    req({ key: "r4", company: "Umbrella", role: "ML Engineer", jobId: "JOB-D", sheetId: null, finalStatus: "Requirement Closed" }),
    req({ key: "r5", company: "Hooli", role: "Backend", jobId: "JOB-E", sheetId: "sheetE", finalStatus: "Closed" }),
    req({ key: "r6", company: "Pied Piper", role: "Data Engineer", jobId: "JOB-F", sheetId: "sheetF" }),
  ];
  const at = new Date(Date.UTC(2026, 10, 2));
  const applications: FbApplication[] = ["job-a", "job-b", "job-c", "job-d", "job-e", "job-f", "job-zzz"].map((j) => ({ jobId: j, appliedAt: at, resumeUrl: null, source: "portal" }));
  const jobs = assembleJobs(
    inputFor({
      requirements,
      applications,
      sheets: sheets({ sheetA: sheet(true), sheetB: sheet(true), sheetC: sheet(false), sheetE: sheet(true), sheetF: sheet(true, { "Batch 1": 6, "Applied Users": 40 }) }),
    }),
  );
  const by = (c: string) => jobs.find((j) => j.company === c)!;
  assert.equal(jobs.length, 6, "a job the master doesn't list is left out");
  assert.equal(by("Acme").outcome, "not_shortlisted");
  assert.deepEqual(by("Acme").flags, ["still_open"]);
  assert.equal(by("Globex").outcome, "awaited");
  assert.equal(by("Initech").outcome, "awaited");
  assert.deepEqual(by("Initech").flags, ["unverified"]);
  assert.equal(by("Umbrella").outcome, "not_known");
  assert.equal(by("Hooli").outcome, "closed");
  // Profiles were sent in the job's shared tab (its applications tab doesn't count): not selected.
  assert.equal(by("Pied Piper").outcome, "not_shortlisted");
});

test("a share and an application of the same job are one job; batches pick their CRP row", () => {
  const requirements = [
    req({ key: "b1", company: "Nimbus", role: "Frontend Intern", jobId: "JOB-S", sheetId: "sheetS", crpMonth: "Oct", crpWeek: 5 }),
    req({ key: "b2", company: "Nimbus", role: "Frontend Intern", jobId: "JOB-S", sheetId: "sheetS", crpMonth: "Nov", crpWeek: 3 }),
  ];
  const applications: FbApplication[] = [{ jobId: "job-s", appliedAt: IST("2026-11-12 10:00:00"), resumeUrl: "https://files.example.com/r1.pdf", source: "portal" }];
  const shares = [share({ sheetId: "sheetS", tab: "Batch 3 || 18 Nov 2026", rounds: [R("Screening Round", "Selected"), R("TR Round 1", "Cleared")], own: "in_process" })];
  const jobs = assembleJobs(inputFor({ requirements, applications, shares, sheets: sheets({ sheetS: sheet(true, { "Batch 3 || 18 Nov 2026": 3 }) }) }));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].requirement?.key, "b2");
  assert.equal(jobs[0].outcome, "selected");
  assert.equal(jobsInPeriod(jobs, NOV).length, 1);
  assert.equal(jobsInPeriod(jobs, { from: "2026-10-01", to: "2026-10-31" }).length, 0);
  assert.equal(chooseRequirement(requirements, { when: IST("2026-10-27 10:00:00") })?.key, "b1");
  assert.equal(chooseRequirement(requirements, { when: IST("2026-12-27 10:00:00") })?.key, "b2");
});

test("a sheet with several roles: the tab names the role, else the job the candidate applied to; else not known", () => {
  const requirements = [
    req({ key: "f", company: "Zeta", role: "Frontend Developer", jobId: "JOB-F", sheetId: "sheetZ" }),
    req({ key: "b", company: "Zeta", role: "Backend Developer", jobId: "JOB-G", sheetId: "sheetZ" }),
  ];
  const named = assembleJobs(inputFor({ requirements, shares: [share({ sheetId: "sheetZ", tab: "JD-2 || Backend Developer" })], sheets: sheets({ sheetZ: sheet(true, { "JD-2 || Backend Developer": 1 }) }) }));
  assert.equal(named[0].role, "Backend Developer");
  const byApp = assembleJobs(
    inputFor({
      requirements,
      applications: [{ jobId: "job-f", appliedAt: null, resumeUrl: null, source: "portal" }],
      shares: [share({ sheetId: "sheetZ", tab: "Batch 1" })],
      sheets: sheets({ sheetZ: sheet(true, { "Batch 1": 1 }) }),
    }),
  );
  assert.equal(byApp.length, 1);
  assert.equal(byApp[0].role, "Frontend Developer");
  assert.equal(byApp[0].applied && byApp[0].shared, true);
  // Applied to both, and a row of theirs in a tab that names neither: neither job can be concluded.
  const both = assembleJobs(
    inputFor({
      requirements,
      applications: [
        { jobId: "job-f", appliedAt: null, resumeUrl: null, source: "portal" },
        { jobId: "job-g", appliedAt: null, resumeUrl: null, source: "portal" },
      ],
      shares: [share({ sheetId: "sheetZ", tab: "Batch 1" })],
      sheets: sheets({ sheetZ: sheet(true, { "Batch 1": 4 }) }),
    }),
  );
  for (const j of both.filter((x) => x.key.startsWith("job:"))) {
    assert.equal(j.outcome, "not_known");
    assert.deepEqual(j.flags, ["ambiguous"]);
  }
});

test("the period: the CRP month, or the month the job's ID was done", () => {
  const requirements = [
    req({ key: "i1", company: "Zeta", role: "QA", jobId: "J-ID", crpMonth: "Sep", idStatus: "ID Done", idMonth: "Nov", idYear: 2026 }),
    req({ key: "i2", company: "Yotta", role: "QA", jobId: "J-NO", crpMonth: "Sep", idStatus: "ID Pending", idMonth: "Nov", idYear: 2026 }),
    req({ key: "i3", company: "Xeno", role: "QA", jobId: "J-NM", crpMonth: "", crpYear: null }),
  ];
  const applications: FbApplication[] = [
    { jobId: "j-id", appliedAt: IST("2026-09-20 10:00:00"), resumeUrl: null, source: "portal" },
    { jobId: "j-no", appliedAt: IST("2026-09-20 10:00:00"), resumeUrl: null, source: "portal" },
    { jobId: "j-nm", appliedAt: IST("2026-11-04 10:00:00"), resumeUrl: null, source: "portal" },
  ];
  const all = assembleJobs(inputFor({ requirements, applications }));
  assert.deepEqual(idDoneMonth(requirements[0]), { from: "2026-11-01", to: "2026-11-30" });
  assert.equal(idDoneMonth(requirements[1]), null);
  assert.deepEqual(jobsInPeriod(all, NOV).map((j) => j.company).sort(), ["Xeno", "Zeta"]);
  assert.deepEqual(jobsInPeriod(all, { from: "2026-09-01", to: "2026-09-30" }).map((j) => j.company).sort(), ["Yotta", "Zeta"]);
});

// ── An imported review (the November Academy review) ────────────────────────

const REASONS: ReviewReasonRecord[] = [
  {
    job: "JOB-R1",
    phone: "+91 90000 00001",
    group: "Rejected by company",
    primary: "Meets the basics, others were stronger",
    reasons: ["Meets the basics, others were stronger"],
    details: ["fit 4 of 5"],
    resume: "https://files.example.com/resume/1795000000000_Asha_Rao_Resume_Data_Analyst_0a1b2c3d-1111-2222-3333-444455556666.pdf",
    rd: { readable: true, must_have_met: ["SQL", "Excel"], must_have_missing: [], relevant_project: true, relevant_internship: false, coding_profile_or_github: false, resume_quality_issues: ["No links"], fit_1to5: 4, evidence: "made up" },
    checked: "read twice",
    recorded: { verdict: "Shortlisted" },
  },
  { job: "job-r1", phone: "9000000001", group: "Sent by us", primary: "Sent", rd: { readable: true, fit_1to5: 3 } },
  {
    job: "JOB-R2",
    phone: "9000000001",
    group: "Not sent by us",
    primary: "JD skills not shown in projects or work",
    rd: { readable: true, must_have_met: [], must_have_missing: ["Power BI", "Tableau"], relevant_project: false, resume_quality_issues: ["Skills not backed by projects"], fit_1to5: 2 },
    recorded: { verdict: "Not shortlisted / low band" },
    resume: "not a link",
  },
  { job: "JOB-R1", phone: "9000000011", group: "Passed company screening", rd: { readable: true, relevant_internship: true, coding_profile_or_github: true, relevant_project: true, must_have_missing: [], fit_1to5: 4 } },
  { job: "JOB-R1", phone: "9000000012", group: "Passed company screening", rd: { readable: true, relevant_internship: true, coding_profile_or_github: true, resume_quality_issues: ["No links"], relevant_project: false, must_have_missing: ["SQL"], fit_1to5: 3 } },
  { job: "JOB-R1", phone: "9000000012", group: "Passed company screening", rd: { readable: true, relevant_internship: true, fit_1to5: 3 } },
  { job: "JOB-R1", phone: "9000000013", group: "Passed company screening", rd: { readable: false } },
];
const APPS: ReviewAppRecord[] = [
  { job: "JOB-R1", phone: "9000000001", applied: true, status: "sent", decision: "rejected" },
  { job: "JOB-R2", phone: "9000000001", applied: true, status: "not sent" },
  { job: "JOB-R3", phone: "9000000001", applied: true, status: "sent", decision: "selected" },
];
const ASG_TABLE = [
  ["Nov assignments – Candidates"],
  ["Name", "Phone", "Job ID", "Result (bucket)", "Main gap"],
  ["Asha", { x: "9000000001" }, "JOB-R3", "Rejected", "[Backend] Core requirements missing (others were stronger)"],
  ["Nobody", "", "JOB-R3", "Selected", ""],
];
const asOf = (phone: string) =>
  importRows(REASONS, APPS, assignmentRows(ASG_TABLE))
    .filter((r) => r.phone === phone)
    .map(({ phone: _p, ...r }): ImportedReview => ({ ...r, source: "review-test" }));

test("review import: one row per person and job, the company-screening record first, counts only in comparisons", () => {
  assert.equal(tenDigits("+91 90000 00001"), "9000000001");
  assert.equal(tenDigits("12345"), "");
  const rows = asOf("9000000001");
  const by = (j: string) => rows.find((r) => r.jobId === j)!;
  assert.deepEqual(rows.map((r) => r.jobId).sort(), ["job-r1", "job-r2", "job-r3"]);
  assert.deepEqual([by("job-r1").applied, by("job-r1").sent, by("job-r1").decision], [true, true, "rejected"]);
  assert.equal(by("job-r1").primaryReason, "Meets the basics, others were stronger");
  assert.equal(by("job-r1").screening, "Shortlisted");
  assert.ok(by("job-r1").resumeUrl?.startsWith("https://files.example.com/"));
  assert.deepEqual([by("job-r2").sent, by("job-r2").decision, by("job-r2").resumeUrl], [false, null, null]);
  assert.deepEqual(by("job-r3").assignment, { result: "Rejected", gap: "[Backend] Core requirements missing (others were stronger)" });
  assert.equal(by("job-r3").read.readable, false, "no read on record");
  assert.ok(!("evidence" in by("job-r1").read), "free text isn't stored");
  const comps = comparisonsOf(REASONS);
  assert.deepEqual(comps.get("job-r1"), { selected: 2, withInternship: 2, withLinks: 1, withProject: 1, allMustHaves: 1, fitAvg: 3.5 });
  assert.ok(!JSON.stringify([...comps.values()]).includes("9000000011"));
});

test("review facts: the review's main reasons become the document's, with the resume's tags", () => {
  const rows = asOf("9000000001");
  const f1 = factsFromReview(rows.find((r) => r.jobId === "job-r1")!);
  assert.equal(f1.reason, "fits");
  assert.deepEqual(f1.shownSkills, ["SQL", "Excel"]);
  assert.deepEqual([...f1.tags].sort(), ["no_internship", "no_links"]);
  const f2 = factsFromReview(rows.find((r) => r.jobId === "job-r2")!);
  assert.equal(f2.reason, "core_missing");
  assert.deepEqual(f2.core, [{ skill: "Power BI", shown: "listed_only" }, { skill: "Tableau", shown: "listed_only" }]);
  assert.deepEqual([...f2.tags].sort(), ["listed_only", "low_fit", "low_score", "must_missing"]);
  assert.equal(f2.noRelevantProject, true);
  const base = rows.find((r) => r.jobId === "job-r1")!;
  // A job rule (marks, branch, college list) is told by what the resume shows, as in the approved sample.
  assert.equal(factsFromReview({ ...base, primaryReason: "Marks below the cut-off", read: { readable: true, must_have_missing: ["Excel"] } }).reason, "core_missing");
  assert.equal(factsFromReview({ ...base, primaryReason: "Marks below the cut-off", read: { readable: true, must_have_missing: [] } }).reason, "fits");
  assert.equal(factsFromReview({ ...base, primaryReason: "Needs full-time experience", read: { readable: true } }).reason, "experience");
  const bad = factsFromReview({ ...base, primaryReason: "Unreadable / not a resume", read: { readable: false } });
  assert.deepEqual([bad.reason, bad.readable, bad.tags], ["unreadable", false, ["unreadable"]]);
  // Long phrases stay out of the sentence.
  assert.deepEqual(factsFromReview({ ...base, read: { readable: true, must_have_met: ["SQL", "Strong communication skills", "Data modelling (star schema)"] } }).shownSkills, ["SQL"]);
  // Only technical skills are named: a degree, a city or "2+ years" isn't a skill the resume lacks.
  assert.deepEqual(skillNames(["CS/IT degree", "Bangalore office", "RAG + LLM", "Power BI / Tableau", "2+ years experience", "rag"]), ["RAG", "LLM", "Power BI or Tableau"]);
  const rule = factsFromReview({ ...base, primaryReason: "Branch not eligible", read: { readable: true, must_have_missing: ["CS/IT degree", "Bangalore office"], must_have_met: ["CS/IT degree", "Python"] } });
  assert.deepEqual([rule.reason, rule.tags.includes("must_missing"), rule.shownSkills], ["fits", false, ["Python"]]);
});

test("how the selected candidates compared: said only when most of at least 2 had it", () => {
  const f = factsFromReview(asOf("9000000001").find((r) => r.jobId === "job-r1")!);
  const c = { selected: 2, withInternship: 2, withLinks: 1, withProject: 1, allMustHaves: 1, fitAvg: 3.5 };
  assert.equal(comparisonGap(f, c), "most selected had a same-field internship");
  assert.equal(comparisonGap(f, { ...c, selected: 1, withInternship: 1 }), null, "one person isn't a pattern");
  assert.equal(comparisonGap(f, { ...c, selected: 5, withInternship: 2, withLinks: 4 }), "most selected had GitHub or project links");
  assert.equal(comparisonGap(f, { ...c, selected: 5, withInternship: 2, withLinks: 2 }), null);
  const j = { outcome: "not_forwarded", resumeUrl: null } as FbJob;
  assert.equal(reasonText(j, "fits", f, c), "Stronger candidates chosen by company; most selected had a same-field internship");
  assert.equal(reasonText(j, "fits", f, undefined), "Stronger candidates chosen by company; no GitHub link");
});

test("jobs with an imported review: its decision where the company sheet shows none, its assignment result", () => {
  const requirements = [
    req({ key: "q1", company: "Acme", role: "Data Analyst", jobId: "JOB-R1", sheetId: "shR1" }),
    req({ key: "q2", company: "Globex", role: "BI Analyst", jobId: "JOB-R2", sheetId: null }),
    req({ key: "q3", company: "Initech", role: "Backend Intern", jobId: "JOB-R3", sheetId: "shR3" }),
    req({ key: "q4", company: "Hooli", role: "SDE", jobId: "JOB-R4", sheetId: "shR4" }),
  ];
  const reviews = [...asOf("9000000001"), { ...asOf("9000000001")[0], jobId: "job-r4", decision: "selected" as const, sent: true }];
  const shares = [share({ sheetId: "shR4", tab: "JD-1", company: "Hooli", rounds: [R("Screening Round", "Rejected")], own: "rejected" })];
  const jobs = assembleJobs(inputFor({ requirements, shares, reviews, sheets: sheets({ shR1: sheet(true), shR3: sheet(true), shR4: sheet(true, { "JD-1": 3 }) }) }));
  const by = (c: string) => jobs.find((x) => x.company === c)!;
  assert.deepEqual([by("Acme").outcome, by("Acme").applied, by("Acme").flags], ["not_forwarded", true, ["review"]]);
  assert.deepEqual([by("Globex").outcome, by("Globex").flags], ["not_shortlisted", ["review"]], "not sent by us: not selected (no 'unverified')");
  assert.equal(by("Initech").outcome, "selected");
  assert.equal(by("Hooli").outcome, "not_forwarded", "the company sheet's own result stands");
  assert.ok(by("Acme").resumeUrl?.startsWith("https://files.example.com/"), "the resume the review read");
  assert.equal(resultText(by("Initech")), "Selected by company; assignment not cleared");
  const facts = new Map<string, JobFacts>(jobs.filter((x) => x.review).map((x) => [x.key, factsFromReview(x.review!)]));
  const c = buildContent(jobs, {
    candidate: { uid: "uid-asha-0001", name: "Asha Rao" },
    period: NOV,
    today: "2026-11-28",
    facts,
    comparisons: comparisonsOf(REASONS),
    model: null,
    applicationsReadAt: new Date(),
    sourcesMissing: [],
  });
  assert.deepEqual(checkContent(c), []);
  assert.deepEqual(c.assignments, ["Initech – Backend Intern: assignment – not cleared (main gap: core requirements missing)."]);
  assert.equal(c.jobs.find((x) => x.company === "Acme")!.reason, "Stronger candidates chosen by company; most selected had a same-field internship");
  assert.equal(c.jobs.find((x) => x.company === "Globex")!.reason, "Power BI and Tableau not used in any project");
  assert.ok(c.notes[0].includes("November Academy review"), c.notes[0]);
  assert.ok(c.tags.some((t) => t.key === "low_score"));
  assert.ok(c.improve.some((i) => i.label === "ATS-friendly resume"));
});

// ── The document ────────────────────────────────────────────────────────────

const RES1 = "https://files.example.com/resume/1795000000000_Asha_Rao_Resume_Data_Analyst_0a1b2c3d-1111-2222-3333-444455556666.pdf";
const RES2 = "https://files.example.com/resume/1795000000001_Asha_Rao_Resume_Full_Stack-1_0a1b2c3d-1111-2222-3333-444455556667.pdf";

function scenario() {
  const requirements = [
    req({ key: "s", company: "Acme", role: "Data Analyst Intern", jobId: "J-S", sheetId: "sh1", techStack: "SQL, Power BI" }),
    req({ key: "n", company: "Globex", role: "SDE 1", jobId: "J-N", sheetId: "sh2", techStack: "Java, DSA" }),
    req({ key: "a", company: "Initech", role: "Data Apprentice", jobId: "J-A", sheetId: "sh3", techStack: "SQL" }),
    req({ key: "x", company: "Hooli", role: "Data Engineer", jobId: "J-X", sheetId: "sh4", assessedSent: 5, techStack: "SQL, Kubernetes, Linux" }),
    req({ key: "y", company: "Umbrella", role: "Graduate Software Engineering Intern", jobId: "J-Y", sheetId: "sh5", assessedSent: 3, techStack: "C++, Linux" }),
    req({ key: "z", company: "Vandelay", role: "Frontend Developer", jobId: "J-Z", sheetId: "sh6", assessedSent: 2, techStack: "JavaScript, React js" }),
  ];
  const at = new Date(Date.UTC(2026, 10, 3));
  const applications: FbApplication[] = [
    { jobId: "j-s", appliedAt: at, resumeUrl: RES1, source: "portal" },
    { jobId: "j-n", appliedAt: at, resumeUrl: RES2, source: "portal" },
    { jobId: "j-a", appliedAt: at, resumeUrl: RES1, source: "portal" },
    { jobId: "j-x", appliedAt: at, resumeUrl: RES1, source: "portal" },
    { jobId: "j-y", appliedAt: at, resumeUrl: RES2, source: "portal" },
    { jobId: "j-z", appliedAt: at, resumeUrl: RES2, source: "portal" },
  ];
  const shares = [
    share({ sheetId: "sh1", tab: "JD-1", company: "Acme", rounds: [R("Screening Round", "Selected"), R("TR Round 1", "Rejected")], own: "rejected" }),
    share({ sheetId: "sh2", tab: "JD-1", company: "Globex", rounds: [R("Screening Round", "Rejected")], own: "rejected" }),
    share({ sheetId: "sh3", tab: "JD-1", company: "Initech", rounds: [], own: "shared" }),
  ];
  const all = sheets({
    sh1: sheet(true, { "JD-1": 4 }),
    sh2: sheet(true, { "JD-1": 2 }),
    sh3: sheet(true, { "JD-1": 6 }),
    sh4: sheet(true, { "JD-1": 5 }),
    sh5: sheet(true, { "JD-1": 3 }),
    sh6: sheet(true, { "JD-1": 2 }),
  });
  const jobs = jobsInPeriod(
    assembleJobs(inputFor({ requirements, applications, shares, sheets: all, interviews: [{ jobId: "J-S", company: "Acme", round: "TR1", day: "2026-11-03", cancelled: false }] })),
    NOV,
  );
  const jr = (o: Partial<JobReview>): JobReview => ({ core: [], mustNotShown: [], listedOnly: [], shownSkills: [], fit: 4, fitNote: "", sameFieldInternship: true, fallback: false, ...o });
  const byCo = (c: string) => jobs.find((j) => j.company === c)!.key;
  const reviews = new Map<string, ResumeReview>([
    [
      RES1,
      {
        url: RES1,
        label: "Data Analyst",
        readable: true,
        problem: null,
        noLinks: true,
        genericBullets: true,
        spellingIssues: false,
        jobs: new Map([
          [byCo("Acme"), jr({ core: [{ skill: "SQL", shown: "in_projects" }, { skill: "Power BI", shown: "in_projects" }], shownSkills: ["SQL", "Power BI"] })],
          [byCo("Initech"), jr({ core: [{ skill: "SQL", shown: "in_projects" }], shownSkills: ["SQL"] })],
          [byCo("Hooli"), jr({ core: [{ skill: "SQL", shown: "in_projects" }], mustNotShown: ["Kubernetes"], listedOnly: ["Linux"], shownSkills: ["SQL"] })],
        ]),
      },
    ],
    [
      RES2,
      {
        url: RES2,
        label: "Full Stack",
        readable: true,
        problem: null,
        noLinks: false,
        genericBullets: false,
        spellingIssues: true,
        jobs: new Map([
          [byCo("Globex"), jr({ core: [{ skill: "Java", shown: "in_projects" }], shownSkills: ["Java"] })],
          [byCo("Umbrella"), jr({ core: [{ skill: "C++", shown: "listed_only" }, { skill: "Linux", shown: "listed_only" }], sameFieldInternship: false })],
          [byCo("Vandelay"), jr({ core: [{ skill: "React", shown: "in_projects" }], shownSkills: ["React"], fit: 2, fitNote: "data profile, not frontend" })],
        ]),
      },
    ],
  ]);
  const facts = new Map<string, JobFacts>();
  for (const j of jobs) {
    const rv = j.resumeUrl ? reviews.get(j.resumeUrl) : undefined;
    if (rv) facts.set(j.key, factsFromLive(rv, rv.jobs.get(j.key)));
  }
  return { jobs, facts };
}

test("the document: numbers agree, reasons, tags, results, resumes, what to improve", async () => {
  const { jobs, facts } = scenario();
  const c = buildContent(jobs, {
    candidate: { uid: "uid-asha-0001", name: "Asha Rao" },
    period: NOV,
    today: "2026-11-28",
    facts,
    resumeLabels: resumeLabels([RES1, RES2], "Asha Rao"),
    model: "gemini/test",
    applicationsReadAt: new Date(),
    sourcesMissing: [],
  });
  assert.deepEqual(checkContent(c), []);
  assert.deepEqual(c.counts, { jobs: 6, applied: 6, sharedOnly: 0, selected: 1, awaited: 1, notMovedForward: 4, notKnown: 0 });
  assert.deepEqual(c.numbers.values, ["6", "1", "1", "4"]);
  assert.equal(c.period.line, "All November 2026 applications · as of 28 Nov 2026");
  assert.equal(c.title, "Resume Rejection Analysis – Asha Rao");
  assert.deepEqual(c.reasons.map((r) => [r.key, r.count, r.pct]), [["fits", 3, 75], ["core_missing", 1, 25]]);
  const text = c.summary.map((s) => s.map((r) => r.text).join("")).join("\n");
  assert.ok(text.includes("You applied to 6 jobs."), text);
  assert.ok(text.includes("1 company selected your resume: Acme (Data Analyst Intern)."), text);
  assert.ok(text.includes("1 result is awaited: Initech (Data Apprentice)."), text);
  assert.ok(text.includes("4 applications did not move forward, including Globex."), text);
  assert.ok(text.includes("Main reason: you fit the job, but stronger candidates were chosen by the company (3 of 4, 75%)."), text);
  const row = (co: string) => c.jobs.find((j) => j.company === co)!;
  assert.equal(row("Acme").result, "Selected by company; TR1 (3\u00a0Nov) not cleared");
  assert.equal(row("Acme").reason, "SQL and Power BI in your projects matched the role");
  assert.equal(row("Globex").result, "Not taken forward by company");
  assert.equal(row("Globex").reason, "Stronger candidates chosen by company");
  assert.equal(row("Hooli").result, "Not selected");
  assert.equal(row("Hooli").reason, "Stronger candidates chosen by company; Kubernetes not shown");
  assert.equal(row("Umbrella").reason, "C++ and Linux not used in any project");
  assert.equal(row("Vandelay").reason, "Stronger candidates chosen by company; data profile, not frontend");
  assert.equal(row("Initech").reason, "–");
  assert.deepEqual(c.jobs.map((j) => j.company), ["Acme", "Globex", "Initech", "Hooli", "Umbrella", "Vandelay"]);
  const tags = Object.fromEntries(c.tags.map((t) => [t.key, t.count]));
  assert.equal(c.tagBase, 4);
  assert.deepEqual(tags, { must_missing: 1, listed_only: 2, low_fit: 1, no_links: 1, no_internship: 1, spelling: 3, generic: 1 });
  assert.deepEqual(c.interviews, ["Acme – Data Analyst Intern: TR1 interview on 3 Nov – not cleared."]);
  assert.deepEqual(c.resumes.map((r) => [r.label, r.jobs]), [["Data Analyst", 3], ["Full Stack", 3]]);
  assert.deepEqual(c.improve.map((i) => i.label), ["Stronger projects", "Tailor to each job", "Clear project points", "Links", "ATS-friendly resume", "Right roles"]);
  assert.ok(c.improve[1].text.includes("(for example"), c.improve[1].text);
  assert.ok(c.improve.every((i) => !/Asha/.test(i.text)));
  // The .docx: one Title, numbered headings, the links, black text only.
  const docx = await renderFeedbackDocx(c);
  const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string");
  for (const h of ["1. Summary", "2. Your Numbers", "3. Why Applications Did Not Move Forward", "4. Interviews and Assignments", "5. Resumes Used (2)", "6. Result for Each Job", "7. What to Improve"]) {
    assert.ok(xml.includes(h), h);
  }
  assert.ok(xml.includes("Take this feedback as a chance to improve"));
  assert.ok(!/w:color w:val="(?!000000|FFFFFF|auto)[0-9A-Fa-f]{6}"/.test(xml), "black only");
  const rels = await (await JSZip.loadAsync(docx)).file("word/_rels/document.xml.rels")!.async("string");
  assert.ok(rels.includes("files.example.com/resume/1795000000000"));
  assert.ok(feedbackText(c).includes("Result for Each Job"));
});

test("shared without an application, results not known, nothing turned down", () => {
  const requirements = [
    req({ key: "p", company: "Acme", role: "Business Analyst", jobId: "J-P", sheetId: "sp" }),
    req({ key: "q", company: "Globex", role: "QA", jobId: "J-Q", sheetId: null, finalStatus: "Closed" }),
  ];
  const shares = [share({ sheetId: "sp", tab: "JD-1", rounds: [R("HR Round", "Rejected")], own: "rejected" })];
  const applications: FbApplication[] = [{ jobId: "j-q", appliedAt: new Date(Date.UTC(2026, 10, 2)), resumeUrl: null, source: "form" }];
  const jobs = jobsInPeriod(assembleJobs(inputFor({ requirements, shares, applications, sheets: sheets({ sp: sheet(true, { "JD-1": 1 }) }) })), NOV);
  const c = buildContent(jobs, { candidate: { uid: "u", name: "Ravi" }, period: NOV, today: "2026-11-28", facts: new Map(), model: null, applicationsReadAt: null, sourcesMissing: [] });
  assert.deepEqual(checkContent(c), []);
  assert.equal(c.numbers.headers[0], "Jobs");
  assert.deepEqual(c.numbers.headers.slice(-1), ["Result not known"]);
  assert.equal(c.counts.sharedOnly, 1);
  assert.equal(c.reasons.length, 0);
  assert.ok(c.summary[0].map((r) => r.text).join("").startsWith("Your profile was considered for 2 jobs (1 you applied to, 1 shared by the placement team)."));
  assert.deepEqual(c.interviews, ["Acme – Business Analyst: HR round – not cleared."]);
  assert.ok(c.notes.some((n) => n.includes("not known")));
  assert.ok(c.notes.some((n) => n.includes("internal sheets")));
  assert.ok(c.improve.length >= 2);
  assert.equal(resultText(jobs.find((j) => j.company === "Acme")!), "Selected by company; HR round not cleared");
});

test("reasons: closed, no show, no resume, unreadable, not downloadable", () => {
  const base: Omit<FbJob, "outcome" | "resumeUrl"> = {
    key: "k",
    company: "Acme",
    role: "SDE",
    jobId: "",
    requirement: null,
    period: null,
    appliedAt: null,
    firstSeen: null,
    applied: true,
    shared: true,
    flags: [],
    items: [],
    techStack: "",
    jdUrl: null,
    idDone: null,
    review: null,
    assignment: null,
  };
  const rv = (o: Partial<ResumeReview>): ResumeReview => ({ url: RES1, label: "x", readable: true, problem: null, noLinks: null, genericBullets: null, spellingIssues: null, jobs: new Map(), ...o });
  assert.equal(reasonOf({ ...base, outcome: "closed", resumeUrl: RES1 }, undefined), "closed");
  assert.equal(reasonOf({ ...base, outcome: "no_show", resumeUrl: RES1 }, undefined), "no_show");
  assert.equal(reasonOf({ ...base, outcome: "not_forwarded", resumeUrl: null }, undefined), "no_resume");
  const unreadable = factsFromLive(rv({ readable: false, problem: "a photograph, not a resume" }), undefined);
  assert.equal(reasonOf({ ...base, outcome: "not_forwarded", resumeUrl: RES1 }, unreadable), "unreadable");
  assert.equal(reasonText({ ...base, outcome: "not_forwarded", resumeUrl: RES1 }, "unreadable", unreadable), "Resume couldn’t be read (a photograph, not a resume)");
  // A file host that didn't answer isn't the candidate's doing: "not available", and a note for the reviewer.
  const gone = factsFromLive(rv({ readable: false, unavailable: true, problem: "unavailable" }), undefined);
  assert.equal(reasonOf({ ...base, outcome: "not_forwarded", resumeUrl: RES1 }, gone), "no_resume");
  assert.deepEqual(gone.tags, []);
  const c = buildContent([{ ...base, outcome: "not_forwarded", resumeUrl: RES1 }], { candidate: { uid: "u", name: "Ravi" }, period: NOV, today: "2026-11-28", facts: new Map([["k", gone]]), model: null, applicationsReadAt: new Date(), sourcesMissing: [] });
  assert.ok(c.notes.some((n) => n.includes("couldn't be downloaded")));
  assert.ok(!c.notes.some((n) => n.startsWith('Resume "')), "not reported as unreadable");
});

test("resumes used: one per name (the newest upload linked), others numbered by their place; right roles", () => {
  const DRIVE_A = "https://drive.google.com/file/d/aaa/view";
  const DRIVE_B = "https://drive.google.com/file/d/bbb/view";
  const RES1_AGAIN = RES1.replace("1795000000000", "1795000000009");
  const mk = (key: string, company: string, role: string, resumeUrl: string, day: number): FbJob => ({
    key,
    company,
    role,
    jobId: key,
    requirement: null,
    period: null,
    appliedAt: new Date(Date.UTC(2026, 10, day)),
    firstSeen: null,
    applied: true,
    shared: false,
    outcome: "not_shortlisted",
    flags: [],
    items: [],
    resumeUrl,
    techStack: "",
    jdUrl: null,
    idDone: null,
    review: null,
    assignment: null,
  });
  const jobs = [
    mk("a", "Acme", "Data Analyst", DRIVE_A, 2),
    mk("b", "Globex", "Data Analyst", RES1, 3),
    mk("c", "Initech", "QA Engineer", RES1_AGAIN, 9),
    mk("d", "Hooli", "Full Stack Developer", DRIVE_B, 4),
  ];
  const fits: JobFacts = { source: "live", readable: true, problem: null, reason: null, core: [], mustNotShown: [], shownSkills: [], fit: 4, fitNote: "", tags: [], noRelevantProject: false, fallback: false };
  const c = buildContent(jobs, {
    candidate: { uid: "u", name: "Asha Rao" },
    period: NOV,
    today: "2026-11-28",
    facts: new Map(jobs.map((j) => [j.key, fits])),
    resumeLabels: resumeLabels([DRIVE_A, RES1, RES1_AGAIN, DRIVE_B], "Asha Rao"),
    model: null,
    applicationsReadAt: new Date(),
    sourcesMissing: [],
  });
  assert.deepEqual(checkContent(c), []);
  assert.deepEqual(c.resumes.map((r) => [r.label, r.jobs]), [["Resume 1", 1], ["Data Analyst", 2], ["Resume 3", 1]]);
  assert.equal(c.resumes[1].url, RES1_AGAIN, "the newest upload");
  assert.deepEqual(c.jobs.map((j) => j.resumeLabel), ["Resume 1", "Data Analyst", "Resume 3", "Data Analyst"]);
  const roles = c.improve.find((i) => i.label === "Right roles")!.text;
  assert.ok(roles.startsWith("Apply for roles in data analytics, full stack development, or QA and testing"), roles);
});

test("periods, percentages, resume names, presets, the WhatsApp message", () => {
  assert.deepEqual(periodLabel("2026-11-01", "2026-11-30"), { label: "November 2026", wholeMonths: true });
  assert.equal(periodLabel("2026-10-01", "2026-11-30", true).label, "Oct–Nov 2026");
  assert.equal(periodLabel("2026-12-01", "2027-01-31").label, "December 2026 – January 2027");
  assert.equal(periodLabel("2026-11-03", "2026-11-20").label, "3 Nov – 20 Nov 2026");
  assert.deepEqual(percentages([8, 3]), [73, 27]);
  assert.deepEqual(percentages([1, 1, 1]), [34, 33, 33]);
  assert.equal(percentages([2, 1, 1, 1, 1, 1]).reduce((a, b) => a + b, 0), 100);
  assert.equal(resumeLabel(RES1, "Asha Rao", 1), "Data Analyst");
  assert.equal(resumeLabel(RES2, "Asha Rao", 2), "Full Stack");
  assert.equal(resumeLabel("https://drive.google.com/file/d/abc/view", "Asha", 3), "Resume 3");
  assert.equal(resumeLabel("https://files.example.com/r/1795000000002_ML_trainee (1) (1)_0a1b2c3d-1111-2222-3333-444455556668.pdf", "Asha Rao", 1), "ML trainee");
  assert.equal(resumeLabel("https://files.example.com/r/Resume_2.pdf", "Asha Rao", 4), "Resume 4");
  const twice = resumeLabels([RES1, RES1.replace("1795000000000", "1795000000009"), "https://drive.google.com/file/d/abc/view"], "Asha Rao");
  assert.deepEqual([...twice.values()], ["Data Analyst", "Data Analyst", "Resume 3"], "the same file name is the same resume");
  const p = presets("2026-11-28");
  assert.deepEqual(p.map((x) => [x.key, x.from, x.to]), [
    ["this_month", "2026-11-01", "2026-11-30"],
    ["last_month", "2026-10-01", "2026-10-31"],
    ["last_2_months", "2026-10-01", "2026-11-30"],
    ["last_3_months", "2026-09-01", "2026-11-30"],
  ]);
  assert.equal(presets("2027-01-05")[1].label, "Dec 2026");
  assert.deepEqual(validPeriod("2026-11-01", "2026-11-30", "2026-11-28"), { from: "2026-11-01", to: "2026-11-30" });
  for (const bad of [["2026-11-30", "2026-11-01"], ["2025-01-01", "2026-06-30"], ["2026-11-01", "2027-02-01"], ["x", "2026-11-01"], ["2026-02-30", "2026-03-01"]]) {
    assert.throws(() => validPeriod(bad[0], bad[1], "2026-11-28"));
  }
  const msg = whatsappText("Asha Rao", "November 2026", "Rakesh");
  assert.ok(msg.startsWith("Hi Asha,") && msg.includes("November 2026") && msg.endsWith("Rakesh\nNxtWave Placements"));
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      console.error(`✗ ${name}\n  ${(e as Error).stack ?? (e as Error).message}`);
      process.exitCode = 1;
    }
  }
  console.log(`${passed} of ${tests.length} feedback document tests passed`);
})();
