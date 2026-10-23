import "./server-only-shim";
/**
 * Sample profiles self-test — pure logic only (no network, no model): reading the sheet, the DSA
 * bar and profile ownership, roles from evidence, course / template caps, GitHub proof rules,
 * gates, tiers, role tabs and top N, the run plan, and both workbooks (the company one carries no
 * name, email or phone).
 *
 *   npx tsx scripts/showcase-selftest.ts
 */
import { buildSpDataset, pickCandidateTab } from "@/lib/showcase/parse";
import { clearsBar, dsaIdentity, dsaVerdict, handleOf, sharedHandles } from "@/lib/showcase/dsa-rules";
import { batchTitleKey, courseKind, normaliseRole, rolesFromEvidence } from "@/lib/showcase/roles";
import { batchFacts, evaluateCandidate, judgeProof, pendingDsa, rankShowcase, scoreProjects, type SpRanked } from "@/lib/showcase/scoring";
import { planShowcase } from "@/lib/showcase/pipeline";
import { buildCompanyWorkbook, buildInternalWorkbook, buildRoleCsv, scrub } from "@/lib/showcase/export";
import { matchRepo } from "@/lib/showcase/verify";
import { crc32 } from "@/lib/academy/xlsx";
import {
  DEFAULT_SP_RULES,
  SP_VERSIONS,
  withSpDefaults,
  type SpCandidate,
  type SpDataset,
  type SpDsaPlatform,
  type SpJob,
  type SpProject,
  type SpProjectProof,
  type SpRecord,
  type SpRules,
  type SpSignal,
} from "@/lib/showcase/types";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const rules: SpRules = withSpDefaults({});

// ── Sheet ────────────────────────────────────────────────────────────────────

const grid = [
  ["Batch 2026 placement drive", "", "", "", "", ""],
  ["S.No", "Student Name", "Email ID", "Mobile Number", "Updated Resume", "GitHub Profile", "LeetCode Handle", "College Name"],
  ["1", "Ravi Kumar", "Ravi@Mail.com", "+91 98765 43210", "https://drive.google.com/file/d/abc/view", "https://github.com/ravik", "", "IIT X"],
  ["2", "Sita Rao", "sita@mail.com", "9123456780", "https://drive.google.com/file/d/def/view", "", "sita_lc", "NIT Y"],
  ["3", "Ravi K (repeat)", "ravi@mail.com", "", "https://drive.google.com/file/d/ghi/view", "", "", ""],
  ["4", "No Contact", "", "", "na", "", "", ""],
];
const ds0 = buildSpDataset({ url: "https://docs.google.com/spreadsheets/d/x", title: "Drive", tab: { name: "Students", values: grid } });
check("header row found below a title row", ds0.detected.name === "Student Name" && ds0.detected.resume === "Updated Resume", JSON.stringify(ds0.detected));
check("columns: github / leetcode / college", ds0.detected.github === "GitHub Profile" && ds0.detected.leetcode === "LeetCode Handle" && ds0.detected.college === "College Name");
check("repeat email removed, row without contact keyed by row", ds0.candidates.length === 3 && ds0.candidates[2].id.startsWith("row-"), ds0.candidates.map((c) => c.id).join(","));
check("email lower-cased as id", ds0.candidates[0].id === "ravi@mail.com");
check("'na' is not a resume link", ds0.candidates[2].resumeUrl === "");
check("sheet links kept", ds0.candidates[1].sheetLinks.leetcode === "sita_lc" && ds0.candidates[0].sheetLinks.github === "https://github.com/ravik");
check("repeat warning", ds0.warnings.some((w) => /repeated row/.test(w)));
const noHeaderResume = buildSpDataset({
  url: "u",
  title: "t",
  tab: { name: "T", values: [["Name", "Email", "Link"], ...Array.from({ length: 5 }, (_, i) => [`N${i}`, `n${i}@x.com`, `https://drive.google.com/file/d/${i}/view`])] },
});
check("resume column found by its links", noHeaderResume.detected.resume === "Link");
check("candidate tab picked by resume header", pickCandidateTab([{ name: "Notes", rows: [["a", "b"]] }, { name: "Data", rows: [["Name", "Email", "Resume"]] }]) === "Data");

// ── DSA ──────────────────────────────────────────────────────────────────────

const plat = (o: Partial<SpDsaPlatform>): SpDsaPlatform => ({ url: "https://x", handle: "h", solved: null, contests: null, rating: null, maxRating: null, found: true, source: "text", note: "OK", ...o });
const bar = rules.dsa;
check("CF max rating clears", clearsBar("codeforces", plat({ rating: 1420, maxRating: 1510, contests: 5 }), bar));
check("CF below bar", !clearsBar("codeforces", plat({ rating: 1420, maxRating: 1480, contests: 5 }), bar));
check("CF needs min contests", !clearsBar("codeforces", plat({ rating: 1600, contests: 2 }), bar));
check("CC 1700 clears", clearsBar("codechef", plat({ rating: 1650, maxRating: 1705, contests: 4 }), bar));
check("LC rating + solved clears", clearsBar("leetcode", plat({ rating: 1850, solved: 520, contests: 10 }), bar));
check("LC rating without 500 solved fails", !clearsBar("leetcode", plat({ rating: 1900, solved: 420, contests: 10 }), bar));
check("LC uses current rating only", !clearsBar("leetcode", plat({ rating: 1750, maxRating: 1900, solved: 900, contests: 10 }), bar));
check("not found never clears", !clearsBar("codeforces", plat({ found: false, rating: 2000, contests: 9 }), bar));

check("owner name matches", dsaIdentity(plat({ ownerName: "Ravi Kumar" }), ["Ravi Kappa"], "").identity === "confirmed");
check("owner name differs", dsaIdentity(plat({ ownerName: "Arjun Mehta" }), ["Ravi Kumar"], "").identity === "mismatch");
check("no owner name = unconfirmed", dsaIdentity(plat({}), ["Ravi Kumar"], "").identity === "unconfirmed");
check("LC linked GitHub confirms", dsaIdentity({ ...plat({ ownerName: "Zed" }), ownerGithub: "https://github.com/ravik" } as SpDsaPlatform, ["Ravi"], "ravik").identity === "confirmed");
const strongCf = plat({ url: "https://codeforces.com/profile/ravik", handle: "ravik", rating: 1700, maxRating: 1720, contests: 20, ownerName: "Ravi Kumar" });
const v1 = dsaVerdict({ codeforces: strongCf }, bar, ["Ravi Kumar"], "", new Set());
check("verdict passes by CF", v1.passed && v1.by === "codeforces" && v1.strength > 0.4 && v1.strength < 1, JSON.stringify(v1));
const v2 = dsaVerdict({ codeforces: { ...strongCf, ownerName: "Arjun Mehta" } }, bar, ["Ravi Kumar"], "", new Set());
check("someone else's profile doesn't count", !v2.passed && /someone else/.test(v2.reason));
const v3 = dsaVerdict({ codeforces: strongCf }, bar, ["Ravi Kumar"], "", new Set(["codeforces:ravik"]));
check("shared handle doesn't count", !v3.passed && /more than one row/.test(v3.reason));
const v4 = dsaVerdict({ leetcode: plat({ rating: 1500, solved: 300, contests: 4 }) }, bar, [], "", new Set());
check("below bar reason names the bar", !v4.passed && /CF ≥ 1500/.test(v4.reason));
check("handle from URL", handleOf("leetcode", "https://leetcode.com/u/Sita_LC/") === "sita_lc" && handleOf("codechef", "https://www.codechef.com/users/abc") === "abc");
check("shared handles found", sharedHandles([{ links: { leetcode: "https://leetcode.com/u/a", codeforces: "", codechef: "" } }, { links: { leetcode: "https://leetcode.com/a/", codeforces: "", codechef: "" } }]).has("leetcode:a"));

const links3 = { codeforces: "https://codeforces.com/profile/a", leetcode: "https://leetcode.com/u/a", codechef: "https://www.codechef.com/users/a" };
check("plan reads CF first", pendingDsa(links3, {}, rules) === "codeforces");
check("then LeetCode", pendingDsa(links3, { codeforces: plat({ rating: 1200, contests: 5 }) }, rules) === "leetcode");
check("then CodeChef", pendingDsa(links3, { codeforces: plat({ rating: 1200, contests: 5 }), leetcode: plat({ rating: 1500, solved: 100, contests: 3 }) }, rules) === "codechef");
check("stop once cleared", pendingDsa(links3, { codeforces: plat({ rating: 1600, contests: 5 }) }, rules) === null);
check("unanswered profile read again", pendingDsa(links3, { codeforces: plat({ found: null }) }, rules) === "codeforces");
check("…but not forever (3 unanswered reads = unreadable)", pendingDsa(links3, { codeforces: plat({ found: null, attempts: 3 }) }, rules) === "leetcode");
check("CF read under a higher bar re-read for contests", pendingDsa({ ...links3, leetcode: "", codechef: "" }, { codeforces: plat({ rating: 1550, contests: null }) }, rules) === "codeforces");

// ── Roles, courses ───────────────────────────────────────────────────────────

check("Kotlin / Android = mobile", eq(rolesFromEvidence(["android", "android-architecture"]), ["mobile"]));
check("React Native = mobile, not frontend", eq(rolesFromEvidence(["react", "react-native"]), ["mobile"]));
check("MERN = full stack", eq(rolesFromEvidence(["react", "nodejs", "mongodb"]), ["fullstack"]));
check("LLM = GenAI", rolesFromEvidence(["python", "llm"])[0] === "genai");
check("PyTorch = AI/ML", rolesFromEvidence(["pytorch"])[0] === "aiml");
check("Solidity path = blockchain", rolesFromEvidence([], ["contracts/Token.sol"]).includes("blockchain"));
check("free-text roles normalised", normaliseRole("Android Developer") === "mobile" && normaliseRole("MERN stack") === "fullstack" && normaliseRole("Quant Researcher") === "other:quant researcher");
check("course app caught", courseKind("Nxt Trendz – E-commerce") === "course" && courseKind("Shop", ["https://shop.ccbp.tech"]) === "course");
check("toy build caught", courseKind("Weather App") === "toy" && courseKind("Netflix Clone") === "toy");
check("original project not caught", courseKind("Distributed Rate Limiter") === "");
check("generic one-word titles aren't batch keys", batchTitleKey("E-commerce Website") === "" && batchTitleKey("Real-time Chat Application") === "realtimechat");

// ── Fixtures for whole candidates ────────────────────────────────────────────

let row = 2;
const cand = (id: string, name: string, over: Partial<SpCandidate> = {}): SpCandidate => ({
  id,
  sheetRow: row++,
  name,
  email: `${id}@mail.com`,
  mobile: "9876543210",
  resumeUrl: `https://drive.google.com/file/d/${id}/view`,
  sheetLinks: { github: "", leetcode: "", codeforces: "", codechef: "" },
  college: "Test College",
  degree: "B.Tech CSE",
  yog: "2026",
  values: {},
  ...over,
});
const screenOf = (c: SpCandidate, login: string, cfHandle: string, over: Partial<NonNullable<SpRecord["screen"]>> = {}): NonNullable<SpRecord["screen"]> => ({
  id: c.id,
  status: "ok",
  error: "",
  retryable: false,
  resumeUrl: c.resumeUrl,
  sha: `sha-${c.id}`,
  source: "pdf",
  links: { githubProfile: login ? `https://github.com/${login}` : "", githubRepos: [], leetcode: "", codeforces: cfHandle ? `https://codeforces.com/profile/${cfHandle}` : "", codechef: "", urls: [] },
  namedWithoutLink: [],
  inferred: [],
  fromSheet: [],
  candidateId: `NW-${c.id.toUpperCase().slice(0, 6)}`,
  version: SP_VERSIONS.screen,
  ...over,
});
const quote = (t: string) => `built ${t} end to end with my own design`;
const proj = (title: string, techKeys: string[], roles: string[], quality: number, signals: SpSignal[], over: Partial<SpProject> = {}): SpProject => ({
  title,
  section: "projects",
  roles,
  techs: techKeys,
  techKeys,
  quote: quote(title),
  signals: signals.map((type) => ({ type, quote: `${type} words for ${title}` })),
  courseQuote: "",
  teamQuote: "",
  depth: "substantial",
  quality,
  repoUrl: `https://github.com/x/${title.toLowerCase().replace(/\s+/g, "-")}`,
  demoUrl: "",
  ...over,
});
const job = (o: Partial<SpJob>): SpJob => ({ company: "Acme Labs", title: "SDE Intern", employmentType: "internship", datesText: "Jan 2026 - Jun 2026", months: 6, current: false, companyType: "product", companyTypeSource: "model", roles: ["backend"], work: "built APIs", ...o });
const readOf = (id: string, name: string, projects: SpProject[], jobs: SpJob[] = []): NonNullable<SpRecord["read"]> => ({
  id,
  status: "ok",
  error: "",
  retryable: false,
  nameOnResume: name,
  education: { degree: "B.Tech", institution: "Test College", year: "2026" },
  projects,
  jobs,
  skills: ["Java", "React"],
  skillKeys: [],
  checks: [],
  model: "test",
  transcribed: false,
  textChars: 4000,
  version: SP_VERSIONS.read,
  readAt: "2026-10-21",
});
const proofOf = (title: string, provenKeys: string[], over: Partial<SpProjectProof> = {}): SpProjectProof => ({
  title,
  repoUrl: `https://github.com/x/${title.toLowerCase().replace(/\s+/g, "-")}`,
  matchedBy: "resume-link",
  status: "verified",
  why: "",
  techMatch: true,
  audited: 40,
  foreignCommits: 0,
  aiCommits: 0,
  provenTechs: provenKeys,
  provenKeys,
  ownCommits: 40,
  share: 1,
  activeDays: 18,
  srcFiles: 60,
  aiTraces: [],
  corroborated: ["testing-ci"],
  homepage: "",
  ...over,
});
const probeOk = (login: string, name = "") => ({ status: "ok" as const, note: "", login, name, createdAt: "2023-01-01", repos: [{ name: "ledger-api", url: `https://github.com/${login}/ledger-api`, diskKb: 400, pushedAt: "", language: "Java", commits: 50, archived: false }], checkedAt: "" });
const trustOf = (id: string, flags: NonNullable<NonNullable<SpRecord["trust"]>["review"]>["flags"] = []): NonNullable<SpRecord["trust"]> => ({
  id,
  identity: { nameOnResume: "", nameMatch: true, emailFound: true, phoneFound: false },
  review: { flags, summary: "ok", model: "test", dropped: 0 },
  error: "",
  retryable: false,
  version: SP_VERSIONS.trust,
});
const verifyOf = (id: string, proofs: SpProjectProof[]): NonNullable<SpRecord["verify"]> => ({ id, status: "ok", error: "", retryable: false, proofs, dsa: {}, version: SP_VERSIONS.verify, checkedAt: "" });

/** A complete, strong record: CF 1720, the given projects verified, trust clean. */
function full(c: SpCandidate, login: string, projects: SpProject[], proofs: SpProjectProof[], o: { jobs?: SpJob[]; cf?: Partial<SpDsaPlatform>; flags?: Parameters<typeof trustOf>[1] } = {}): SpRecord {
  return {
    id: c.id,
    screen: screenOf(c, login, login),
    dsa: { codeforces: plat({ url: `https://codeforces.com/profile/${login}`, handle: login, rating: 1700, maxRating: 1720, contests: 20, ownerName: c.name, ...o.cf }) },
    probe: probeOk(login),
    read: readOf(c.id, c.name, projects, o.jobs ?? []),
    verify: verifyOf(c.id, proofs),
    trust: trustOf(c.id, o.flags ?? []),
  };
}

const cBack = cand("asha", "Asha Verma");
/** Two strong backend projects (+ a portfolio); `s` keeps each candidate's titles their own. */
const backend = (s = "") => [
  proj(`Ledger API${s}`, ["java", "spring-boot", "sql", "redis"], ["backend"], 88, ["architecture", "scale", "deployed"]),
  proj(`Rate Limiter Service${s}`, ["go", "redis"], ["backend"], 84, ["performance", "architecture"]),
  proj("Portfolio", ["html-css"], ["frontend"], 50, []),
];
const backProjects = backend();
const backRec = full(cBack, "asha", backProjects, [proofOf("Ledger API", ["java", "spring-boot", "sql"]), proofOf("Rate Limiter Service", ["go", "redis"])], { jobs: [job({ employmentType: "full-time", months: 12, title: "Backend Engineer" })] });

const cFull = cand("bala", "Bala Subramanian");
const fullProjects = [proj("Event Booking Platform", ["react", "nodejs", "mongodb"], ["fullstack"], 86, ["deployed", "real-users", "realtime"]), proj("Team Chat Hub", ["react", "nodejs", "sql"], ["fullstack"], 80, ["realtime", "security"])];
const fullRec = full(cFull, "bala", fullProjects, [proofOf("Event Booking Platform", ["react", "nodejs", "mongodb"]), proofOf("Team Chat Hub", ["react", "nodejs"])]);

const cMobile = cand("chitra", "Chitra Nair");
const mobileProjects = [proj("Offline Notes Sync", ["android", "android-architecture"], ["mobile"], 85, ["deployed", "real-users", "architecture"]), proj("Fitness Tracker", ["flutter"], ["mobile"], 79, ["deployed", "integrations"])];
const mobileRec = full(cMobile, "chitra", mobileProjects, [proofOf("Offline Notes Sync", ["android"]), proofOf("Fitness Tracker", ["flutter"])]);

// Course work only.
const cCourse = cand("dev", "Dev Patel");
const courseRec = full(cCourse, "devp", [proj("Nxt Trendz", ["react"], ["frontend"], 85, ["deployed", "security"]), proj("Jobby App", ["react"], ["frontend"], 82, ["deployed", "security"])], []);
// DSA below the bar.
const cLowDsa = cand("esha", "Esha Roy");
const lowDsaRec = full(cLowDsa, "esha", backend(" Eagle"), [], { cf: { rating: 1300, maxRating: 1380 } });
// No GitHub.
const cNoGh = cand("farah", "Farah Khan");
const noGhRec: SpRecord = { id: cNoGh.id, screen: screenOf(cNoGh, "", "farah") };
// Strong but the repos aren't theirs (foreign commits).
const cForeign = cand("gopi", "Gopi Nath");
const foreignRec = full(cForeign, "gopi", backend(" Gamma").slice(0, 2), [proofOf("Ledger API Gamma", ["java"], { ownCommits: 3, share: 0.1, foreignCommits: 37 }), proofOf("Rate Limiter Service Gamma", ["go"], { ownCommits: 0, audited: 30, foreignCommits: 30 })]);
// Strong but low trust.
const cLowTrust = cand("hari", "Hari Prasad");
const lowTrustRec = full(cLowTrust, "hari", backend(" Hydra").slice(0, 2), [proofOf("Ledger API Hydra", ["java"]), proofOf("Rate Limiter Service Hydra", ["go"])], {
  flags: [
    { category: "inflated-claim", severity: "high", evidence: "served 10M users", why: "a student project serving 10M users" },
    { category: "timeline", severity: "high", evidence: "2019 - 2026", why: "overlaps" },
    { category: "copied-text", severity: "high", evidence: "x", why: "generic" },
  ],
});
// Waiting for proof.
const cPending = cand("indu", "Indu Menon");
const pendingRec: SpRecord = { ...full(cPending, "indu", backend(" Indigo"), []), verify: undefined, trust: undefined };
// Same resume file as Asha.
const cDup = cand("jay", "Jay Shah");
const dupRec: SpRecord = { ...full(cDup, "jayy", backProjects, []), screen: { ...screenOf(cDup, "jayy", "jayy"), sha: "sha-asha" } };

const candidates = [cBack, cFull, cMobile, cCourse, cLowDsa, cNoGh, cForeign, cLowTrust, cPending, cDup];
const ds: SpDataset = { loadedAt: "", source: { url: "u", title: "Test sheet", tab: "T" }, columns: [], detected: ds0.detected, candidates, warnings: [] };
const records: Record<string, SpRecord> = {
  asha: backRec,
  bala: fullRec,
  chitra: mobileRec,
  dev: courseRec,
  esha: lowDsaRec,
  farah: noGhRec,
  gopi: foreignRec,
  hari: lowTrustRec,
  indu: pendingRec,
  jay: dupRec,
};

const out = rankShowcase(ds, records, rules);
const by = (id: string) => out.rows.find((r) => r.c.id === id)!;
const show = (r: SpRanked) => `${r.status}/${r.stage}: ${r.reason} [${r.primary?.role ?? "-"} ${r.score}]`;

check("backend candidate qualifies", Boolean(by("asha").tier) && by("asha").primary?.role === "backend", show(by("asha")));
check("backend candidate is Showcase (experience + verified + DSA)", by("asha").tier === "Showcase", show(by("asha")));
check("MERN candidate placed in Full Stack", by("bala").primary?.role === "fullstack" && Boolean(by("bala").tier), show(by("bala")));
check("Full Stack candidate also strong for Frontend / Backend", by("bala").alsoFor.some((f) => f.role === "frontend") && by("bala").alsoFor.some((f) => f.role === "backend"));
check("Kotlin / Flutter candidate in Mobile", by("chitra").primary?.role === "mobile" && Boolean(by("chitra").tier), show(by("chitra")));
check("course projects capped out", by("dev").status !== "Showcase" && by("dev").status !== "Strong" && by("dev").stage === "Projects", show(by("dev")));
check("course cap reason given", by("dev").projects.every((p) => p.quality <= 40));
check("DSA below bar excluded at DSA", by("esha").status === "Excluded" && by("esha").stage === "DSA", show(by("esha")));
check("no GitHub excluded at Screen", by("farah").status === "Excluded" && /GitHub/.test(by("farah").reason), show(by("farah")));
check("other people's commits don't verify", !by("gopi").tier && by("gopi").stage === "Verify", show(by("gopi")));
check("low trust stops at Trust", !by("hari").tier && by("hari").stage === "Trust" && by("hari").trust?.band === "Low", show(by("hari")));
check("unverified waits at Verify", by("indu").status === "Pending" && by("indu").stage === "Verify", show(by("indu")));
const reproved: SpRecord = { ...backRec, verify: { ...backRec.verify!, checkedAt: "2026-10-22" }, trust: { ...backRec.trust!, basedOn: "2026-10-21" } };
const reRow = evaluateCandidate(cBack, reproved, rules, batchFacts(ds0, {}), new Set());
check("a newer GitHub proof asks for a new trust review", reRow.status === "Pending" && reRow.stage === "Trust", show(reRow));
check("same resume file as another row excluded", by("jay").status === "Excluded" && /Same resume file as sheet row/.test(by("jay").reason), show(by("jay")));

check("tabs exist for each role with a profile", ["backend", "fullstack", "mobile"].every((r) => out.tabs.some((t) => t.role === r)), out.tabs.map((t) => t.role).join(","));
check("primary role only (no duplicate in Frontend)", !out.tabs.some((t) => t.role === "frontend"));
check("SDE tab lists elite-DSA profiles only (CF 1720 ≥ 1700 SDE bar)", out.tabs.find((t) => t.role === "sde")?.rows.length === 3);
const every = rankShowcase(ds, records, { ...rules, everyRole: true });
check("every-role switch lists Full Stack candidate in Frontend too", every.tabs.find((t) => t.role === "frontend")?.rows.some((r) => r.c.id === "bala") ?? false);
const top1 = rankShowcase(ds, records, { ...rules, topN: 1 });
check("top N limits what the company sees", top1.tabs.every((t) => t.shown.length <= 1));
const rej = rankShowcase(ds, records, rules, ["asha"]);
check("taken out by hand leaves the tab", !rej.tabs.find((t) => t.role === "backend")?.rows.some((r) => r.c.id === "asha"));
check("stats count Showcase / Strong", out.stats.showcase + out.stats.strong === 3, JSON.stringify(out.stats));
check("funnel counts every row at Screen", out.funnel.Screen.reached === candidates.length);

// Rules move results without re-reading.
const highBar = rankShowcase(ds, records, withSpDefaults({ dsa: { ...rules.dsa, codeforces: 1800 } }));
check("raising the CF bar to 1800 drops CF-1720 candidates", !highBar.rows.find((r) => r.c.id === "asha")!.tier && highBar.rows.find((r) => r.c.id === "asha")!.stage === "DSA");
const noTrust = rankShowcase(ds, records, { ...rules, trustAgent: false });
check("trust agent off: low-trust candidate no longer stopped", Boolean(noTrust.rows.find((r) => r.c.id === "hari")!.tier));
const noExpRules = { ...rules, weights: { ...rules.weights, experience: 0 } };
check("experience bonus switch changes the score", rankShowcase(ds, records, noExpRules).rows.find((r) => r.c.id === "asha")!.score < by("asha").score);

// ── Projects: caps and proof ─────────────────────────────────────────────────

const batch = batchFacts(ds, records);
const capRec: SpRecord = {
  id: "z",
  read: readOf("z", "Z", [
    proj("Plain CRUD", ["nodejs"], ["backend"], 90, []),
    proj("Two Signals", ["nodejs"], ["backend"], 90, ["deployed", "security"]),
    proj("Basic Thing", ["nodejs"], ["backend"], 90, ["deployed", "security", "scale"], { depth: "basic" }),
    proj("Tutorial", ["nodejs"], ["backend"], 90, ["deployed", "security", "scale"], { courseQuote: "as part of the bootcamp" }),
  ]),
};
const caps = scoreProjects(capRec, rules, batch);
check("no signal caps at 60", caps[0].quality === 60 && /no verified complexity signal/.test(caps[0].capReasons[0]));
check("two signals cap at 82", caps[1].quality === 82);
check("basic depth caps at 55", caps[2].quality === 55);
check("course quote caps at 40", caps[3].quality === 40 && /bootcamp/.test(caps[3].capReasons[0]));
const dupBatch = { ...batch, titleCount: new Map([["realtimechat", 4]]) };
const dupCaps = scoreProjects({ id: "y", read: readOf("y", "Y", [proj("Realtime Chat Application", ["nodejs"], ["backend"], 90, ["deployed", "security", "scale", "realtime"])]) }, rules, dupBatch);
check("title on 4 resumes in the batch caps at 40", dupCaps[0].quality === 40 && /4 resumes/.test(dupCaps[0].capReasons[0]));
check("code-backed signal lifts the cap", scoreProjects({ id: "w", read: readOf("w", "W", [proj("Svc", ["nodejs"], ["backend"], 90, ["deployed"])]), verify: verifyOf("w", [proofOf("Svc", ["nodejs"], { corroborated: ["testing-ci", "architecture"] })]) }, rules, batch)[0].quality === 90);

check("verified proof", judgeProof(proofOf("a", ["nodejs"]), rules).status === "verified");
check("fork / missing repo stays failed", judgeProof(proofOf("a", [], { status: "failed", why: "A fork of x/y" }), rules).status === "failed");
check("no own commits = failed", judgeProof(proofOf("a", [], { ownCommits: 0 }), rules).status === "failed");
check("few own commits = weak", judgeProof(proofOf("a", [], { ownCommits: 4 }), rules).status === "weak");
check("single-day dump = weak", /day/.test(judgeProof(proofOf("a", [], { activeDays: 1 }), rules).why));
check("AI traces = weak unless allowed", judgeProof(proofOf("a", [], { aiTraces: ["lovable"] }), rules).status === "weak" && judgeProof(proofOf("a", [], { aiTraces: ["lovable"] }), { ...rules, proof: { ...rules.proof, allowAiTraces: true } }).status === "verified");
check("code that doesn't show the stack = weak", judgeProof(proofOf("a", [], { techMatch: false }), rules).status === "weak");
check("repo matched by name", matchRepo("Ledger API", [{ name: "ledger-api", url: "u1" }, { name: "notes", url: "u2" }]) === "u1" && matchRepo("Weather", [{ name: "ledger", url: "u" }]) === "");

// ── Inferred handles need a confirmed owner ──────────────────────────────────

const cInf = cand("kiran", "Kiran Rao");
const infRec: SpRecord = {
  ...full(cInf, "kiran", backend(" Kappa"), []),
  screen: { ...screenOf(cInf, "kiran", "kiran"), inferred: ["codeforces"] },
  dsa: { codeforces: plat({ url: "https://codeforces.com/profile/kiran", handle: "kiran", rating: 1700, contests: 20 }) },
};
const infRow = evaluateCandidate(cInf, infRec, rules, batch, new Set());
check("written-only handle without owner doesn't count", infRow.stage === "DSA" && infRow.status === "Excluded" && /owner isn't confirmed/.test(infRow.reason), show(infRow));
const infOk = evaluateCandidate(cInf, { ...infRec, dsa: { codeforces: { ...infRec.dsa!.codeforces!, ownerName: "Kiran Rao" } } }, rules, batch, new Set());
check("written-only handle with matching owner counts", infOk.stage !== "DSA", show(infOk));

// ── Plan ─────────────────────────────────────────────────────────────────────

const cNew = cand("lata", "Lata M");
const cCfDone = cand("mohan", "Mohan D");
const cProbe = cand("nina", "Nina S");
const planDs: SpDataset = { ...ds, candidates: [cNew, cCfDone, cProbe, cPending] };
const planRecs: Record<string, SpRecord> = {
  lata: { id: "lata" },
  mohan: { id: "mohan", screen: { ...screenOf(cCfDone, "mohan", "mohan"), links: { ...screenOf(cCfDone, "mohan", "mohan").links, leetcode: "https://leetcode.com/u/mohan" } }, dsa: { codeforces: plat({ rating: 1200, contests: 4 }) } },
  nina: { id: "nina", screen: screenOf(cProbe, "nina", "nina"), dsa: { codeforces: plat({ rating: 1650, contests: 9, ownerName: "Nina S" }) } },
  indu: pendingRec,
};
const plan = planShowcase(rankShowcase(planDs, planRecs, rules), rules);
check("plan: unscreened row to screen", plan.screen.length === 1 && plan.screen[0].id === "lata");
check("plan: CF below bar → LeetCode next", plan.dsa.leetcode.length === 1 && plan.dsa.leetcode[0].id === "mohan");
check("plan: DSA passed → GitHub probe", plan.probe.length === 1 && plan.probe[0].login === "nina");
check("plan: strong projects → verify with the strong ones", plan.verify.length === 1 && plan.verify[0].projects.length === 2 && plan.verify[0].projects[0].title === "Ledger API Indigo", JSON.stringify(plan.verify[0]?.projects.map((p) => p.title)));
check("plan: verify request carries probe repos and names", plan.verify[0].repos.length === 1 && plan.verify[0].names.includes("Indu Menon"));

// ── Workbooks ────────────────────────────────────────────────────────────────

check("scrub removes email / phone / name words", scrub("Mail asha@mail.com or call +91 98765 43210 — Asha built it", ["Asha Verma"], true) === "Mail [email] or call [phone] — [name] built it");
check("scrub drops profile links when asked", scrub("see https://github.com/asha/x and leetcode.com/u/asha", [], false) === "see [link] and [link]");

const unzip = (wb: Uint8Array): Record<string, string> => {
  const view = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  const eocd = wb.byteLength - 22;
  const entries = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files: Record<string, string> = {};
  for (let i = 0; i < entries; i++) {
    const nameLen = view.getUint16(p + 28, true);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(wb.subarray(p + 46, p + 46 + nameLen));
    const localNameLen = view.getUint16(local + 26, true);
    const data = wb.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
    if (crc32(data) !== crc) files.__badcrc = name;
    files[name] = new TextDecoder().decode(data);
    p += 46 + nameLen;
  }
  return files;
};
const company = unzip(buildCompanyWorkbook(out, rules));
const companyText = Object.values(company).join("\n");
check("company workbook CRCs valid", !company.__badcrc);
check("company workbook has About + one tab per role with profiles", (company["xl/workbook.xml"].match(/<sheet /g) ?? []).length === 1 + out.tabs.filter((t) => t.shown.length).length);
check("company workbook names the roles", /Backend Engineer/.test(company["xl/workbook.xml"]) && /Mobile App Developer/.test(company["xl/workbook.xml"]));
const pii = candidates.flatMap((c) => [c.name, c.email]).concat(["9876543210"]);
check("company workbook has no names / emails / phones", pii.every((x) => !companyText.includes(x)), pii.filter((x) => companyText.includes(x)).join(", "));
check("company workbook uses Candidate IDs", companyText.includes("NW-ASHA"));
check("company workbook says verified in code", companyText.includes("Verified in code"));
check("company workbook has no trust / score internals", !/Trust checks|Score: projects|Gates/.test(companyText));
const noLinks = unzip(buildCompanyWorkbook(out, { ...rules, companyLinks: false }));
check("links switch removes GitHub / DSA columns", !Object.values(noLinks).join("\n").includes("github.com/asha") && !Object.values(noLinks).join("\n").includes("codeforces.com/profile"));

const internal = unzip(buildInternalWorkbook("Run", ds, out, rules));
const internalText = Object.values(internal).join("\n");
check("internal workbook CRCs valid", !internal.__badcrc);
check("internal workbook has names and every row", internalText.includes("Asha Verma") && internalText.includes("farah@mail.com"));
check("internal workbook has Near misses / All screened / Summary", ["Near misses", "All screened", "Summary", "Taken out by hand"].every((n) => internal["xl/workbook.xml"].includes(n)));
check("internal shows the exclusion reasons", internalText.includes("Same resume file as sheet row"));
const csv = buildRoleCsv(out.tabs.find((t) => t.role === "backend")!, "company", rules);
check("company CSV has a BOM and no name", csv.startsWith("﻿") && !csv.includes("Asha Verma") && csv.includes("Candidate ID"));

// ── Defaults ─────────────────────────────────────────────────────────────────

check("default DSA bar is the agreed one", eq(DEFAULT_SP_RULES.dsa, { codeforces: 1500, codechef: 1700, leetcode: 1800, leetcodeSolved: 500, minContests: 3 }));
check("defaults merge nested rules", withSpDefaults({ dsa: { codeforces: 1600 } as SpRules["dsa"] }).dsa.leetcode === 1800 && withSpDefaults({ dsa: { codeforces: 1600 } as SpRules["dsa"] }).dsa.codeforces === 1600);

console.log(`\nshowcase self-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
