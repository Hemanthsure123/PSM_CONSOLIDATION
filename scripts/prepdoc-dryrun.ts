/**
 * Prep document — dry run on real data (saves nothing to Drive / Notion / the database):
 *   npx tsx scripts/prepdoc-dryrun.ts <row number> [website] [out.html]
 * Reads the row's drill-downs and transcripts, researches the company, writes the document with
 * the LLM chain and saves the HTML locally for review. Uses one document generation call.
 */
import "./server-only-shim";
import { writeFileSync } from "node:fs";

try {
  process.loadEnvFile(".env.local");
} catch {
  console.error("No .env.local in this folder — run from the project root.");
  process.exit(1);
}

async function main() {
  const row = Number(process.argv[2]);
  const website = process.argv[3] && /^https?:\/\//.test(process.argv[3]) ? process.argv[3] : null;
  const out = process.argv[4] ?? "prepdoc-dryrun.html";
  const { readPrepSnapshot } = await import("@/lib/mobile/preps/sheet");
  const { linksFor } = await import("@/lib/mobile/preps/service");
  const { normRound } = await import("@/lib/mobile/preps/parse");
  const { readSources } = await import("@/lib/prepdocs/sources");
  const { research, generatePrepDoc } = await import("@/lib/prepdocs/generate");
  const { renderHtml } = await import("@/lib/prepdocs/render");

  const snap = await readPrepSnapshot();
  const p = snap.preps.find((x) => x.row === row);
  if (!p) throw new Error(`No prep on row ${row}.`);
  const sameJob = p.jobId ? snap.preps.filter((r) => r.jobId === p.jobId) : snap.preps.filter((r) => r.company === p.company);
  const links = linksFor(p, sameJob);
  console.log(`${p.company} · ${p.round} · ${links.length} sources`);
  const t0 = Date.now();
  const sources = await readSources(
    links.map((l) => ({ url: l.url, kind: l.kind })),
    website,
    [...new Set(sameJob.map((r) => r.candidate))],
  );
  for (const s of sources) console.log(`  ${s.kind.padEnd(10)} ${String(s.text.length).padStart(6)} chars ${s.error ? `· ${s.error}` : ""} · ${s.title.slice(0, 60)}`);
  const [companyName, ...roleParts] = p.company.split(/\s+-\s+/);
  const company = companyName.trim() || p.company;
  const role = roleParts.join(" - ").trim();
  const notes = await research(company, role, normRound(p.round), website);
  console.log(`research: ${notes ? `${notes.length} chars` : "unavailable"} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const res = await generatePrepDoc({ company, role, round: normRound(p.round), process: p.process, websiteUrl: website, linkedinUrl: null, sources, research: notes, existingText: null });
  if ("error" in res) throw new Error(res.error);
  const doc = res.doc;
  const questions = doc.sections.reduce((s, x) => s + x.questions.length, 0);
  console.log(`model ${res.model} · ${doc.sections.length} sections · ${questions} questions · ${((Date.now() - t0) / 1000).toFixed(1)} s total`);
  console.log(`unverified: ${doc.unverified.join(" | ") || "-"}`);
  writeFileSync(out, renderHtml(doc), "utf8");
  console.log(`saved ${out}`);
}

main().catch((err) => {
  console.error("Dry run failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
