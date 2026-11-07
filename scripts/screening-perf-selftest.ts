/**
 * Screening speed + accuracy safeguards — offline self-test (no database, no Google, no model):
 *   npx tsx scripts/screening-perf-selftest.ts
 *
 * Covers the parallel queue (width honoured continuously, retries, stop, errors), the CPU gate,
 * one-pass PDF reading (text, lines and links from a single parse, identical to unpdf's own
 * output), second-opinion picks and comparison, the review flags they produce, and the timing
 * summary line.
 */
import "./server-only-shim";
import { runQueue } from "@/lib/parallel-queue";
import { Gate, ioConcurrency } from "@/lib/automation/load";
import { parsePdf, parseStats, pdfAnnotationLinks, pdfBufferToLines, pdfBufferToText } from "@/lib/pdf-text";
import { compareOpinions, MAX_SECOND_OPINIONS, possibleMissFlag, secondOpinionPicks } from "@/lib/automation/second-opinion";
import { mainModelOf, missFlags, reviewFlags } from "@/lib/automation/validation";
import { timingSummary } from "@/lib/automation/screening";
import type { CandidateCheckpoint } from "@/lib/automation/store";
import type { ScreenMetrics } from "@/lib/domain-screen";
import type { InternalStanding } from "@/lib/pool/types";
import type { DomainCandidateOutcome } from "@/lib/types";

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── A minimal real PDF: two text lines and one clickable link ────────────────
function makePdf(lines: string[], link: string): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R] >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Type /Annot /Subtype /Link /Rect [72 700 200 714] /Border [0 0 0] /A << /S /URI /URI (${link}) >> >>`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

async function main() {
  // ── The parallel queue honours its width continuously ─────────────────────
  {
    let width = 1;
    let running = 0;
    let peak = 0;
    const peaks: number[] = [];
    const done: number[] = [];
    const run = async (n: number) => {
      running++;
      peak = Math.max(peak, running);
      peaks.push(running);
      await sleep(40);
      running--;
      return n;
    };
    const p = runQueue({ items: Array.from({ length: 12 }, (_, i) => i), concurrency: () => width, run, retryAfter: () => null, stopped: () => false, onDone: (n) => done.push(n) });
    await sleep(100);
    const before = peak;
    width = 4; // grows mid-run: used within the scheduler's re-check
    await p;
    check("queue: starts at width 1", before === 1, before);
    check("queue: a wider width is used mid-run (no restart needed)", peak === 4, peak);
    check("queue: every item done exactly once", done.length === 12 && new Set(done).size === 12, done);
  }
  {
    let running = 0;
    let over = false;
    let width = 4;
    const p = runQueue({
      items: Array.from({ length: 10 }, (_, i) => i),
      concurrency: () => width,
      run: async () => {
        running++;
        if (running > width && width === 4) over = true;
        await sleep(30);
        running--;
        return 0;
      },
      retryAfter: () => null,
      stopped: () => false,
      onDone: () => undefined,
    });
    await sleep(10);
    width = 1; // shrinks: running jobs finish, no new ones beyond the width start
    let maxAfterShrink = 0;
    const watch = setInterval(() => (maxAfterShrink = Math.max(maxAfterShrink, running)), 5);
    await sleep(80);
    const late = running;
    await p;
    clearInterval(watch);
    check("queue: never above the width", !over);
    check("queue: after shrinking, at most the new width runs once the old jobs finished", late <= 1, late);
  }
  {
    const attempts = new Map<number, number>();
    const finals: [number, string][] = [];
    await runQueue({
      items: [1, 2],
      concurrency: () => 2,
      run: async (n) => {
        attempts.set(n, (attempts.get(n) ?? 0) + 1);
        return n === 1 && attempts.get(n)! < 3 ? "retry" : "ok";
      },
      retryAfter: (r, attempt) => (r === "retry" && attempt < 5 ? 20 : null),
      stopped: () => false,
      onDone: (n, r) => finals.push([n, r]),
    });
    check("queue: a passing failure is retried after its pause, onDone sees only the final result", attempts.get(1) === 3 && finals.length === 2 && finals.every(([, r]) => r === "ok"), { attempts: [...attempts], finals });
  }
  {
    let stop = false;
    const started: number[] = [];
    const out = await runQueue({
      items: [1, 2, 3, 4, 5, 6],
      concurrency: () => 2,
      run: async (n) => {
        started.push(n);
        if (n === 2) stop = true;
        await sleep(20);
        return n;
      },
      retryAfter: () => null,
      stopped: () => stop,
      onDone: () => undefined,
    });
    check("queue: Stop lets running jobs finish and returns the unstarted", out.done === 2 && out.unstarted.join() === "3,4,5,6" && started.join() === "1,2", { out, started });
  }
  {
    let finishedOther = false;
    let error = "";
    try {
      await runQueue({
        items: [1, 2],
        concurrency: () => 2,
        run: async (n) => {
          if (n === 1) throw new Error("boom");
          await sleep(30);
          finishedOther = true;
          return n;
        },
        retryAfter: () => null,
        stopped: () => false,
        onDone: () => undefined,
      });
    } catch (e) {
      error = (e as Error).message;
    }
    check("queue: an error is rethrown after the running jobs finished", error === "boom" && finishedOther, { error, finishedOther });
  }

  // ── CPU gate ──────────────────────────────────────────────────────────────
  {
    const gate = new Gate(() => 1);
    let inside = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        gate.run(async () => {
          inside++;
          peak = Math.max(peak, inside);
          await sleep(10);
          order.push(n);
          inside--;
        }),
      ),
    );
    check("gate: one at a time at width 1, everyone gets through in order", peak === 1 && order.join() === "1,2,3,4", { peak, order });
    const g2 = new Gate(() => 2);
    let in2 = 0;
    let p2 = 0;
    await Promise.all([1, 2, 3, 4, 5].map(() => g2.run(async () => ((in2++, (p2 = Math.max(p2, in2))), await sleep(10), in2--))));
    check("gate: width 2 runs two at once", p2 === 2, p2);
    let threw = false;
    await gate.run(async () => {
      throw new Error("x");
    }).catch(() => (threw = true));
    let after = false;
    await gate.run(async () => void (after = true));
    check("gate: a failing task releases its slot", threw && after);
    const MB = 1024 * 1024;
    check("io width: memory only — full at 200 MB, halved at 400 MB, at most 2 at 460 MB", ioConcurrency(6, 10, 200 * MB) === 6 && ioConcurrency(6, 10, 400 * MB) === 3 && ioConcurrency(6, 10, 460 * MB) === 2);
  }

  // ── One-pass PDF reading ──────────────────────────────────────────────────
  {
    const pdf = makePdf(["EDUCATION B.Tech 2024", "PROJECTS Sales dashboard in Excel"], "https://github.com/asha-k");
    const before = parseStats.parses;
    const [text, lines, links] = await Promise.all([pdfBufferToText(pdf), pdfBufferToLines(pdf), pdfAnnotationLinks(pdf)]);
    check("pdf: one parse serves text, lines and links", parseStats.parses - before === 1, parseStats.parses - before);
    check("pdf: link annotation read", links.join() === "https://github.com/asha-k", links);
    check("pdf: lines keep the line breaks", lines.includes("EDUCATION B.Tech 2024") && lines.includes("PROJECTS Sales dashboard in Excel") && lines.includes("\n"), lines);
    // The same result as unpdf's own extraction (what the code did before).
    const { extractText, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(pdf), { verbosity: 0 });
    const merged = (await extractText(doc, { mergePages: true })).text as string;
    await doc.destroy();
    check("pdf: text identical to unpdf mergePages", text === merged.trim(), { text, merged });
    await parsePdf(pdf);
    check("pdf: asking again doesn't parse again", parseStats.parses - before === 1);
    await pdfBufferToText(Buffer.from(pdf));
    check("pdf: another Buffer with the same bytes (no database here) is parsed once more", parseStats.parses - before === 2);
    const broken = Buffer.from("%PDF-1.4 not really a pdf");
    check("pdf: an unreadable file gives empty text and no links, never throws", (await pdfBufferToText(broken)) === "" && (await pdfAnnotationLinks(broken)).length === 0);
  }

  // ── Second opinions: who, and when they disagree ──────────────────────────
  const tier = (t: 1 | 2 | 3): InternalStanding => ({ tier: t, label: `T${t}`, product: "edge2", score: 50, eligible: true, matchedBy: "phone", standings: [] });
  const c = (id: string, fit: number, o: Partial<DomainCandidateOutcome> = {}) =>
    ({
      id,
      name: id,
      resumeUrl: "",
      domainScore: fit,
      meetsMandatory: true,
      coreSkills: [],
      evidence: "",
      githubStatus: "off",
      githubScore: 0,
      githubTopRepos: [],
      githubCommits2y: 0,
      leetcodeSolved: 0,
      codeforcesSolved: 0,
      internal: null,
      rank: 0,
      shortlisted: false,
      outcomeReason: "",
      ...o,
    }) as unknown as DomainCandidateOutcome;
  const cfg = { topN: 3, useGithub: false, useDsa: false, mandatoryActive: true, dsaGates: { minSolved: 0, minContests: 0, minScore: 0, minRating: { leetcode: 0, codeforces: 0, codechef: 0 } } };
  {
    // External bar 55. Ranked clearing pool: a 95, b 90, c 80, d 75, e 70, f 66, g 60 (cut-off after c).
    const pool = [c("a", 95), c("b", 90), c("c", 80), c("d", 75), c("e", 70), c("f", 66), c("g", 60), c("h", 30), c("o", 70, { meetsMandatory: false, mandatoryOverruled: ["Python"] }), c("z", 20, { meetsMandatory: false, mandatoryOverruled: ["SQL"] })];
    const picks = secondOpinionPicks(pool, cfg);
    check("picks: an overruled must-have near the bar comes first", picks[0] === "o", picks);
    check("picks: an overruled candidate far below the bar is skipped", !picks.includes("z"), picks);
    check("picks: the places around the top-N cut-off (3 above, 4 below)", ["a", "b", "c", "d", "e", "f", "g"].every((id) => picks.includes(id)), picks);
    check("picks: a fit far below the bar isn't picked", !picks.includes("h"), picks);
    check("picks: capped", secondOpinionPicks(Array.from({ length: 40 }, (_, i) => c(`n${i}`, 55 + (i % 5))), cfg).length === MAX_SECOND_OPINIONS);
    check("picks: candidates with an opinion already are skipped", !secondOpinionPicks([c("a", 56, { secondOpinion: { scoredBy: "x", domainScore: 56, meetsMandatory: true, agrees: true, difference: "", at: "" } })], null).length);
    check("picks: assessed candidates use their own bar (40)", secondOpinionPicks([c("t", 44, { internal: tier(1) })], null).join() === "t");
  }
  {
    const first = c("a", 70);
    check("compare: same side of the bar, close scores → agree", compareOpinions(first, { domainScore: 62, meetsMandatory: true, scoredBy: "openai/m" }, true).agrees);
    const side = compareOpinions(first, { domainScore: 50, meetsMandatory: true, scoredBy: "openai/m" }, true);
    check("compare: the other side of the bar → disagree, says why", !side.agrees && side.difference.includes("70 vs 50") && side.difference.includes("bar 55"), side);
    check("compare: 15+ points apart → disagree", !compareOpinions(c("a", 95), { domainScore: 78, meetsMandatory: true, scoredBy: "m" }, true).agrees);
    const must = compareOpinions(c("a", 70, { meetsMandatory: false, mandatoryOverruled: ["Python"] }), { domainScore: 72, meetsMandatory: true, scoredBy: "openai/m" }, true);
    check("compare: must-haves differ → disagree, names what the first couldn't find", !must.agrees && must.difference.includes("Python"), must);
    check("compare: must-haves ignored when none were set", compareOpinions(c("a", 70, { meetsMandatory: false }), { domainScore: 70, meetsMandatory: true, scoredBy: "m" }, false).agrees);
  }
  {
    const plan = { github: "off", dsa: { use: false, gates: cfg.dsaGates } } as const;
    const so = { scoredBy: "openai/m", domainScore: 40, meetsMandatory: true, agrees: false, difference: "domain fit 70 vs 40 by openai/m (bar 55)", at: "" };
    const flags = reviewFlags(c("a", 70, { shortlisted: true, secondOpinion: so, domainProofs: [{ source: "project", quote: "q" }] as never }), plan as never, { mainModel: "gemini/gemini-2.5-flash" });
    check("flags: a shortlisted candidate the second opinion disagrees on is flagged", flags.some((f) => f.startsWith("Second opinion disagrees")), flags);
    const mixed = reviewFlags(c("b", 80, { shortlisted: true, scoredBy: "mistral/x", domainProofs: [{ source: "project", quote: "q" }] as never }), plan as never, { mainModel: "gemini/gemini-2.5-flash" });
    check("flags: judged by a different model than the rest of the job", mixed.some((f) => f.includes("Judged by mistral/x")), mixed);
    check("main model: the most frequent", mainModelOf([{ scoredBy: "g" }, { scoredBy: "g" }, { scoredBy: "o" }, {}]) === "g");
    const miss = c("m", 50, { secondOpinion: { ...so, domainScore: 72, difference: "domain fit 50 vs 72" } });
    check("possible miss: not shortlisted, the second opinion would shortlist", possibleMissFlag(miss, true).startsWith("Possible miss") && missFlags(miss, true).length === 1);
    check("possible miss: not when the second opinion also rejects", !possibleMissFlag(c("m", 50, { secondOpinion: { ...so, domainScore: 45 } }), true));
    check("possible miss: not when the second opinion finds a must-have missing", !possibleMissFlag(c("m", 50, { secondOpinion: { ...so, domainScore: 80, meetsMandatory: false } }), true));
  }

  // ── Timing summary ────────────────────────────────────────────────────────
  {
    const m = (o: Partial<ScreenMetrics>): ScreenMetrics => ({ downloadMs: 1800, gateWaitMs: 500, readMs: 400, ocrMs: 0, judgeMs: 15_000, totalMs: 18_000, textFromCache: false, judgementFromCache: false, ocrFromCache: false, scoredBy: "gemini/gemini-2.5-flash", ...o });
    const cps = [m({}), m({ textFromCache: true, readMs: 20 }), m({ judgementFromCache: true, judgeMs: 30 }), m({ ocrMs: 9000, scoredBy: "openai/gpt-5.4-mini" })].map((metrics) => ({ metrics }) as unknown as CandidateCheckpoint);
    const line = timingSummary(cps, 125_000);
    check("timing: wall time, medians, cache hits and models in one line", line.includes("2m 5s for 4 resumes") && line.includes("AI 15.0s") && line.includes("From cache: 1 files, 1 judgements, 0 scans") && line.includes("gemini/gemini-2.5-flash 3, openai/gpt-5.4-mini 1") && line.includes("scans 1"), line);
    check("timing: no metrics → just the wall time", timingSummary([], 5_000) === "Screening took 5.0s.");
  }

  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `All ${passed} screening speed / safeguard checks passed.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
