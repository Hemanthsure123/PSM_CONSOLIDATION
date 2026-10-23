import "server-only";
import { classifyCommitItem, isOrdinaryAutomation, type GithubCommitItem } from "@/lib/github-analysis";
import { GENERATOR_TEXT, TOOL_FILES } from "@/lib/ai-detection";
import type { CommitIntegrity, CommitOffense } from "@/lib/bucketing/types";

/**
 * Strict commit-integrity audit for Candidate Bucketing.
 *
 * A project repository is invalid when ANY non-merge commit on its default branch
 *  - was authored by someone other than the candidate (FOREIGN_COMMIT) — another
 *    GitHub account, an unlinked git identity that doesn't match the candidate,
 *    or a co-author trailer naming someone else. Cloned tutorials and forks fail
 *    here naturally: their history carries other people's commits;
 *  - carries an AI coding-tool signature (AI_TOOL_COMMIT) — vendor bot logins and
 *    emails, AI trailers (matched by email AND by unambiguous tool name), body
 *    markers such as "Generated with Claude Code". Antigravity has no official
 *    trailer, so any "antigravity" identity or trailer counts.
 * Exempt (listed, never held against the candidate): merges by the candidate,
 * the `web-flow` committer, ordinary automation (dependabot, renovate, actions).
 *
 * A clean audit means "no AI / foreign signatures found" — never "human-written":
 * inline autocomplete (Copilot, Cursor Tab) leaves no trace in git.
 */

export interface CandidateIdentity {
  /** The candidate's GitHub account(s), lower-case (a second one only when it carries their name). */
  logins: Set<string>;
  /** Git emails seen on the candidate's linked commits, plus their noreply forms. */
  emails: Set<string>;
  /** Normalised full names: git names on linked commits, GitHub profile name, resume name. */
  names: Set<string>;
  /** Name tokens (≥ 3 letters) from the resume / profile names and the login. */
  tokens: Set<string>;
}

const norm = (s: string) =>
  (s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const tokensOf = (s: string) => norm(s).split(" ").filter((t) => t.length >= 3);

export function buildIdentity(logins: string[], commits: GithubCommitItem[], names: string[]): CandidateIdentity {
  const id: CandidateIdentity = { logins: new Set(logins.map((l) => l.toLowerCase()).filter(Boolean)), emails: new Set(), names: new Set(), tokens: new Set() };
  for (const l of id.logins) {
    id.emails.add(`${l}@users.noreply.github.com`);
    id.names.add(norm(l));
    for (const t of tokensOf(l)) id.tokens.add(t);
  }
  for (const c of commits) {
    if (!id.logins.has((c.author?.login ?? "").toLowerCase())) continue;
    const email = (c.commit?.author?.email ?? "").toLowerCase();
    if (email) id.emails.add(email);
    const name = norm(c.commit?.author?.name ?? "");
    if (name) id.names.add(name);
  }
  for (const n of names) {
    const k = norm(n);
    if (!k) continue;
    id.names.add(k);
    for (const t of tokensOf(k)) id.tokens.add(t);
  }
  return id;
}

/** Is this git identity (no linked GitHub account) the candidate? */
function unlinkedIsCandidate(email: string, name: string, id: CandidateIdentity): boolean {
  const e = email.toLowerCase();
  if (e && id.emails.has(e)) return true;
  // 12345+login@users.noreply.github.com / login@…
  const noreply = e.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/);
  if (noreply && id.logins.has(noreply[1])) return true;
  const local = e.split("@")[0]?.replace(/[^a-z0-9]/g, "") ?? "";
  if (local && [...id.logins].some((l) => local === l.replace(/[^a-z0-9]/g, ""))) return true;
  const n = norm(name);
  if (n && id.names.has(n)) return true;
  // "Ravi Kumar" against resume "Ravi Kumar Reddy": every token of the git name belongs to the candidate.
  const toks = tokensOf(name);
  if (toks.length && id.tokens.size && toks.every((t) => id.tokens.has(t))) return true;
  // Email local part spelling the candidate's name ("ravikumar.reddy99").
  if (local.length >= 6 && id.tokens.size >= 2) {
    const nameTokens = [...id.tokens].filter((t) => !/\d/.test(t));
    if (nameTokens.filter((t) => local.includes(t)).length >= 2) return true;
  }
  return false;
}

/** Is this commit the candidate's (their linked account, or an unlinked git identity that is theirs)? The audit's own test. */
export function isCandidateCommit(c: GithubCommitItem, id: CandidateIdentity): boolean {
  const login = (c.author?.login ?? "").toLowerCase();
  if (login) return id.logins.has(login);
  return unlinkedIsCandidate(c.commit?.author?.email ?? "", c.commit?.author?.name ?? "", id);
}

/** Unambiguous AI coding-tool names (a human called "Claude" or "Jules" must not match — their emails do). */
const AI_NAME = /\b(antigravity|copilot|codex|chatgpt|openai|gemini|windsurf|codeium|aider|cline|kiro|junie|tabnine|lovable|qwen[- ]?coder|deepseek|cursor ?agent|claude ?code|claude (?:opus|sonnet|haiku)|gpt-?\d|amazon q|codewhisperer|replit agent|devin-ai)\b/i;
const AI_EMAIL_DOMAIN = /@(?:anthropic\.com|cursor\.com|openai\.com|windsurf\.ai|codeium\.com|aider\.chat|cognition\.ai|devin\.ai|lovable\.dev)$|^antigravity@|^gemini[^@]*@google\.com$/i;
const TRAILER = /^[ \t]*(co-authored-by|assisted-by|generated-by|ai-assistant)[ \t]*:[ \t]*([^<\n]*?)[ \t]*(?:<[ \t]*([^>\s]+)[ \t]*>)?[ \t]*$/gim;
const AI_BODY = /generated (?:with|by) \[?(?:claude code|cursor|antigravity|copilot|codex|windsurf|gemini)\b|^🤖 generated with/im;

const short = (sha: string) => (sha ?? "").slice(0, 7);
const who = (c: GithubCommitItem) => {
  const login = c.author?.login ?? "";
  const name = c.commit?.author?.name ?? "";
  const email = c.commit?.author?.email ?? "";
  return login ? `@${login}` : `${name || "unknown"}${email ? ` <${email}>` : ""} (no linked GitHub account)`;
};
const dateOf = (c: GithubCommitItem) => c.commit?.author?.date ?? c.commit?.committer?.date ?? "";

const OFFENSE_SAMPLE = 5;

/**
 * Audit a repository's history for the candidate. `fileCount` feeds the
 * single-dump flag; `truncated` = history longer than what was fetched.
 */
export function auditStrict(
  commits: GithubCommitItem[],
  id: CandidateIdentity,
  opts: { truncated: boolean; fileCount: number },
): CommitIntegrity {
  const foreign: CommitOffense[] = [];
  const ai: CommitOffense[] = [];
  let foreignCount = 0;
  let aiCount = 0;
  let audited = 0;
  let candidateCommits = 0;
  let exempt = 0;
  let unlinkedForeign = 0;
  const dates: number[] = [];

  const isCandidate = (c: GithubCommitItem) => isCandidateCommit(c, id);

  for (const c of commits) {
    const authorLogin = c.author?.login ?? "";
    const committerLogin = c.committer?.login ?? "";
    const merge = (c.parents?.length ?? 1) >= 2;

    if (isOrdinaryAutomation(authorLogin) || (!authorLogin && isOrdinaryAutomation(committerLogin))) {
      exempt += 1;
      continue;
    }
    if (merge) {
      // Merges carry no authored code; the merged branch's commits are audited on their own.
      if (isCandidate(c)) {
        exempt += 1;
      } else {
        foreignCount += 1;
        if (foreign.length < OFFENSE_SAMPLE) foreign.push({ sha: short(c.sha), author: who(c), date: dateOf(c), signature: "merge commit by someone else" });
      }
      continue;
    }

    audited += 1;
    const when = Date.parse(c.commit?.committer?.date ?? dateOf(c));
    if (Number.isFinite(when)) dates.push(when);
    const message = c.commit?.message ?? "";

    // 1) AI coding-tool signatures.
    let aiSig = "";
    const verdict = classifyCommitItem(c);
    if (verdict.cls === "AGENT_AUTHORED" || verdict.cls === "AGENT_TRAILERED" || verdict.cls === "AGENT_MARKER" || verdict.cls === "SUGGESTION") {
      aiSig = `${verdict.tool}: ${verdict.quote}`;
    }
    const coAuthors: { name: string; email: string; line: string }[] = [];
    TRAILER.lastIndex = 0;
    for (const m of message.matchAll(TRAILER)) {
      const name = (m[2] ?? "").trim();
      const email = (m[3] ?? "").trim();
      coAuthors.push({ name, email, line: m[0].trim().slice(0, 140) });
      if (!aiSig && (AI_NAME.test(name) || AI_EMAIL_DOMAIN.test(email))) aiSig = m[0].trim().slice(0, 140);
    }
    if (!aiSig) {
      const authorName = c.commit?.author?.name ?? "";
      const authorEmail = c.commit?.author?.email ?? "";
      if (AI_NAME.test(authorName) || AI_EMAIL_DOMAIN.test(authorEmail) || /antigravity/i.test(authorLogin)) {
        aiSig = `git author "${authorName}" <${authorEmail}>`;
      } else {
        const body = message.match(AI_BODY);
        if (body) aiSig = `commit message: "${body[0].trim().slice(0, 100)}"`;
      }
    }
    if (aiSig) {
      aiCount += 1;
      if (ai.length < OFFENSE_SAMPLE) ai.push({ sha: short(c.sha), author: who(c), date: dateOf(c), signature: aiSig });
      continue;
    }

    // 2) Authorship.
    if (!isCandidate(c)) {
      foreignCount += 1;
      if (!authorLogin) unlinkedForeign += 1;
      if (foreign.length < OFFENSE_SAMPLE) foreign.push({ sha: short(c.sha), author: who(c), date: dateOf(c), signature: `author ${who(c)}` });
      continue;
    }
    const otherCoAuthor = coAuthors.find((a) => !unlinkedIsCandidate(a.email, a.name, id));
    if (otherCoAuthor) {
      foreignCount += 1;
      if (foreign.length < OFFENSE_SAMPLE) foreign.push({ sha: short(c.sha), author: who(c), date: dateOf(c), signature: otherCoAuthor.line });
      continue;
    }
    candidateCommits += 1;
  }

  // Behavioural flags — lower trust, never invalidate.
  const flags: string[] = [];
  dates.sort((a, b) => a - b);
  let bulk = 0;
  let runStart = 0;
  for (let i = 1; i <= dates.length; i++) {
    if (i < dates.length && dates[i] - dates[i - 1] <= 120_000) continue;
    if (i - runStart >= 4) bulk += i - runStart;
    runStart = i;
  }
  if (audited >= 5 && bulk / audited >= 0.6) {
    flags.push(`${bulk} of ${audited} commits landed within 2 minutes of each other (rebase / one-shot push) — behavioural only.`);
  }
  if (audited > 0 && audited <= 2 && opts.fileCount >= 25) {
    flags.push(`The whole project (${opts.fileCount} files) landed in ${audited} commit${audited === 1 ? "" : "s"} — authorship history can't be checked.`);
  }
  if (unlinkedForeign > 0) {
    flags.push(`${unlinkedForeign} commit(s) from a git identity not linked to the candidate's GitHub account (an unconfigured machine counts too).`);
  }
  if (opts.truncated) flags.push("History is longer than the audit window — older commits were not checked.");

  return {
    audited,
    candidateCommits,
    exempt,
    foreignCount,
    aiCount,
    foreign,
    ai,
    truncated: opts.truncated,
    flags,
    verdict: aiCount > 0 ? "ai" : foreignCount > 0 ? "foreign" : audited === 0 ? "empty" : "clean",
  };
}

/**
 * Agent instruction files are upper-case by convention. A GenAI project documenting
 * its own agents in "docs/agents.md" or "gemini.md" is not a coding-tool trace.
 */
const EXACT_CASE: Record<string, RegExp> = {
  "AI agent (AGENTS.md)": /(^|\/)AGENTS\.md$/,
  "Claude Code": /(^|\/)(CLAUDE\.md$|\.claude\/)/,
  "Gemini CLI": /(^|\/)(GEMINI\.md$|\.gemini\/)/,
};

/**
 * AI coding-tool files and app-generator residue in a repository. README prose
 * only counts for app generators (Lovable / Bolt / v0): "built using ChatGPT"
 * in a GenAI project's README describes the product, not how it was coded.
 */
export function traceFiles(paths: string[], readme: string, dependencies: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    for (const t of TOOL_FILES) {
      if (!t.re.test(p)) continue;
      const exact = EXACT_CASE[t.tool];
      if (exact && !exact.test(p)) continue;
      out.add(`${t.tool}: ${p}`);
    }
  }
  if (dependencies.some((d) => /^lovable-tagger$/i.test(d))) out.add("Lovable: lovable-tagger in package.json");
  for (const g of GENERATOR_TEXT) {
    if (g.tool !== "AI coding tool" && g.re.test(readme)) out.add(`${g.tool}: mentioned in README`);
  }
  return [...out].slice(0, 10);
}
