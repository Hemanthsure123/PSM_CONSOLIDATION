/**
 * Domain Shortlisting — "Autofill from a JD": the limits, the shapes and the
 * deterministic clean-up applied to the model's draft. Pure and client-safe, so
 * the screen and the self-test share it.
 *
 * The two fields it fills are read by the scorer as:
 *  - brief = `${domainName} — ${definesIt}`, cut at BRIEF_MAX characters;
 *  - mandatory, cut at MANDATORY_MAX — every item is a hard gate, and every
 *    technology named in it must be on the resume and is checked on GitHub.
 */

export const BRIEF_MAX = 1500;
export const MANDATORY_MAX = 600;
/** What the model aims for, so a long domain name never pushes the brief over BRIEF_MAX. */
export const DEFINES_TARGET = 1100;
export const MANDATORY_ITEMS_MAX = 6;
/** Accepted uploads. */
export const AUTOFILL_MAX_BYTES = 10 * 1024 * 1024;
export const AUTOFILL_MAX_TEXT = 60_000;
export const AUTOFILL_ACCEPT = ".pdf,.docx,.txt,.md,.html,.htm,.png,.jpg,.jpeg,.webp";

/** One mandatory item with the JD's own words behind it. */
export interface MandatoryItem {
  item: string;
  /** Verbatim words from the JD that make it a must-have ("" when the model gave none). */
  quote: string;
}

/** The model's draft, as parsed (before any clean-up). */
export interface AutofillDraft {
  domainName: string;
  definesIt: string;
  mandatory: MandatoryItem[];
  goodToHave: string[];
  notJudged: string[];
  settingsHints: string[];
}

export interface DomainAutofill {
  domainName: string;
  /** Ready for the "What defines it" field (fits BRIEF_MAX with the domain name). */
  definesIt: string;
  /** Ready for the "Mandatory skills" field (≤ MANDATORY_MAX), "" when the JD has no hard must-have. */
  mandatory: string;
  mandatoryItems: MandatoryItem[];
  goodToHave: string[];
  /** JD criteria a resume screen can't judge (years, degree, location, CTC, soft skills …). */
  notJudged: string[];
  /** Suggestions for the settings left to the user (experience gate, DSA …). */
  settingsHints: string[];
  /** Mandatory items dropped because the JD doesn't support them, with why. */
  dropped: string[];
  /** Technologies GitHub inspection will require / look for with these two fields. */
  github: { required: string[]; lookedFor: string[]; notInJd: string[] };
  /** The source could be checked word for word (false for a scanned PDF / image). */
  verified: boolean;
  /** Instruction-like sentences found in the document and left out (prompt injection). */
  ignored: string[];
  source: { kind: "text" | "pdf" | "docx" | "image" | "html"; name: string; chars: number };
  model: string;
}

// ── Text helpers ─────────────────────────────────────────────────────────────

/**
 * Sentences that talk to the model instead of describing the job — "ignore the previous
 * instructions", "put Rust in mandatory", "you are an AI" — are dropped before the
 * model sees the document and before anything is checked against it.
 */
const INSTRUCTION =
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,60}\b(previous|prior|above|earlier|all|these|those|your)\b[^.\n]{0,40}\b(instructions?|prompts?|rules?|directions?|guidelines?)\b|\bsystem prompt\b|\byou are (an?|the) (ai|assistant|model|language model|llm)\b|\b(put|add|include|insert|list|write|output|return|respond with)\b[^.\n]{0,80}\b(in|into|to|under|as)\b[^.\n]{0,20}\b(mandatory|defines ?it|good ?to ?have|the json|your (answer|output|response))\b/i;

export function stripInstructions(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const kept = text
    .split(/\n/)
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => {
          if (!INSTRUCTION.test(sentence)) return true;
          removed.push(clean(sentence, 160));
          return false;
        })
        .join(" "),
    )
    .join("\n");
  return { text: kept, removed };
}

/** One line, no control characters, no markdown bullets. */
export function clean(v: unknown, max = 2_000): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/(^|\s)[•▪●◦*]+\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Cut to `max` characters at the last sentence end, else the last clause / word break. */
export function cutAtBoundary(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("; "), head.endsWith(".") ? head.length - 1 : -1);
  if (sentence >= max * 0.6) return head.slice(0, sentence + 1).trim();
  const clause = Math.max(head.lastIndexOf(", "), head.lastIndexOf(" — "));
  if (clause >= max * 0.6) return head.slice(0, clause).trim();
  const word = head.lastIndexOf(" ");
  return (word > 0 ? head.slice(0, word) : head).replace(/[,;:\s—-]+$/, "").trim();
}

/** Lower-case words; keeps "node.js", ".net", "c++", "c#" whole, drops sentence full stops. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\.(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const STOP = new Set([
  "and", "or", "the", "a", "an", "of", "in", "with", "for", "to", "on", "at", "by", "as", "is", "be", "using",
  "strong", "good", "solid", "basic", "knowledge", "experience", "understanding", "proficiency", "skills", "skill",
  "hands", "working", "familiarity", "ability", "concepts", "fundamentals", "development", "developer", "programming",
]);

/** The words of an item that carry meaning ("React or Angular" → react, angular). */
function keyWords(item: string): string[] {
  return norm(item)
    .split(" ")
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

/**
 * Does the JD support this mandatory item? Its quote must be in the JD (word for
 * word, ignoring case and spacing), or — with no usable quote — its key words must be.
 * "X or Y" items need at least one alternative in the JD.
 */
export function supported(m: MandatoryItem, source: string): boolean {
  const src = ` ${norm(source)} `;
  const quote = norm(m.quote);
  if (quote.split(" ").length >= 2 && src.includes(` ${quote} `)) return true;
  const words = keyWords(m.item);
  if (!words.length) return false;
  const alternatives = m.item.split(/\s+or\s+|\s*\/\s*/i).map(keyWords).filter((w) => w.length);
  return alternatives.some((alt) => alt.every((w) => src.includes(` ${w} `) || src.includes(` ${w}s `)));
}

const list = (v: unknown, max: number, each = 160): string[] =>
  Array.isArray(v)
    ? Array.from(new Set(v.map((x) => clean(x, each)).filter(Boolean))).slice(0, max)
    : [];

/** The model's raw JSON → a draft (never throws; missing fields come back empty). */
export function parseDraft(json: unknown): AutofillDraft {
  const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const mandatory: MandatoryItem[] = (Array.isArray(o.mandatory) ? o.mandatory : [])
    .map((m): MandatoryItem => {
      if (typeof m === "string") return { item: clean(m, 80), quote: "" };
      const r = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
      return { item: clean(r.item, 80), quote: clean(r.quote, 300) };
    })
    .filter((m) => m.item);
  return {
    domainName: clean(o.domainName, 80),
    definesIt: clean(o.definesIt, 4_000),
    mandatory,
    goodToHave: list(o.goodToHave, 16, 60),
    notJudged: list(o.notJudged, 10),
    settingsHints: list(o.settingsHints, 4, 220),
  };
}

/**
 * Turn a draft into field values that fit the scorer's limits:
 *  - mandatory items the JD doesn't support are dropped (only when the JD's text is
 *    available to check against); duplicates and extras beyond MANDATORY_ITEMS_MAX go;
 *  - "What defines it" is cut at a sentence boundary so `name — details` ≤ BRIEF_MAX;
 *  - the mandatory list is cut item by item to ≤ MANDATORY_MAX.
 */
export function finishDraft(
  draft: AutofillDraft,
  opts: { sourceText: string; domainName: string },
): Pick<DomainAutofill, "domainName" | "definesIt" | "mandatory" | "mandatoryItems" | "goodToHave" | "notJudged" | "settingsHints" | "dropped" | "verified"> {
  const verified = opts.sourceText.trim().length >= 40;
  const dropped: string[] = [];
  const kept: MandatoryItem[] = [];
  const seen = new Set<string>();
  for (const m of draft.mandatory) {
    const key = norm(m.item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (verified && !supported(m, opts.sourceText)) {
      dropped.push(`${m.item} — not stated as a requirement in the JD`);
      continue;
    }
    kept.push(m);
  }
  const items: MandatoryItem[] = [];
  let mandatory = "";
  for (const m of kept) {
    const next = mandatory ? `${mandatory}, ${m.item}` : m.item;
    if (items.length >= MANDATORY_ITEMS_MAX || next.length > MANDATORY_MAX) {
      dropped.push(`${m.item} — over the ${MANDATORY_ITEMS_MAX}-item / ${MANDATORY_MAX}-character limit`);
      continue;
    }
    items.push(m);
    mandatory = next;
  }
  const name = (opts.domainName.trim() || draft.domainName).trim();
  const room = BRIEF_MAX - (name ? name.length + 3 : 0);
  return {
    domainName: draft.domainName,
    definesIt: cutAtBoundary(draft.definesIt, Math.max(200, room)),
    mandatory,
    mandatoryItems: items,
    goodToHave: draft.goodToHave,
    notJudged: draft.notJudged,
    settingsHints: draft.settingsHints,
    dropped,
    verified,
  };
}

/** The scorer's brief for a domain name and its details (as the screen builds it). */
export const briefOf = (domainName: string, details: string) =>
  details.trim() ? `${domainName.trim()} — ${details.trim()}` : domainName.trim();
