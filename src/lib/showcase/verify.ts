import "server-only";
import { githubBudget, inspectRepository, type GithubCommitItem, type RepoInspection } from "@/lib/github-analysis";
import { auditStrict, buildIdentity, isCandidateCommit, traceFiles } from "@/lib/bucketing/commit-integrity";
import { parseGithubLink } from "@/lib/github-repo";
import { getCodeforcesOwnerName } from "@/lib/coding-stats";
import { coalesce, inspectionCacheKey, readInspectionCache, writeInspectionCache } from "@/lib/github-inspect-cache";
import { readPlatformOne } from "@/lib/showcase/dsa";
import { rolesFromEvidence } from "@/lib/showcase/roles";
import { SP_VERSIONS, type SpDsa, type SpProjectProof, type SpSignal, type SpVerify } from "@/lib/showcase/types";
import type { DsaPlatform } from "@/lib/dsa-types";

/**
 * Sample profiles — prove the flagship projects on GitHub. For each project: find its repo (the
 * resume's own link for it, else a repo on the candidate's account whose name matches the title),
 * inspect what the code proves (manifests, imports, config — github-analysis), audit every commit
 * (whose they are, AI coding-tool signatures — bucketing/commit-integrity), count the candidate's
 * own commits and active days, look for AI app-generator residue, and note which claims the code
 * backs (tests / CI, Docker, realtime, auth …). Raw facts go back; the browser decides "verified"
 * against the adjustable thresholds. Also completes the DSA picture (all three platforms, owner
 * names) for finalists. Never throws; GitHub's rate limit comes back as a retry-after.
 */

const VERSION = 2;
const CALLS_PER_CANDIDATE = 45;
const MAX_COMMITS = 200;

export interface VerifyRequest {
  id: string;
  login: string;
  names: string[];
  projects: { title: string; repoUrl: string; techKeys: string[]; roles: string[] }[];
  /** The candidate's own repos from the probe (name + url), for name matching. */
  repos: { name: string; url: string }[];
  links: Partial<Record<DsaPlatform, string>>;
  /** Platforms already read in full (solved known) — not read again. */
  dsaKnown: SpDsa;
}

const tokens = (s: string) =>
  (s ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^(app|application|project|website|web|system|platform|using|based|the|and|for|with|api|clone|portfolio)$/.test(w));
const squeeze = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The repo on their account that names this project ("" when none is close enough). */
export function matchRepo(title: string, repos: { name: string; url: string }[]): string {
  const want = tokens(title);
  const sq = squeeze(title);
  let best = "";
  let bestScore = 0;
  for (const r of repos) {
    const have = new Set(tokens(r.name));
    const shared = want.filter((w) => have.has(w)).length;
    let score = want.length ? shared / want.length : 0;
    const rs = squeeze(r.name);
    if (sq.length >= 5 && rs.length >= 5 && (rs.includes(sq) || sq.includes(rs))) score = Math.max(score, 0.9);
    if (score > bestScore) {
      bestScore = score;
      best = r.url;
    }
  }
  return bestScore >= 0.6 ? best : "";
}

const CORROBORATE: [SpSignal, (p: string[], d: string[], r: RepoInspection) => boolean][] = [
  ["testing-ci", (p, d) => p.some((x) => /(?:^|\/)\.github\/workflows\/|(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[jt]sx?$|_test\.(?:py|go)$|(?:^|\/)test_[^/]+\.py$/i.test(x)) || d.some((x) => /^(jest|vitest|mocha|pytest|junit|@testing-library\/.+|cypress|playwright)$/i.test(x))],
  ["realtime", (_p, d) => d.some((x) => /^(socket\.io|socket\.io-client|ws|channels|pusher|pusher-js|@microsoft\/signalr|sockjs-client|stompjs)$/i.test(x))],
  ["security", (_p, d) => d.some((x) => /^(jsonwebtoken|bcrypt|bcryptjs|passport|passport-.+|spring-boot-starter-security|django-allauth|next-auth|@auth\/.+|argon2|helmet|python-jose|pyjwt|flask-jwt-extended)$/i.test(x))],
  ["architecture", (p, d) => p.some((x) => /(?:^|\/)docker-compose\.ya?ml$/i.test(x)) || d.some((x) => /^(redis|ioredis|kafkajs|kafka-python|amqplib|bull|bullmq|celery|pika)$/i.test(x))],
  ["deployed", (p, _d, r) => Boolean(r.homepage) || p.some((x) => /(?:^|\/)(vercel\.json|netlify\.toml|Procfile|render\.yaml|app\.yaml|fly\.toml|Dockerfile)$/i.test(x))],
  ["integrations", (_p, d) => d.some((x) => /^(stripe|razorpay|twilio|aws-sdk|@aws-sdk\/.+|boto3|firebase-admin|googleapis|@google-cloud\/.+|openai|@sendgrid\/mail|nodemailer)$/i.test(x))],
  ["ml-evaluation", (p, d) => d.some((x) => /^(scikit-learn|sklearn|torchmetrics|evaluate|mlflow|wandb)$/i.test(x)) || p.some((x) => /eval(?:uate|uation)?\.py$|metrics\.py$/i.test(x))],
];

const resetWait = (reason: string) => {
  const m = reason.match(/resets at (\d{9,})/);
  return m ? Math.max(10_000, Number(m[1]) * 1000 - Date.now() + 2_000) : 60_000;
};

async function proveOne(p: VerifyRequest["projects"][number], req: VerifyRequest, budget: ReturnType<typeof githubBudget>): Promise<SpProjectProof> {
  const base: SpProjectProof = {
    title: p.title,
    repoUrl: "",
    matchedBy: "",
    status: "no-repo",
    why: "",
    techMatch: false,
    audited: 0,
    foreignCommits: 0,
    aiCommits: 0,
    provenTechs: [],
    provenKeys: [],
    ownCommits: 0,
    share: 0,
    activeDays: 0,
    srcFiles: 0,
    aiTraces: [],
    corroborated: [],
    homepage: "",
  };
  const repoOf = (u: string) => {
    const l = parseGithubLink(u);
    return l.kind === "repo" ? { owner: l.owner, repo: l.repo } : null;
  };
  let url = p.repoUrl && repoOf(p.repoUrl) ? p.repoUrl : "";
  let matchedBy: SpProjectProof["matchedBy"] = url ? "resume-link" : "";
  if (!url) {
    url = matchRepo(p.title, req.repos);
    if (url) matchedBy = "name-match";
  }
  const gh = url ? repoOf(url) : null;
  if (!gh) return { ...base, why: "No repository for this project on the resume or on their GitHub" };

  const key = inspectionCacheKey({ scope: "showcase-repo", v: VERSION, repo: `${gh.owner}/${gh.repo}`.toLowerCase(), login: req.login.toLowerCase() });
  const hit = await readInspectionCache<SpProjectProof>(key);
  if (hit) return { ...hit.value, title: p.title, matchedBy, techMatch: techMatches(p, hit.value.provenKeys) };

  const res = await coalesce(key, () => inspectRepository(gh.owner, gh.repo, budget, { maxCommits: MAX_COMMITS }));
  if (!res.ok) {
    if (res.failure === "unavailable") return { ...base, repoUrl: url, matchedBy, status: "unavailable", why: res.message };
    return { ...base, repoUrl: url, matchedBy, status: "failed", why: res.failure === "empty" ? "The repository is empty" : "The repository is not found or private" };
  }
  const r = res.repo;
  if (r.fork) return { ...base, repoUrl: r.url, matchedBy, status: "failed", why: `A fork of ${r.parent}` };
  const proven = r.techs.filter((t) => t.hard && t.conf >= 0.5);
  const id = buildIdentity([req.login], r.commits, req.names);
  const audit = auditStrict(r.commits, id, { truncated: r.commitsTruncated, fileCount: r.srcFiles });
  // Days with the candidate's own commits — the same identity test as the audit.
  const days = new Set<string>();
  for (const c of r.commits as GithubCommitItem[]) {
    if (!isCandidateCommit(c, id)) continue;
    const d = (c.commit?.author?.date ?? c.commit?.committer?.date ?? "").slice(0, 10);
    if (d) days.add(d);
  }
  const traces = traceFiles(r.paths, r.readme, r.dependencies);
  if (audit.aiCount) traces.unshift(`AI coding-tool commits: ${audit.ai.map((a) => a.signature).slice(0, 2).join("; ")}`);
  const proof: SpProjectProof = {
    ...base,
    repoUrl: r.url,
    matchedBy,
    status: "verified",
    why: "",
    audited: audit.audited,
    foreignCommits: audit.foreignCount,
    aiCommits: audit.aiCount,
    provenTechs: proven.map((t) => t.label),
    provenKeys: proven.map((t) => t.key),
    ownCommits: audit.candidateCommits,
    share: audit.audited ? Math.round((audit.candidateCommits / audit.audited) * 100) / 100 : 0,
    activeDays: days.size,
    srcFiles: r.srcFiles,
    aiTraces: traces.slice(0, 6),
    corroborated: CORROBORATE.filter(([, test]) => test(r.paths, r.dependencies, r)).map(([s]) => s),
    homepage: r.homepage,
  };
  // Role-proving paths / dependencies the catalogue doesn't model (Solidity, game engines, firmware).
  const pathRoles = rolesFromEvidence(proof.provenKeys, r.paths, r.dependencies);
  proof.provenKeys = [...new Set([...proof.provenKeys, ...pathRoles.map((x) => `role:${x}`)])];
  if (!budget.stop) await writeInspectionCache(key, proof);
  return { ...proof, techMatch: techMatches(p, proof.provenKeys) };
}

/** The repo's code shows the project's own technologies, or proves the project's role. */
function techMatches(p: { techKeys: string[]; roles: string[] }, provenKeys: string[]): boolean {
  const proven = new Set(provenKeys);
  if (p.techKeys.some((k) => proven.has(k))) return true;
  const roles = new Set([...provenKeys.filter((k) => k.startsWith("role:")).map((k) => k.slice(5)), ...rolesFromEvidence(provenKeys.filter((k) => !k.startsWith("role:")))]);
  return p.roles.some((r) => roles.has(r));
}

export async function verifyCandidate(req: VerifyRequest): Promise<SpVerify> {
  const checkedAt = new Date().toISOString();
  const budget = githubBudget(CALLS_PER_CANDIDATE);
  try {
    const proofs: SpProjectProof[] = [];
    for (const p of req.projects.slice(0, 3)) proofs.push(await proveOne(p, req, budget));
    if (budget.stop && /rate limit/i.test(budget.reason)) {
      return { id: req.id, status: "error", error: `GitHub ${budget.reason}`, retryable: true, retryAfterMs: resetWait(budget.reason), proofs: [], dsa: {}, version: SP_VERSIONS.verify, checkedAt };
    }
    // Complete the DSA picture: every linked platform in full, plus who owns it.
    const dsa: SpDsa = { ...req.dsaKnown };
    const order: DsaPlatform[] = ["codeforces", "leetcode", "codechef"];
    await Promise.all(
      order.map(async (k) => {
        const url = req.links[k];
        if (!url) return;
        const known = dsa[k];
        if (!known || known.solved === null || known.solved === undefined) {
          const full = await readPlatformOne(k, url);
          dsa[k] = { ...full, ownerName: full.ownerName || known?.ownerName, contests: full.contests ?? known?.contests ?? null };
        }
        if (k === "codeforces" && dsa.codeforces && !dsa.codeforces.ownerName && dsa.codeforces.found) {
          const name = await getCodeforcesOwnerName(url);
          if (name) dsa.codeforces = { ...dsa.codeforces, ownerName: name };
        }
      }),
    );
    return { id: req.id, status: "ok", error: "", retryable: false, proofs, dsa, version: SP_VERSIONS.verify, checkedAt };
  } catch (err) {
    return { id: req.id, status: "error", error: err instanceof Error ? err.message.slice(0, 200) : "Verification failed.", retryable: true, proofs: [], dsa: {}, version: SP_VERSIONS.verify, checkedAt };
  }
}
