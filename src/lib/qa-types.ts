/**
 * QA Resume Screening — shared types and the QA requirement itself.
 * Plain data only: everything here travels over JSON (route ↔ browser) and
 * into IndexedDB. The regexes are used on both sides (server verification,
 * nothing on the client depends on them).
 */

export const QA_SECTIONS = ["skills", "projects", "experience"] as const;
export type QaSection = (typeof QA_SECTIONS)[number];
export const SECTION_LABEL: Record<QaSection, string> = { skills: "Skills", projects: "Projects", experience: "Experience" };

/** The exact resume words proving an item in each section — "" = the section doesn't show it. */
export type SectionQuotes = Record<QaSection, string>;

export interface QaItemDef {
  key: string;
  /** Name as the requirement words it (CSV headers use this). */
  label: string;
  /** What counts as evidence — goes into the prompt as written. */
  rule: string;
  /** Every pattern must match the quote — a quote about something else is dropped. */
  must: RegExp[];
}

const TEST = /test/i;

/** Mandatory — every one in Skills, Projects AND Experience is the only way to 100%. */
export const MANDATORY = [
  {
    key: "qa",
    label: "QA",
    rule: 'Quality Assurance is named — "QA", "Quality Assurance", "SQA", "QA Engineer / Tester / Intern", "Quality Analyst", "SDET" — or the work is explicitly QA of a product.',
    must: [/\bs?q\.?\s?a\b|quality\s*(assurance|analyst|analysis|engineer|control)|\bsdet\b|\bqc\b/i],
  },
  {
    key: "software_testing",
    label: "Software Testing",
    rule: 'software testing is named or done — "Software Testing", "Testing", "Tester", "Test Engineer", any named kind of software testing, or tests / test cases written and run on software.',
    must: [/\btest|pytest|testng|junit/i],
  },
  {
    key: "manual_testing",
    label: "Manual Testing",
    rule: '"Manual Testing" is named, or test cases / test scenarios are written and executed by hand, exploratory or ad-hoc testing, UAT.',
    must: [/manual|test\s*cases?|test\s*scenarios?|exploratory|ad[\s-]?hoc|\buat\b|user\s*acceptance|test\s*execution/i],
  },
  {
    key: "automated_testing",
    label: "Automated Testing",
    rule: '"Automation Testing" / "Test Automation" / "Automated Testing" is named, or automated test scripts are written with a test framework or tool (Selenium, Cypress, Playwright, Appium, TestNG, JUnit, PyTest, Jest, Mocha, Cucumber, Rest Assured…).',
    must: [
      /automat|selenium|cypress|playwright|webdriver|testng|junit|pytest|\bjest\b|mocha|appium|cucumber|robot\s*framework|katalon|rest[\s-]*assured|test\s*scripts?/i,
    ],
  },
  {
    key: "selenium",
    label: "Selenium",
    rule: "Selenium is named (Selenium, Selenium WebDriver, Selenium IDE, Selenium Grid).",
    must: [/selenium/i],
  },
] as const satisfies readonly QaItemDef[];

export type MandatoryKey = (typeof MANDATORY)[number]["key"];

function gth(key: string, label: string, rule: string, must: RegExp[]): QaItemDef {
  return { key, label, rule, must };
}

/** Good-to-have — each one found adds to the score (more when shown in a project or job). */
export const GOOD_TO_HAVE: readonly QaItemDef[] = [
  gth("functional_testing", "Functional Testing", "functional testing named or done (not React \"functional components\").", [/functional/i, TEST]),
  gth("regression_testing", "Regression Testing", "regression testing / regression suites (not regression models).", [
    /regression/i,
    /test|suite|cycle|pack/i,
  ]),
  gth("integration_testing", "Integration Testing", "integration testing (not \"integrated X\" / \"API integration\").", [/integration/i, TEST]),
  gth("system_testing", "System Testing", "system testing named or done.", [/system\s*test/i]),
  gth("e2e_testing", "End-to-End (E2E) Testing", "end-to-end / E2E testing (not an \"end-to-end application\").", [/end[\s-]*to[\s-]*end|\be2e\b/i, TEST]),
  gth("test_case_design", "Test Case Design", "test cases / test scenarios designed or written; boundary value analysis, equivalence partitioning.", [
    /test\s*cases?|test\s*scenarios?|boundary\s*value|equivalence|decision\s*table|design\w*\s.*\btest|test\s*design/i,
  ]),
  gth("test_planning", "Test Planning", "a test plan / test strategy written or named.", [/test\s*plan|test\s*strateg/i]),
  gth("bug_tracking", "Bug Tracking", "bugs / defects / issues reported, logged or tracked (Jira, Bugzilla…) — not fixing your own bugs.", [
    /bug|defect|issue/i,
    /\b(track\w*|report\w*|logg\w*|logs?|rais\w*|jira|bugzilla|mantis)\b/i,
  ]),
  gth("defect_management", "Defect Management", "defects managed through their life cycle — defect / bug life cycle, triage, defect reports.", [
    /defect|bug\s*life|bug\s*reports?|triag/i,
  ]),
  gth("debugging", "Debugging", "debugging, troubleshooting or fixing bugs.", [/debug|troubleshoot|\bfix\w*\b.{0,30}\bbugs?\b|\bbug\s*fix/i]),
  gth("api_testing", "API Testing", "APIs tested (Postman, Rest Assured, API test cases / validation) — building APIs is not testing them.", [
    /\bapis?\b|endpoint|postman|rest[\s-]*assured/i,
    /test|postman|assured|validat|verif/i,
  ]),
  gth("rest_api_testing", "REST API Testing", "REST APIs tested.", [/\brest|postman|assured/i, /test|postman|assured|validat|verif/i]),
  gth("postman", "Postman", "Postman named.", [/postman/i]),
  gth("sql_db_testing", "SQL/Database Testing", "SQL, or database testing / data validation with queries.", [/sql|database|\bdb\b|mysql|postgres|mongo|oracle|sqlite/i]),
  gth("performance_testing", "Performance Testing", "performance / load / stress testing (JMeter, k6, Gatling, LoadRunner, Lighthouse audits) — not \"improved performance\".", [
    /performance\s*test|load\s*test|stress\s*test|jmeter|gatling|locust|\bk6\b|load\s*runner|lighthouse/i,
  ]),
  gth("smoke_testing", "Smoke Testing", "smoke testing named or done.", [/smoke/i, /test|suite/i]),
  gth("sanity_testing", "Sanity Testing", "sanity testing named or done.", [/sanity/i, /test|suite|check/i]),
  gth("cross_browser_testing", "Cross-Browser Testing", "testing across browsers (BrowserStack, LambdaTest, Sauce Labs…).", [
    /cross[\s-]*browser|browserstack|sauce\s*labs|lambdatest|multiple\s*browsers|browser\s*compatib/i,
  ]),
  gth("test_automation_frameworks", "Test Automation Frameworks", "a test automation framework built or used — POM / Page Object Model, BDD / Cucumber, data-driven, keyword-driven, hybrid, TestNG / JUnit / PyTest framework.", [
    /framework|page\s*object|\bpom\b|\bbdd\b|cucumber|data[\s-]*driven|keyword[\s-]*driven|hybrid|testng|junit|py\.?\s?test|robot/i,
    /test|automat|selenium|cypress|playwright|bdd|cucumber|page\s*object|\bpom\b/i,
  ]),
  gth("playwright", "Playwright", "Playwright named.", [/playwright/i]),
  gth("cypress", "Cypress", "Cypress named.", [/cypress/i]),
  gth("junit", "JUnit", "JUnit named.", [/junit/i]),
  gth("testng", "TestNG", "TestNG named.", [/testng/i]),
  gth("pytest", "PyTest", "PyTest named.", [/py\.?\s?test/i]),
  gth("ci_cd", "CI/CD", "CI/CD, continuous integration / delivery, Jenkins, GitHub Actions, GitLab CI…", [
    /ci\s*\/\s*cd|\bci\b|continuous\s*(integration|delivery|deployment)|jenkins|github\s*actions|gitlab\s*ci|circle\s*ci|azure\s*devops|travis/i,
  ]),
  gth("git", "Git", "Git / GitHub / GitLab / Bitbucket named.", [/\bgit\b|github|gitlab|bitbucket/i]),
  gth("jira", "Jira", "Jira named.", [/jira/i]),
  gth("agile_scrum", "Agile/Scrum", "Agile, Scrum, sprints or Kanban.", [/agile|scrum|sprint|kanban/i]),
  gth("sdlc", "SDLC", "SDLC / software development life cycle named.", [/sdlc|software\s*development\s*life\s*cycle/i]),
  gth("stlc", "STLC", "STLC / software testing life cycle named.", [/stlc|software\s*testing\s*life\s*cycle/i]),
];

/** The last good-to-have item is derived from the evidence, not asked of the model. */
export const HANDS_ON_LABEL = "QA/Automation Testing Projects or Internship Experience";

export interface QaCandidateInput {
  /** Normalised mobile number — the candidate's UUID. */
  id: string;
  /** As pasted. */
  mobile: string;
  name: string;
  /** Resume link (Drive / Docs / any public URL) — "" when the resume text was pasted. */
  resumeUrl: string;
  /** Resume pasted as text instead of a link. */
  resumeText?: string;
  /** Which paste (batch) the candidate came in with — 1-based. */
  batch: number;
}

export interface QaProject {
  title: string;
  work: string;
  tools: string[];
}

export interface QaJob {
  company: string;
  role: string;
  duration: string;
  work: string;
}

export const QA_FOCUS = ["Primary", "Secondary", "Incidental", "None"] as const;
export type QaFocus = (typeof QA_FOCUS)[number];

export type QaResumeSource = "pdf" | "docx" | "text" | "image" | "pasted" | "";

/**
 * Version of the evidence checks. Results screened with an older version are
 * offered for re-screening (v2: files are identified before screening — photos
 * are no longer "read" as resumes — and one mention counts for one section).
 */
export const QA_CHECKS_VERSION = 2;

/** What the server sends back for one candidate — raw, verified evidence; the browser scores it. */
export interface QaEvaluation {
  id: string;
  mobile: string;
  name: string;
  resumeUrl: string;
  /**
   * ok = read by the model; screened-out = no testing / QA words anywhere (no
   * model call); invalid = the file is not a resume (photo, ID card, certificate…).
   */
  status: "ok" | "screened-out" | "invalid" | "error";
  error: string;
  /** Failed only because every model was rate-limited — worth retrying automatically. */
  retryable: boolean;
  hasSection: Record<QaSection, boolean>;
  mandatory: Record<MandatoryKey, SectionQuotes>;
  /** Good-to-have key → quotes; only items found in at least one section. */
  goodToHave: Record<string, SectionQuotes>;
  qaProjects: QaProject[];
  qaExperience: QaJob[];
  primaryProfile: string;
  qaFocus: QaFocus;
  certifications: string[];
  remarks: string;
  /** Verification notes — quotes dropped and terms the model may have missed. */
  checks: string[];
  /** Quotes were checked against the resume's text (its text layer, or its transcription). */
  evidenceVerified: boolean;
  /** The resume had no text layer (image / scanned PDF) and was transcribed first. */
  transcribed?: boolean;
  /** QA_CHECKS_VERSION the result was produced with (missing = 1). */
  checksVersion?: number;
  source: QaResumeSource;
  /** "provider/model" that read the resume ("" when no model was needed). */
  model: string;
  durationMs: number;
  analyzedAt: string;
}

/** Shortlist rules — editable at any time; changing them re-ranks without re-reading resumes. */
export interface QaRules {
  /** Minimum final score (%) to be shortlisted. */
  minScore: number;
  /** Every mandatory item present in at least one of Skills / Projects / Experience. */
  requireAllMandatory: boolean;
  /** At least one testing project or QA / testing internship (not a skills list only). */
  requireHandsOn: boolean;
  /** A QA / testing internship or job is required. */
  requireQaExperience: boolean;
  /** Keep only the best N who clear every rule (0 = no cap). */
  topN: number;
}

export const DEFAULT_RULES: QaRules = {
  minScore: 60,
  requireAllMandatory: true,
  requireHandsOn: true,
  requireQaExperience: false,
  topN: 0,
};

export interface QaBatch {
  n: number;
  addedAt: string;
  count: number;
}

/** Saved run — results are stored separately (one record per candidate). */
export interface QaRunMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  rules: QaRules;
  concurrency: number;
  batches: QaBatch[];
  candidates: QaCandidateInput[];
  /** Snapshot for the dashboard card (refreshed while the run goes). */
  stats: { evaluated: number; shortlisted: number; borderline: number; errors: number };
}

const NO_QUOTES = (): SectionQuotes => ({ skills: "", projects: "", experience: "" });

/** A result with no evidence — the base for errors (and for the evaluator to fill in). */
export function failedEvaluation(
  c: Pick<QaCandidateInput, "id" | "mobile" | "name" | "resumeUrl">,
  error: string,
  retryable: boolean,
  durationMs = 0,
): QaEvaluation {
  return {
    id: c.id,
    mobile: c.mobile,
    name: c.name,
    resumeUrl: c.resumeUrl,
    status: "error",
    error,
    retryable,
    hasSection: { skills: false, projects: false, experience: false },
    mandatory: Object.fromEntries(MANDATORY.map((d) => [d.key, NO_QUOTES()])) as Record<MandatoryKey, SectionQuotes>,
    goodToHave: {},
    qaProjects: [],
    qaExperience: [],
    primaryProfile: "",
    qaFocus: "None",
    certifications: [],
    remarks: "",
    checks: [],
    evidenceVerified: false,
    source: "",
    model: "",
    durationMs,
    analyzedAt: new Date().toISOString(),
  };
}
