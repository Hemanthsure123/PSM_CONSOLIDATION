/**
 * RSA document — dry run on real data (saves nothing to Drive, the sheet or the database):
 *   npx tsx scripts/rsa-dryrun.ts <transcript.txt> <drill-down url> <resume url> <out.docx> [remarks]
 * Reads the drill-down and the resume like the server does, writes the RSA with the model chain
 * from the transcript file, and saves the .docx locally for review. One model call.
 */
import "./server-only-shim";
import { readFileSync, writeFileSync } from "node:fs";

try {
  process.loadEnvFile(".env.local");
} catch {
  console.error("No .env.local in this folder — run from the project root.");
  process.exit(1);
}

async function main() {
  const [transcriptFile, drilldownUrl, resumeUrl, out, remarks = ""] = process.argv.slice(2);
  if (!transcriptFile || !drilldownUrl || !resumeUrl || !out) throw new Error("Usage: rsa-dryrun.ts <transcript.txt> <drill-down url> <resume url> <out.docx> [remarks]");
  const { readSources } = await import("@/lib/prepdocs/sources");
  const { fetchResume } = await import("@/lib/resume");
  const { contentFromBytes } = await import("@/lib/resume-content");
  const { runLlmChain } = await import("@/lib/llm-router");
  const { normaliseRsa, fitRsa, remarkBullets, rsaFileName, rsaPages, RSA_SCHEMA, RSA_SHAPE_HINT } = await import("@/lib/rsa/model");
  const { RSA_SYSTEM, RSA_INSTRUCTION } = await import("@/lib/rsa/prompt");
  const { renderRsaDocx } = await import("@/lib/rsa/render");

  const transcript = readFileSync(transcriptFile, "utf8");
  const [dd] = await readSources([{ url: drilldownUrl, kind: "drilldown" }], null, []);
  console.log(`drill-down: ${dd.text.length} chars ${dd.error ? `· ${dd.error}` : ""}`);
  const r = await fetchResume(resumeUrl);
  const resume = r.ok ? await contentFromBytes(r.bytes) : `not read: ${r.error}`;
  const resumeText = typeof resume === "string" ? "" : resume.text;
  console.log(`resume: ${resumeText.length} chars ${typeof resume === "string" ? resume : ""}`);
  const names = ["Candidate"];
  const evidence = [transcript, dd.text, remarks];
  const text = `${RSA_INSTRUCTION}\n\n=== KNOWN FACTS ===\nRESULT IN THE SHEET: not updated\n\n=== TEAM REMARKS (highest priority) ===\n${remarks || "(none)"}\n\n=== RSA CALL TRANSCRIPT ===\n${transcript.slice(0, 30_000)}\n\n=== DRILL-DOWN ===\n${dd.text.slice(0, 15_000)}\n\n=== RESUME ===\n${resumeText.slice(0, 6_000)}`;
  const t0 = Date.now();
  const res = await runLlmChain({
    label: "rsa-dryrun",
    chain: process.env.PREP_LLM_CHAIN?.trim() || "gemini:gemini-3.5-flash,gemini:gemini-2.5-flash,openai:gpt-5.4-mini,mistral:codestral-latest",
    system: RSA_SYSTEM,
    schema: RSA_SCHEMA,
    shapeHint: RSA_SHAPE_HINT,
    temperature: 0.1,
    maxOutputTokens: 8000,
    timeoutMs: 150_000,
    accept: (j) => normaliseRsa(j, { names, evidence }) !== null,
    build: () => ({ geminiParts: text, text }),
  });
  if (!res.ok) throw new Error(res.error);
  const n = normaliseRsa(res.json, { names, evidence })!;
  const doc = fitRsa({
    fileName: rsaFileName("Candidate", "Company", "Round", new Date()),
    title: "INTERVIEW SUMMARY ANALYSIS (RSA)",
    subtitle: "Company – Round Interview Feedback",
    header: { candidateName: "(dry run)", companyRole: "Company", process: n.content.process, roundAttended: "Round", result: n.content.result, resumeUrl, callAndPreparedBy: "dry run" },
    content: n.content,
    teamRemarks: remarkBullets(remarks),
  });
  console.log(`model ${res.provider}/${res.model} · ${((Date.now() - t0) / 1000).toFixed(1)} s · ${doc.content.areas.length} areas · ~${rsaPages(doc).toFixed(2)} pages · dropped: ${n.dropped.join(" | ") || "-"}`);
  writeFileSync(out, await renderRsaDocx(doc, "Company"));
  console.log(`saved ${out}`);
}

main().catch((err) => {
  console.error("Dry run failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
