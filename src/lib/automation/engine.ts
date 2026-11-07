import "server-only";
import { env } from "@/lib/env";
import type { EngineStamp } from "@/lib/automation/types";

export type { EngineStamp };

/**
 * What screened a job: stamped on its plan and in its event log, so a result can always be
 * traced to the code, settings and models that produced it, and two runs can be compared.
 * Bump ENGINE_VERSION with any change to how candidates are screened, judged or ranked.
 */
export const ENGINE_VERSION = "2026.11.08";

/** Model calls / downloads in flight: AUTOMATION_CONCURRENCY (default 6, max 10). */
export const screeningWidth = () => Math.min(10, Math.max(1, Number(process.env.AUTOMATION_CONCURRENCY) || 6));

/** Chain for second opinions: the first configured OpenAI model ("" = no OpenAI keys / switched off). */
export function secondOpinionChain(): string {
  if (/^(0|off|false|no)$/i.test((process.env.AUTOMATION_SECOND_OPINION ?? "").trim())) return "";
  const model = env.openai.models[0];
  return env.openai.apiKeys.length && model ? `openai:${model}` : "";
}

export function engineStamp(): EngineStamp {
  return {
    version: ENGINE_VERSION,
    models: env.gemini.model,
    ioParallel: screeningWidth(),
    cpuParallel: Math.min(4, Math.max(1, Number(process.env.AUTOMATION_CPU_PARALLEL) || 1)),
    secondOpinion: secondOpinionChain() || "off",
  };
}

export const describeEngine = (e: EngineStamp) =>
  `Engine ${e.version}: model ${e.models}; ${e.ioParallel} resumes in flight, ${e.cpuParallel} file read at a time; second opinion ${e.secondOpinion}.`;
