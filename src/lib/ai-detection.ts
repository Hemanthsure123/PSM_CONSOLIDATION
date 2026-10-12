import type { FetchedRepo } from "@/lib/github-repo";

/**
 * Deterministic AI-assistance scan over a downloaded repository.
 *
 * Ordinary developer comments are fine. What this looks for is the residue
 * AI coding tools leave behind:
 *  - AI-tool traces: agent config files (.cursorrules, CLAUDE.md, AGENTS.md,
 *    copilot-instructions.md …), generator scaffolding (Lovable / Bolt / v0);
 *  - AI-style comments: chat leakage ("Here's the updated code", "I've added",
 *    "… existing code …"), placeholder instructions ("replace with your actual
 *    API key", "in a real application you would …"), "NEW:/FIXED:" edit markers;
 *  - emojis inside code comments and log/print messages.
 * Weak signals (numbered "Step 1:" narration, buzzwords, banner comments) only
 * count in bulk. Every hit is quoted with its file so a human can verify it.
 */

const SLASH_EXT = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "java", "kt", "kts", "scala", "go", "rs", "c", "h", "cc", "cpp", "hpp",
  "cs", "swift", "dart", "php", "scss", "sass", "less", "vue", "svelte", "astro", "groovy", "gradle", "prisma", "proto", "sol",
]);
const BLOCK_EXT = new Set([...SLASH_EXT, "css"]);
const HASH_EXT = new Set(["py", "rb", "sh", "bash", "zsh", "ps1", "r", "jl", "ex", "exs", "pl", "dockerfile", "makefile", "tf", "hcl"]);
const HTML_EXT = new Set(["html", "htm", "vue", "svelte", "ejs", "hbs", "astro", "xml"]);
const CODE_EXT = new Set([...SLASH_EXT, ...HASH_EXT, ...HTML_EXT, "css"]);

function ext(path: string): string {
  const base = path.split("/").pop() ?? "";
  if (/^dockerfile/i.test(base)) return "dockerfile";
  if (/^makefile$/i.test(base)) return "makefile";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** Comment texts in a source file (line, block, docstring and HTML comments). */
export function extractComments(path: string, content: string): string[] {
  const e = ext(path);
  const out: string[] = [];
  if (BLOCK_EXT.has(e)) {
    for (const m of content.matchAll(/\/\*([\s\S]*?)\*\//g)) out.push(m[1].replace(/^\s*\*+ ?/gm, "").trim());
  }
  if (SLASH_EXT.has(e)) {
    // `//` at line start or after whitespace/punctuation — never the `//` inside "https://".
    for (const m of content.matchAll(/(?:^|[\s;{}(),])\/\/(?!\/)[ \t]?(.*)$/gm)) out.push(m[1].trim());
  }
  if (HASH_EXT.has(e)) {
    // `#` after whitespace — skips "#fff" inside strings, shebangs and Ruby "#{…}".
    for (const m of content.matchAll(/(?:^|[ \t])#(?![!{[])[ \t]?(.*)$/gm)) out.push(m[1].trim());
    if (e === "py") for (const m of content.matchAll(/("""|''')([\s\S]*?)\1/g)) out.push(m[2].trim());
  }
  if (HTML_EXT.has(e)) {
    for (const m of content.matchAll(/<!--([\s\S]*?)-->/g)) out.push(m[1].trim());
  }
  return out.filter((c) => c.length > 1 && c.length < 3000);
}

/** Chat leakage and assistant boilerplate — a human almost never writes these in code. */
const STRONG_RE: { label: string; re: RegExp }[] = [
  { label: "chat reply", re: /\b(here'?s|here is) (the|an?|your) (updated|modified|complete|full|revised|improved|corrected|fixed|refactored|new)\b/i },
  { label: "assistant voice", re: /\b(i'?ve|i have|i'?ll|i will|i'?m) (added|updated|modified|changed|implemented|fixed|created|refactored|included|removed|going to)\b/i },
  { label: "assistant voice", re: /\bas an ai\b|\blanguage model\b|\bcertainly!|\bsure!|\bgreat question\b|\bhope this helps\b/i },
  { label: "elided code", re: /\.\.\.\s*(existing|rest of( the)?|previous|other|remaining|same as before)\s*(code|imports|logic|functions|methods|routes|content|implementation|file)?/i },
  { label: "placeholder instruction", re: /\breplace (this|these|it)?\s*(with|by) (your|the) (own|actual|real)\b|\b(add|put|insert) your (own|actual)\b/i },
  { label: "placeholder instruction", re: /\byour[-_ ](api[-_ ]?key|secret[-_ ]?key|secret|password|token|database[-_ ]?url|db[-_ ]?url|mongo[-_ ]?uri)[-_ ]?here\b/i },
  { label: "tutorial aside", re: /\bin a (real|production|real-world)(-world)? (app|application|scenario|environment|project|system)\b|\bin production,? you (would|should|might)\b|\bfor (demonstration|demo) purposes\b/i },
  { label: "change log in code", re: /\b(key (changes|improvements|features)|changes made|what'?s new|explanation)\s*:/i },
  { label: "change log in code", re: /\b(this|the) (updated|new|improved|enhanced|refactored|fixed) (version|code|implementation|function|component)\b/i },
  { label: "edit marker", re: /^(?:[^\w]*\s)?(NEW|CHANGED|UPDATED|FIXED|ADDED|MODIFIED)\s*[:!]/ },
  { label: "edit marker", re: /<-{1,2}\s*(add(ed)?|new|change(d)?|fix(ed)?|this line)\b/i },
];

/** Individually harmless — only telling in bulk. */
const WEAK_RE: RegExp[] = [
  /^(step\s*\d+|\d+\.)\s*[:.)-]\s*\w/i,
  /\b(robust|comprehensive|seamless(ly)?|leverag(e|es|ing)|streamline[sd]?|elegant(ly)?|delve|utiliz(e|es|ing)|meticulous(ly)?)\b/i,
  /^[=\-*#~]{4,}.*[=\-*#~]{4,}$/,
  /\b(this (function|method|component|hook|endpoint|middleware|helper|class|module) (is used to|handles|will|ensures|is responsible for))\b/i,
];

/** Pictographic emoji — minus ©, ® and ™, which are ordinary symbols. */
const EMOJI_RE = /(?![©®™])\p{Extended_Pictographic}/gu;
const LOG_RE =
  /\b(?:console\.(?:log|info|warn|error|debug)|print|println|printf|logger\.\w+|logging\.\w+|log\.(?:info|warn|error|debug)|System\.out\.print(?:ln)?|fmt\.Print(?:f|ln)?|puts)\s*\(([^\n]{0,300})/g;

const TOOL_FILES: { tool: string; re: RegExp }[] = [
  { tool: "Cursor", re: /(^|\/)(\.cursorrules|\.cursor\/)/i },
  { tool: "Claude Code", re: /(^|\/)(CLAUDE\.md$|\.claude\/)/i },
  { tool: "AI agent (AGENTS.md)", re: /(^|\/)AGENTS\.md$/i },
  { tool: "Gemini CLI", re: /(^|\/)(GEMINI\.md$|\.gemini\/)/i },
  { tool: "GitHub Copilot", re: /(^|\/)\.github\/(copilot-instructions\.md$|instructions\/|prompts\/)/i },
  { tool: "Windsurf", re: /(^|\/)(\.windsurfrules|\.windsurf\/)/i },
  { tool: "Cline / Roo", re: /(^|\/)(\.clinerules|\.roo\/|\.roomodes)/i },
  { tool: "Kiro", re: /(^|\/)\.kiro\//i },
  { tool: "Aider", re: /(^|\/)\.aider[^/]*/i },
  { tool: "Continue", re: /(^|\/)\.continue\//i },
  { tool: "Bolt", re: /(^|\/)\.bolt\//i },
  { tool: "Devin / Junie / Trae / Augment", re: /(^|\/)\.(devin|junie|trae|augment)\//i },
];

const GENERATOR_TEXT: { tool: string; re: RegExp }[] = [
  { tool: "Lovable", re: /lovable-tagger|lovable\.dev\/projects|content=["']Lovable["']|gptengineer/i },
  { tool: "Bolt", re: /\bbolt\.new\b|stackblitz\.com\/~\/|made with bolt/i },
  { tool: "v0", re: /\bv0\.dev\b|generated (by|with) v0\b/i },
  // Coding tools only — "summaries generated by AI" in an AI app's README describes the product, not the code.
  { tool: "AI coding tool", re: /(generated|built|created|written|made) (with|by|using) \[?(claude code|chatgpt|github copilot|copilot|cursor|codex|windsurf)\b/i },
];

export interface AiScan {
  commentsScanned: number;
  strongComments: string[];
  strongCount: number;
  weakCount: number;
  emojiExamples: string[];
  emojiCount: number;
  emojiFiles: number;
  toolTraces: string[];
}

const quote = (path: string, text: string) => `${path} — “${text.replace(/\s+/g, " ").slice(0, 140)}”`;

export function scanAiSignals(repo: FetchedRepo): AiScan {
  const strong: string[] = [];
  const emojiExamples: string[] = [];
  const emojiFileSet = new Set<string>();
  const traces = new Set<string>();
  let strongCount = 0;
  let weakCount = 0;
  let emojiCount = 0;
  let commentsScanned = 0;

  for (const f of repo.files) {
    for (const t of TOOL_FILES) if (t.re.test(f.path)) traces.add(`${t.tool}: ${f.path}`);
    if (!f.content) continue;
    const base = f.path.split("/").pop() ?? "";
    if (base === "package.json" || /\.(md|html?)$/i.test(base)) {
      for (const g of GENERATOR_TEXT) if (g.re.test(f.content)) traces.add(`${g.tool}: mentioned in ${f.path}`);
    }
    if (!CODE_EXT.has(ext(f.path))) continue;

    for (const c of extractComments(f.path, f.content)) {
      commentsScanned++;
      for (const line of c.split("\n")) {
        const text = line.trim();
        if (!text) continue;
        const hit = STRONG_RE.find((s) => s.re.test(text));
        if (hit) {
          strongCount++;
          if (strong.length < 8) strong.push(`${hit.label}: ${quote(f.path, text)}`);
        } else if (WEAK_RE.some((w) => w.test(text))) {
          weakCount++;
        }
        const emojis = text.match(EMOJI_RE);
        if (emojis) {
          emojiCount += emojis.length;
          emojiFileSet.add(f.path);
          if (emojiExamples.length < 6) emojiExamples.push(`comment: ${quote(f.path, text)}`);
        }
      }
    }
    for (const m of f.content.matchAll(LOG_RE)) {
      const emojis = m[1].match(EMOJI_RE);
      if (!emojis) continue;
      emojiCount += emojis.length;
      emojiFileSet.add(f.path);
      if (emojiExamples.length < 6) emojiExamples.push(`log: ${quote(f.path, m[0])}`);
    }
  }

  return {
    commentsScanned,
    strongComments: strong,
    strongCount,
    weakCount,
    emojiExamples,
    emojiCount,
    emojiFiles: emojiFileSet.size,
    toolTraces: Array.from(traces).slice(0, 10),
  };
}
