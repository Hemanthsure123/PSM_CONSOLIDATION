/**
 * Self-test for RSA documents and the prep document format v2 — pure parts only (no network, no
 * database, no model). Made-up data only.
 *   npx tsx scripts/rsa-selftest.ts
 */
import "./server-only-shim";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { candidateOnly, fitRsa, normaliseRsa, remarkBullets, rsaFileName, rsaPages, sheetDate, type RsaDoc } from "@/lib/rsa/model";
import { renderRsaDocx, rsaText } from "@/lib/rsa/render";
import { mapRsaColumns, parseRsaSheet, rsaRow } from "@/lib/rsa/sheet";
import { roundIn } from "@/lib/rsa/list";
import { findPrepColumns, productColumnByValues } from "@/lib/mobile/preps/parse";
import { Evidence, fitToBudget, normalizePrepDoc, pagesOf, PAGE_CEILING, richness, type PrepDoc } from "@/lib/prepdocs/model";
import { renderDocx } from "@/lib/prepdocs/render";
import { researchPlan } from "@/lib/prepdocs/generate";

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const NAME = "Asha Rao";

// ── "Candidate" only ─────────────────────────────────────────────────────────

test("candidateOnly replaces the name, pronouns and 'the student'", () => {
  const out = candidateOnly("Asha Rao said that she solved it. Her project was strong and the panel asked him about his API. The student felt Rao's answer was weak.", [NAME]);
  assert.equal(/\b(asha|rao|she|her|him|his|student)\b/i.test(out), false, out);
  assert.ok(out.startsWith("Candidate said that candidate solved it."), out);
  assert.ok(out.includes("Candidate's project"), out);
  assert.ok(out.includes("candidate's API"), out);
});

test("candidateOnly leaves words that only contain a pronoun alone", () => {
  const out = candidateOnly("The theme of the other question was hereditary data.", [NAME]);
  assert.equal(out, "The theme of the other question was hereditary data.");
});

// ── Normalising the model's RSA ──────────────────────────────────────────────

const transcript = `Speaker 1: How did the round go?
Speaker 2: They asked me to explain my Django project, the database schema and how I handled authentication.
Speaker 2: Then a SQL question on joins between orders and customers, I partly answered.
Speaker 2: Then longest substring without repeating characters, I solved it in Python.`;

const modelRsa = {
  role: "Backend Intern",
  process: "TR1 → TR2 → HR",
  result: "Awaited",
  summary: ["Asha said the round was project-focused.", "She partly answered the SQL joins question.", "**Result** is awaited 🚀"],
  areas: [
    { area: "Project Deep Dive", asked: "Explain the Django project, the database schema and authentication", rating: "Good", note: "Explained clearly." },
    { area: "SQL", asked: "Joins between orders and customers", rating: "Partly answered", note: "Missed the left join case." },
    { area: "DSA", asked: "Longest substring without repeating characters", rating: "Good", note: "Solved in Python." },
    { area: "System Design", asked: "Design a URL shortener with sharding and consistent hashing", rating: "Weak", note: "Invented." },
    { area: "Odd", asked: "x", rating: "Superb", note: "" },
  ],
  observations: ["The company tested project depth and SQL."],
  actionPlan: ["Candidate should practise SQL joins.", "Her next step is revising window functions."],
  remarks: { feedbackSource: "Candidate's own account", result: "", nextSteps: "Waiting for the TR2 update", possibleReason: "Not confirmed: SQL depth" },
  unconfirmed: ["Exact duration of the round"],
};

test("normaliseRsa: grounded areas only, ratings checked, 'candidate' only, no marks", () => {
  const n = normaliseRsa(modelRsa, { names: [NAME], evidence: [transcript, "", "Focus on SQL"] });
  assert.ok(n);
  const areas = n.content.areas.map((a) => a.area);
  assert.deepEqual(areas, ["Project Deep Dive", "SQL", "DSA", "Odd"]);
  assert.ok(n.dropped.some((d) => d.startsWith("System Design")), "an area not in the call is dropped");
  assert.equal(n.content.areas.find((a) => a.area === "Odd")!.rating, "Not confirmed");
  const body = JSON.stringify(n.content);
  assert.equal(/\b(asha|she|her)\b/i.test(body), false, body);
  assert.equal(/\*\*|🚀/u.test(body), false);
});

test("normaliseRsa rejects junk", () => {
  assert.equal(normaliseRsa(null, { names: [], evidence: [] }), null);
  assert.equal(normaliseRsa({ summary: [], areas: [] }, { names: [], evidence: [] }), null);
});

test("remarkBullets splits long remarks into short bullets", () => {
  const b = remarkBullets(`Candidate missed the joins question.\n${"Long sentence about the project and the panel. ".repeat(8)}`);
  assert.ok(b.length >= 2 && b.length <= 6);
  assert.ok(b.every((x) => x.length <= 220));
});

test("file name: RSA_<Candidate_Name>_<Company>_<Round>_<Date>", () => {
  assert.equal(rsaFileName("Asha  Rao", "Acme.ai", "TR1", new Date("2026-11-15T06:00:00Z")), "RSA_Asha_Rao_Acme_ai_TR1_15-Nov-2026");
  assert.equal(sheetDate(new Date("2026-11-14T20:00:00Z")), "15-Nov-2026", "IST date");
});

const baseDoc = (): RsaDoc => {
  const n = normaliseRsa(modelRsa, { names: [NAME], evidence: [transcript] })!;
  return {
    fileName: "RSA_Asha_Rao_Acme_ai_TR1_15-Nov-2026",
    title: "INTERVIEW SUMMARY ANALYSIS (RSA)",
    subtitle: "Acme.ai – TR1 Interview Feedback",
    header: {
      candidateName: NAME,
      companyRole: "Acme.ai / Backend Intern",
      process: "TR1 → TR2 → HR",
      roundAttended: "TR1 – 14 Nov 2026",
      result: "Awaited",
      resumeUrl: "https://drive.google.com/file/d/RESUME/view",
      callAndPreparedBy: "15 Nov 2026 / Team Member",
    },
    content: n.content,
    teamRemarks: ["Candidate missed the left join case."],
  };
};

test("fitRsa keeps any document within 3 pages", () => {
  const d = baseDoc();
  const big: RsaDoc = {
    ...d,
    content: {
      ...d.content,
      summary: Array(6).fill("x".repeat(220)),
      observations: Array(6).fill("y".repeat(220)),
      actionPlan: Array(7).fill("z".repeat(220)),
      areas: Array(10).fill({ area: "Area", asked: "q".repeat(240), rating: "Good", note: "n".repeat(240) }),
    },
  };
  assert.ok(rsaPages(big) > 3);
  assert.ok(rsaPages(fitRsa(big)) <= 3, String(rsaPages(fitRsa(big))));
  assert.ok(rsaPages(d) <= 2);
});

test("RSA .docx: a real Word file with the structure, bullets only, the resume link", async () => {
  const d = baseDoc();
  const buf = await renderRsaDocx(d, "Acme.ai");
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("word/document.xml")!.async("string");
  for (const t of ["INTERVIEW SUMMARY ANALYSIS (RSA)", "1. Summary", "2. Area-wise Analysis", "3. Key Observations", "4. Action Plan", "5. Remarks", "Gap / Performance", "Resume link"]) {
    assert.ok(xml.includes(t), `missing ${t}`);
  }
  const rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
  assert.ok(rels.includes("https://drive.google.com/file/d/RESUME/view"));
  assert.ok(rsaText(d).includes("Team remark: Candidate missed the left join case."));
});

// ── The RSA sheet ────────────────────────────────────────────────────────────

const HEADER = ["Date of Entry", "UID", "Company Name", "Candidate Name", "Mobile Numbers", "Resume", "Product", "Type of RSA", "Drill Down", "RSA Doc", "RSA Sent Date", "Status"];

test("sheet columns are found by header name, not position", () => {
  const shuffled = ["Status", "RSA Doc", "Candidate Name", "Date of Entry", "Mobile Numbers", "Drill Down", "UID", "Company Name", "Product", "Resume (link)"];
  const cols = mapRsaColumns(shuffled);
  assert.equal(cols.rsaDoc, 1);
  assert.equal(cols.resume, 9);
  assert.equal(cols.date, 3);
  const { row, missing } = rsaRow(shuffled, {
    date: "15-Nov-2026", uid: "U1", company: "Acme.ai - Backend Intern", candidate: NAME, mobile: "9000000001", resume: "https://r", product: "Academy", drilldown: "https://d", rsaDoc: "https://doc",
  });
  assert.deepEqual(missing, []);
  assert.equal(row[1], "https://doc");
  assert.equal(row[0], "", "a column we don't fill stays empty");
  assert.equal(row[9], "https://r");
});

test("parseRsaSheet reads rows with a document link and every phone in the mobile cell", () => {
  const values = [
    HEADER,
    ["14-Nov-2026", "", "Acme.ai - Backend Intern", NAME, "9000000001 / +91 90000 00002", "", "Academy", "", "", "https://docs.google.com/document/d/DOC1/edit", "", ""],
    ["14-Nov-2026", "", "Other", "Ravi Kumar", "9000000003", "", "", "", "", "", "", ""],
  ];
  const p = parseRsaSheet(values);
  assert.equal(p.entries.length, 1);
  assert.deepEqual(p.entries[0].phones, ["9000000001", "9000000002"]);
  assert.equal(p.entries[0].row, 2);
});

test("roundIn finds the round in an RSA document name", () => {
  assert.equal(roundIn("RSA_Asha_Rao_Acme_ai_TR1_15-Nov-2026").toUpperCase(), "TR1");
  assert.equal(roundIn("INTERVIEW SUMMARY ANALYSIS (RSA) - Acme TR3").toUpperCase(), "TR3");
  assert.equal(roundIn("Notes"), "");
});

// ── Drill-down Product column whose header was overwritten ───────────────────

test("product column found by its values when the header no longer says Product", () => {
  const header = ["w", "Date of entry", "PC", "Interview Date", "Interview Timings", "Job ID", "Company Name", "Candidate Name", "Candidate Mobile No", "Candidate Resume", "Round Category", "Interview Process", "Candidate's Status", "Prep Given", "Prep given by", "Prep Date", "Prep Time", "Prep Document", "Remarks", "HubSpot Link", "", "Company Interview Mode", "Meeting link", "Interview Recording Link", "Transcript Link", "Drilldown link"];
  const cols = findPrepColumns(header);
  assert.equal(cols.product, 0);
  const products = ["Edge", "Academy", "Edge 2.0", "External", "NIAT", "Academy Assessed", ""];
  const rows = [header, ...Array.from({ length: 30 }, (_, i) => [products[i % products.length], "14-Nov-2026", "x", "", "", "", "Acme", "Asha Rao", "9000000001"])];
  assert.equal(productColumnByValues(rows, cols), 1);
  const named = findPrepColumns(["Product", ...header.slice(1)]);
  assert.equal(productColumnByValues(rows, named), 1, "a named Product column is kept");
  const noise = [header, ...Array.from({ length: 30 }, () => ["hello", "14-Nov-2026", "x", "", "", "", "Acme", "Asha Rao", "9000000001"])];
  assert.equal(productColumnByValues(noise, cols), 0, "no column of product names → none");
});

// ── Prep document format v2 ──────────────────────────────────────────────────

const drilldown = "TR1 questions: Explain your React project. What is the difference between useMemo and useCallback? Write a function to debounce an input. The panel said one candidate jumped to the solution before defining the problem.";

const prepRaw = {
  sourceLine: "Built from a previously appeared candidate's round",
  overview: [{ label: "What this round is", value: "A technical round on React and JavaScript." }],
  startHere: ["This guide is built from one earlier candidate's round.", "Define the problem before you code."],
  aboutCompany: ["Founded in 2010 with 5,000 employees."],
  sections: [
    {
      title: "React",
      tag: "HIGHEST PRIORITY",
      intro: "Asked in the only reported round.",
      topics: [{ name: "Memoisation", revise: "When useMemo and useCallback help." }],
      asked: ["What is the difference between useMemo and useCallback?", "How does React Fiber schedule work across priorities?"],
      practise: [],
      grid: null,
      box: { label: "PRIORITY AREA", body: ["Define the problem first."] },
    },
    { title: "JavaScript", tag: "", intro: "Live coding.", topics: [{ name: "Debounce", revise: "Write it from scratch." }], asked: ["Write a function to debounce an input."], practise: ["Explain closures."], grid: null, box: null },
  ],
  checklist: { beforeHeading: "The night before", before: ["Re-read your React project."], duringHeading: "In the round", during: ["Say the problem back first."] },
  inShort: "Define the problem first, then code.",
  sources: [{ title: "Made up", url: "https://made-up.example/interview" }],
  changes: [],
  unverified: [],
  noInterviewReports: false,
};

test("evidence tiers: an invented 'real' question moves to practise; unknown links and company facts go", () => {
  const ev = new Evidence([drilldown], []);
  const doc = normalizePrepDoc(prepRaw, { evidence: ev, companyDetailsAllowed: false })!;
  const react = doc.sections[0];
  assert.deepEqual(react.asked, ["What is the difference between useMemo and useCallback?"]);
  assert.ok(react.practise.includes("How does React Fiber schedule work across priorities?"));
  assert.equal(doc.sections[1].asked.length, 1);
  assert.equal(doc.sources.length, 0, "a link nobody supplied or found is dropped");
  assert.equal(doc.aboutCompany.length, 0, "no company details without a supplied or named source");
});

test("page budget: richness, and fitToBudget never cuts START HERE, real questions, checklist or IN SHORT", () => {
  assert.equal(richness(2, 3_000), "thin");
  assert.equal(richness(10, 3_000), "okay");
  assert.equal(richness(30, 3_000), "rich");
  const subjects = ["arrays", "graphs", "queues", "stacks", "heaps", "tries", "joins", "indexes", "threads", "caching", "sockets", "routing", "hooks"];
  const ev = new Evidence([drilldown, ...subjects.map((x) => `Explain how ${x} work in your project`)], []);
  const base = normalizePrepDoc(prepRaw, { evidence: ev, companyDetailsAllowed: true })!;
  const big: PrepDoc = {
    ...base,
    sections: subjects.map((x, i) => ({
      ...base.sections[0],
      title: `Section ${i + 1}`,
      tag: "",
      asked: [`Explain how ${x} work in your project`],
      topics: Array.from({ length: 10 }, (_, k) => ({ name: `Topic ${k} on ${x}`, revise: `${x} detail ${k} `.repeat(20) })),
      practise: Array.from({ length: 20 }, (_, k) => `Practise question ${k} about ${x} and ${subjects[(i + k) % subjects.length]} number ${k * 7}`),
    })),
  };
  assert.ok(pagesOf(big) > PAGE_CEILING);
  const { doc, cuts } = fitToBudget(big, 7);
  assert.ok(pagesOf(doc) <= PAGE_CEILING, String(pagesOf(doc)));
  assert.ok(cuts.length > 0);
  assert.deepEqual(doc.startHere, big.startHere);
  assert.equal(doc.sections.reduce((n, s) => n + s.asked.length, 0), subjects.length, "every real question kept");
  assert.deepEqual(doc.checklist, big.checklist);
  assert.equal(doc.inShort, big.inShort);
});

test("prep .docx follows the visual spec: fonts, page, accent, START HERE / IN SHORT boxes, numbered sections", async () => {
  const ev = new Evidence([drilldown], []);
  const doc = normalizePrepDoc(prepRaw, { evidence: ev, companyDetailsAllowed: false })!;
  doc.title = "ACME";
  doc.subtitle = "Frontend Intern · TR1 · Preparation Guide";
  const zip = await JSZip.loadAsync(await renderDocx(doc, "Acme"));
  const xml = await zip.file("word/document.xml")!.async("string");
  for (const t of ["ACME", "START HERE — read this first", "1. React", "HIGHEST PRIORITY", "Topics to prepare", "Questions asked in real interviews", "Questions to practise", "3. Checklist", "IN SHORT", "Cambria", "Calibri", "EEF3FA", "w:w=\"12240\"", "w:h=\"15840\""]) {
    assert.ok(xml.includes(t), `missing ${t}`);
  }
  assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(xml), false);
});

test("research plan names the company and its own searches only", () => {
  const plan = researchPlan("Acme", "Frontend Intern", "TR1", ["https://acme.example", "not a link"]);
  assert.equal(plan.queries.length, 3);
  assert.ok(plan.queries.every((q) => q.startsWith("Acme")));
  assert.deepEqual(plan.suppliedLinks, ["https://acme.example"]);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      console.error(`✗ ${name}\n  ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
  console.log(`${passed} of ${tests.length} RSA / prep format tests passed`);
})();
