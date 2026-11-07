import "server-only";
import { SchemaType, type Schema } from "@google/generative-ai";
import { runLlmChain } from "@/lib/llm-router";

/**
 * The AI summary of a prep call (a phone recording or a Meet transcript): what was discussed, how
 * the candidate did, what to improve, the guidance given and the next actions — in plain English.
 */

export interface CallSummary {
  overview: string;
  keyPoints: string[];
  candidatePerformance: string;
  improvements: string[];
  guidance: string[];
  nextActions: string[];
}

const strArr = { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } } as const;
const SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    overview: { type: SchemaType.STRING },
    keyPoints: strArr,
    candidatePerformance: { type: SchemaType.STRING },
    improvements: strArr,
    guidance: strArr,
    nextActions: strArr,
  },
  required: ["overview", "keyPoints", "candidatePerformance", "improvements", "guidance", "nextActions"],
};

const SYSTEM = `You summarise interview-preparation calls between a NxtWave placement mentor and a candidate.
Write in simple, plain English. Be specific and factual: only what the transcript shows. No emojis.
overview: one or two sentences on what the call covered.
keyPoints: the important discussion points (max 8).
candidatePerformance: how the candidate came across (preparedness, communication, gaps), 2-3 sentences.
improvements: concrete areas the candidate should improve (max 6).
guidance: the guidance the mentor gave (max 6).
nextActions: what should happen next, for the candidate and the mentor (max 5).
The transcript labels speakers "Speaker 1", "Speaker 2"; work out who is the mentor from context. Never invent content.`;

const DEFAULT_CHAIN = "gemini:gemini-3.5-flash,gemini:gemini-2.5-flash,openai:gpt-5.4-mini,mistral:ministral-14b-latest,mistral:ministral-8b-latest";

const list = (v: unknown, max: number) => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, max) : []);

export async function summariseCall(transcript: string, context: { company: string; round: string }): Promise<CallSummary> {
  const res = await runLlmChain({
    system: SYSTEM,
    schema: SCHEMA,
    shapeHint: 'Return ONLY JSON: {"overview","keyPoints":[..],"candidatePerformance","improvements":[..],"guidance":[..],"nextActions":[..]}',
    temperature: 0.2,
    chain: process.env.PREP_SUMMARY_LLM_CHAIN?.trim() || DEFAULT_CHAIN,
    maxOutputTokens: 4000,
    timeoutMs: 120_000,
    label: "call-summary",
    build: (_tier, budget) => {
      const text = `Company: ${context.company}\nRound being prepared: ${context.round || "not stated"}\n\nTRANSCRIPT:\n${transcript.slice(0, Math.max(8000, budget - 2000))}`;
      return { geminiParts: text, text };
    },
    accept: (json) => typeof (json as { overview?: unknown }).overview === "string",
  });
  if (!res.ok) throw new Error(`The summary couldn't be written (${res.error.slice(0, 200)}).`);
  const j = res.json as Record<string, unknown>;
  return {
    overview: String(j.overview ?? "").trim(),
    keyPoints: list(j.keyPoints, 8),
    candidatePerformance: String(j.candidatePerformance ?? "").trim(),
    improvements: list(j.improvements, 6),
    guidance: list(j.guidance, 6),
    nextActions: list(j.nextActions, 5),
  };
}

/** A compact summary for one sheet cell (≤ 1,500 characters). */
export function summaryCell(s: CallSummary): string {
  const parts = [
    s.overview,
    s.candidatePerformance && `Performance: ${s.candidatePerformance}`,
    s.improvements.length ? `Improve: ${s.improvements.join("; ")}` : "",
    s.nextActions.length ? `Next: ${s.nextActions.join("; ")}` : "",
  ].filter(Boolean);
  return parts.join("\n").slice(0, 1500);
}

export const durationText = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m} m ${String(s).padStart(2, "0")} s` : `${s} s`;
};
