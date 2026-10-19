import "server-only";
import { Annotation } from "@langchain/langgraph";
import type {
  BucketDecision,
  BucketReview,
  BucketingCandidateInput,
  DomainAnalysis,
  DomainReview,
  DsaResult,
  Extraction,
  FinalDecision,
  FinalReview,
  ProjectEvidenceResult,
  ResumeInfo,
  Review,
  TraceEntry,
} from "@/lib/bucketing/types";

/**
 * Candidate Bucketing graph state. Every agent writes its own keys (last value
 * wins); trace / errors / models accumulate across nodes and parallel branches.
 */

const last = <T>(init: () => T) => Annotation<T>({ reducer: (_prev: T, next: T) => next, default: init });

export const BucketingState = Annotation.Root({
  input: Annotation<BucketingCandidateInput>(),
  resume: last<ResumeInfo | null>(() => null),
  /** Verified resume text (kept in state for the verifiers; never returned to the browser). */
  resumeText: last<string>(() => ""),
  extraction: last<Extraction | null>(() => null),
  domainAnalysis: last<DomainAnalysis | null>(() => null),
  domainReview: last<DomainReview | null>(() => null),
  projectEvidence: last<ProjectEvidenceResult | null>(() => null),
  bucketing: last<BucketDecision | null>(() => null),
  bucketReview: last<BucketReview | null>(() => null),
  dsa: last<DsaResult | null>(() => null),
  dsaReview: last<Review | null>(() => null),
  final: last<FinalDecision | null>(() => null),
  finalReview: last<FinalReview | null>(() => null),
  /** Producer runs per agent (revise loops are bounded by LIMITS.MAX_REVISE_LOOPS). */
  attempts: Annotation<Record<string, number>>({
    reducer: (a: Record<string, number>, b: Record<string, number>) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  trace: Annotation<TraceEntry[]>({ reducer: (a: TraceEntry[], b: TraceEntry[]) => a.concat(b), default: () => [] }),
  errors: Annotation<string[]>({ reducer: (a: string[], b: string[]) => a.concat(b), default: () => [] }),
  models: Annotation<string[]>({ reducer: (a: string[], b: string[]) => a.concat(b), default: () => [] }),
});

export type State = typeof BucketingState.State;
export type Update = typeof BucketingState.Update;
