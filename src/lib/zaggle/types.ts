import type { QaCandidateInput, QaItemDef, SectionQuotes } from "@/lib/qa-types";

/**
 * Zaggle (ZagMoney) — SDE 1 Backend Engineer screening. Everything here comes
 * from the JD and the client's rubric:
 *
 *  MANDATORY (all needed for 100%):
 *   1. a backend language among Java, Kotlin, Go, Python, Node.js, C#
 *   2. Data Structures & Algorithms
 *   3. APIs
 *   4. SQL
 *   5. 1 year of relevant FULL-TIME backend / software engineering experience —
 *      summed across companies, overlaps counted once (12–23 months by default)
 *   6. experience at a software product company
 *   7. no consulting / IT services background
 *  GOOD TO HAVE: each one found raises the score above 100%.
 *
 * Items 1–4 and the good-to-haves are shown with the exact resume words, per
 * Skills / Projects / Experience section. Items 5–7 come from the work history:
 * the model reads each job (company, title, type, dates as written, what the work
 * was, what kind of company it is) and the program does the rest — parses the
 * dates, adds up the months and checks the employer against the known IT
 * services / consulting list. Plain data: travels over JSON and into IndexedDB.
 */

export const ZAGGLE_ROLE = {
  company: "Zaggle (ZagMoney)",
  title: "SDE 1 – Backend Engineer",
  location: "Bengaluru",
} as const;

export type ZgItemDef = QaItemDef;

/** Mandatory skills — shown in at least one of Skills / Projects / Experience. */
export const ZG_SKILLS = [
  {
    key: "backend_language",
    label: "Backend language (Java / Kotlin / Go / Python / Node.js / C#)",
    rule: 'one of Java, Kotlin, Go (Golang), Python, Node.js or C# / .NET is named or used. JavaScript in the browser, React, HTML, C or C++ alone do NOT count. Quote the words that name the language (e.g. "Java", "Spring Boot (Java)", "Node.js", "Python (Django)").',
    must: [/\bjava\b(?!\s*script)|\bkotlin\b|\bgolang\b|\bgo\s*(lang|\(|programming|developer)|\bgo\b|\bpython\b|\bnode(\.?js)?\b|\bnestjs\b|\bexpress(\.?js)?\b|\bc\s*#|\bc\s*sharp\b|\.net\b|\bdotnet\b|\basp\.net\b|\bspring\b|\bdjango\b|\bflask\b|\bfastapi\b/i],
  },
  {
    key: "dsa",
    label: "Data Structures & Algorithms",
    rule: 'Data Structures, Algorithms, DSA, or real problem-solving practice: LeetCode / Codeforces / CodeChef / HackerRank / GeeksforGeeks with problems solved or a rating, competitive programming. "Problem solving" alone with nothing else does not count.',
    must: [/data\s*structures?|algorithm|\bdsa\b|leet\s*code|code\s*forces|code\s*chef|hacker\s*rank|geeks\s*for\s*geeks|\bgfg\b|competitive\s*programming|\bicpc\b/i],
  },
  {
    key: "apis",
    label: "APIs",
    rule: 'APIs built or integrated — REST / RESTful APIs, GraphQL, gRPC, API endpoints, web services, microservices, API integrations. Quote the words that show the APIs.',
    must: [/\bapis?\b|rest(ful)?\b|graph\s*ql|\bgrpc\b|endpoints?|web\s*services?|micro\s*-?\s*services?/i],
  },
  {
    key: "sql",
    label: "SQL",
    rule: 'SQL or a relational database — SQL, MySQL, PostgreSQL, Oracle, SQL Server, SQLite, MariaDB, PL/SQL, JDBC / JPA / Hibernate on a relational DB. NoSQL-only (MongoDB, Redis) does NOT count.',
    must: [/(?<!no\s?)\bsql\b|my\s*sql|postgre|\bpsql\b|oracle|sql\s*server|\bmssql\b|sqlite|maria\s*db|pl\/sql|\bjdbc\b|\bjpa\b|hibernate|\brds\b|relational/i],
  },
] as const satisfies readonly ZgItemDef[];

export type ZgSkillKey = (typeof ZG_SKILLS)[number]["key"];

function gth(key: string, label: string, rule: string, must: RegExp[]): ZgItemDef {
  return { key, label, rule, must };
}

/** Good to have — the client's list, each with what counts as evidence. */
export const ZG_GOOD_TO_HAVE: readonly ZgItemDef[] = [
  gth("java", "Java", "Java named or used (not JavaScript).", [/\bjava\b(?!\s*script)/i]),
  gth("kotlin", "Kotlin", "Kotlin named or used.", [/\bkotlin\b/i]),
  gth("spring_boot", "Spring Boot", "Spring Boot / Spring (Spring MVC, Spring Data, Spring Security) named or used.", [/\bspring\b/i]),
  gth("background_jobs", "Background Jobs", "background jobs, workers, cron / scheduled jobs, job queues (Celery, Sidekiq, BullMQ, Quartz, Hangfire).", [
    /background|worker|cron|schedul|job\s*queue|celery|sidekiq|bull\s*mq|\bbull\b|quartz|hangfire|batch\s*job|async\w*\s+job/i,
  ]),
  gth("event_driven", "Event-Driven Systems", "event-driven / message-driven architecture, pub-sub, message brokers (Kafka, RabbitMQ, SQS, SNS, Pub/Sub, NATS).", [
    /event[\s-]*driven|message[\s-]*driven|pub[\s/-]*sub|kafka|rabbit\s*mq|\bsqs\b|\bsns\b|\bnats\b|message\s*(queue|broker)|\bmq\b|event\s*bus|event\s*stream/i,
  ]),
  gth("event_consumers", "Event Consumers", "consumers / listeners / subscribers that process events or queue messages.", [
    /consumer|listener|subscriber|consum\w*\s+(events?|messages?)|process\w*\s+(events?|messages?)/i,
  ]),
  gth("retries", "Retry Mechanisms", "retries, retry / back-off logic, idempotency, dead-letter queues, failure handling for partner calls.", [
    /retr(y|ies|ied)|back[\s-]*off|idempoten|dead[\s-]*letter|\bdlq\b|circuit[\s-]*breaker|fault[\s-]*toleran/i,
  ]),
  gth("third_party", "Third-Party Integrations", "integrations with external / third-party / partner / vendor APIs or SDKs (not just using a library).", [
    /third[\s-]*party|3rd[\s-]*party|partner|vendor|external\s*(api|service|system)|integrat/i,
  ]),
  gth("payment_integrations", "Payment Integrations", "payment gateway / payment provider integration — Razorpay, Stripe, PayU, Cashfree, Juspay, Paytm, PhonePe, UPI, PayPal.", [
    /razorpay|stripe|payu|cashfree|juspay|paytm|phonepe|\bupi\b|paypal|payment\s*(gateway|integration|provider|api)|integrat\w*.{0,30}payment|payment.{0,30}integrat/i,
  ]),
  gth("banking_integrations", "Banking Integrations", "integration with banks or banking rails — bank APIs, NEFT / IMPS / RTGS, account aggregator, KYC / verification vendors, NPCI.", [
    /bank|neft|imps|rtgs|account\s*aggregator|\bkyc\b|\bckyc\b|e[\s-]*kyc|npci|nach|mandate|penny\s*drop/i,
  ]),
  gth("debugging", "Debugging", "debugging, troubleshooting or fixing bugs / issues.", [/debug|troubleshoot|bug\s*fix|fix\w*\s.{0,20}(bugs?|issues?)/i]),
  gth("rca", "Root Cause Analysis (RCA)", "root cause analysis / RCA / identifying the root cause of incidents.", [/root[\s-]*cause|\brca\b/i]),
  gth("data_modeling", "Data Modeling", "data models / database schemas / entity design / normalisation designed.", [
    /data\s*model|schema|entity|\ber\s*diagram|normali[sz]|database\s*design|table\s*design/i,
  ]),
  gth("backend_architecture", "Backend Architecture", "backend / service architecture designed — microservices, layered / clean / hexagonal architecture, service design.", [
    /architect|micro\s*-?\s*services?|monolith|service[\s-]*oriented|layered|hexagonal|clean\s*architecture|modular/i,
  ]),
  gth("clean_code", "Clean Code", "clean / maintainable / readable code, code reviews, SOLID, refactoring, coding standards, unit tests written.", [
    /clean\s*code|maintainab|readab|code\s*reviews?|\bsolid\b|refactor|coding\s*standards|best\s*practices|unit\s*tests?|junit|pytest|jest/i,
  ]),
  gth("reliable_services", "Reliable Backend Services", "reliability work — uptime / SLAs, monitoring, alerting, logging, high availability, scaling, performance tuning of backend services.", [
    /reliab|uptime|\bsla\b|monitor|alert|logging|observab|high\s*availab|scal(ab|ing|ed)|latency|performance|throughput|resilien/i,
  ]),
  gth("ownership", "End-to-End Feature Ownership", "owned a feature or module end to end — design to production, \"owned\", \"led the feature\", \"end-to-end\".", [
    /own(ed|ership|ing)|end[\s-]*to[\s-]*end|led\s+the|from\s+design\s+to|single[\s-]*handedly|independently\s+(built|developed|delivered)/i,
  ]),
  gth("fintech", "Fintech Applications", "worked on fintech products — payments, lending, wallets, cards, banking, insurance, trading, expense management.", [
    /fin\s*tech|financ|bank|lending|loan|wallet|card|insur|trading|invest|payment|expense|credit|\bupi\b|neo\s*bank|\bnbfc\b|mandate|mutual\s*fund|paytm|phonepe|razorpay|\bcred\b|jupiter|groww|zerodha|\bslice\b|\bzeta\b|juspay|cashfree|payu|mobikwik|bharatpe|pine\s*labs|zaggle|policybazaar/i,
  ]),
  gth("payments", "Payments", "payments work — payment flows, transactions, settlements, refunds, reconciliation, UPI.", [
    /payment|transaction|settlement|refund|reconcil|\bupi\b|payout|checkout/i,
  ]),
  gth("credit_products", "Credit Products", "credit products — loans, lending, credit cards, credit lines, BNPL, underwriting, credit scoring.", [
    /credit|loan|lend|bnpl|buy\s*now|underwrit|emi\b/i,
  ]),
  gth("rewards", "Rewards Systems", "rewards / loyalty / cashback / points / referral systems.", [/reward|loyalt|cash\s*back|points|referral|incentive|coupon|voucher/i]),
  gth("production_issues", "Production Issue Resolution", "production issues / incidents resolved, on-call, hotfixes, live-site / prod support.", [
    /production|prod\b|incident|on[\s-]*call|hot\s*fix|live\s*(issues?|site)|outage|sev\s*\d|p[0-2]\s*(issues?|incidents?)/i,
  ]),
  gth("system_design", "System Design", "system design / designing scalable systems / high-level or low-level design (HLD / LLD).", [
    /system\s*design|\bhld\b|\blld\b|high[\s-]*level\s*design|low[\s-]*level\s*design|design\w*\s.{0,30}scalab|distributed\s*system/i,
  ]),
];

// ── Work history ─────────────────────────────────────────────────────────────

export const EMPLOYMENT_TYPES = ["full-time", "internship", "contract", "part-time", "freelance", "apprenticeship"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** What the role's work actually was. */
export const ROLE_FOCUS = ["backend", "fullstack", "software", "frontend", "mobile", "qa", "data", "devops", "non-software"] as const;
export type RoleFocus = (typeof ROLE_FOCUS)[number];

export const ROLE_FOCUS_LABEL: Record<RoleFocus, string> = {
  backend: "Backend",
  fullstack: "Full stack",
  software: "Software engineering",
  frontend: "Frontend only",
  mobile: "Mobile only",
  qa: "QA / testing",
  data: "Data / analytics / ML",
  devops: "DevOps / support / infra",
  "non-software": "Not software",
};

export const COMPANY_TYPES = ["product", "it-services", "consulting", "staffing", "unknown"] as const;
export type CompanyType = (typeof COMPANY_TYPES)[number];

export const COMPANY_TYPE_LABEL: Record<CompanyType, string> = {
  product: "Product company",
  "it-services": "IT services",
  consulting: "Consulting",
  staffing: "Staffing / payroll",
  unknown: "Unclear",
};

/** One job as read from the resume and checked by the program. */
export interface ZgJob {
  company: string;
  title: string;
  employmentType: EmploymentType;
  roleFocus: RoleFocus;
  /** The dates exactly as the resume writes them. */
  datesText: string;
  /** Parsed months ("YYYY-MM"); "" when unknown. `end` of an ongoing job = the screening month. */
  start: string;
  end: string;
  current: boolean;
  /** Dates read from the resume's own words (true), or only the model's reading (false). */
  datesVerified: boolean;
  /** Only a year was written ("2024 – 2025") — the month count is approximate. */
  datesApproximate: boolean;
  /** Only a duration was written ("6 months") — months known, calendar position not. */
  durationOnlyMonths: number | null;
  companyType: CompanyType;
  /** "list" = matched the known IT services / consulting list; "model" = the model's reading. */
  companyTypeSource: "list" | "model";
  companyTypeReason: string;
  /** One sentence: what they built. */
  work: string;
  tech: string[];
}

export interface ZgCandidateInput extends QaCandidateInput {}

/** Bump when the evidence checks change — older results are offered for a re-screen. */
export const ZG_CHECKS_VERSION = 1;

export type ZgResumeSource = "pdf" | "docx" | "text" | "image" | "pasted" | "";

/** What the server sends back for one candidate — verified evidence; the browser scores it. */
export interface ZgEvaluation {
  id: string;
  mobile: string;
  name: string;
  resumeUrl: string;
  /** ok = read; invalid = not a resume (photo, certificate…); error = could not be read. */
  status: "ok" | "invalid" | "error";
  error: string;
  /** Failed only for a passing reason (rate limit, network) — retried automatically. */
  retryable: boolean;
  hasSection: { skills: boolean; projects: boolean; experience: boolean };
  skills: Record<ZgSkillKey, SectionQuotes>;
  goodToHave: Record<string, SectionQuotes>;
  jobs: ZgJob[];
  /** Month the screening ran ("YYYY-MM") — "Present" ends here. */
  asOf: string;
  primaryProfile: string;
  remarks: string;
  /** Verification notes — quotes / jobs dropped and why. */
  checks: string[];
  evidenceVerified: boolean;
  transcribed?: boolean;
  checksVersion: number;
  source: ZgResumeSource;
  model: string;
  durationMs: number;
  analyzedAt: string;
}

/** Shortlist rules — change them any time; the ranking updates without re-reading resumes. */
export interface ZgRules {
  /** Cumulative relevant full-time months that qualify (both inclusive). */
  minMonths: number;
  maxMonths: number;
  /** Count internships toward the months (the JD says full-time — off by default). */
  countInternships: boolean;
  /** Count frontend-only / mobile-only roles as relevant (off: backend, full-stack and general SDE roles only). */
  countFrontendMobile: boolean;
  /** An internship at an IT services / consulting firm also disqualifies (off: jobs only). */
  servicesInternshipDisqualifies: boolean;
  /** Keep only the best N who clear every rule (0 = no cap). */
  topN: number;
}

export const DEFAULT_ZG_RULES: ZgRules = {
  minMonths: 12,
  maxMonths: 23,
  countInternships: false,
  countFrontendMobile: false,
  servicesInternshipDisqualifies: false,
  topN: 0,
};

export interface ZgBatch {
  n: number;
  addedAt: string;
  count: number;
}

export interface ZgRunMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  rules: ZgRules;
  concurrency: number;
  batches: ZgBatch[];
  candidates: ZgCandidateInput[];
  stats: { evaluated: number; shortlisted: number; review: number; errors: number };
}

const NO_QUOTES = (): SectionQuotes => ({ skills: "", projects: "", experience: "" });

export function failedZgEvaluation(
  c: Pick<ZgCandidateInput, "id" | "mobile" | "name" | "resumeUrl">,
  error: string,
  retryable: boolean,
  durationMs = 0,
): ZgEvaluation {
  return {
    id: c.id,
    mobile: c.mobile,
    name: c.name,
    resumeUrl: c.resumeUrl,
    status: "error",
    error,
    retryable,
    hasSection: { skills: false, projects: false, experience: false },
    skills: Object.fromEntries(ZG_SKILLS.map((d) => [d.key, NO_QUOTES()])) as Record<ZgSkillKey, SectionQuotes>,
    goodToHave: {},
    jobs: [],
    asOf: "",
    primaryProfile: "",
    remarks: "",
    checks: [],
    evidenceVerified: false,
    checksVersion: ZG_CHECKS_VERSION,
    source: "",
    model: "",
    durationMs,
    analyzedAt: new Date().toISOString(),
  };
}
