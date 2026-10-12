import { rankEvaluations } from "@/lib/assignment-scoring";
import type { AssignmentSpec, CandidateEvaluation, CandidateInput, CriterionStatus } from "@/lib/assignment-types";
import { formatDay } from "@/lib/utils";

const STATUS_LABEL: Record<CriterionStatus, string> = {
  met: "Met",
  partial: "Partial",
  not_met: "Not met",
  unverified: "Unverified",
};

const join = (items: string[]) => items.filter(Boolean).join(" | ");

/**
 * One CSV row per candidate (ranked best first, pending last) with every score,
 * one column per enabled criterion, the repository facts and the remarks.
 */
export function buildAssignmentCsv(
  spec: AssignmentSpec,
  candidates: CandidateInput[],
  results: Record<string, CandidateEvaluation>,
): { headers: string[]; rows: Record<string, string>[] } {
  const criteria = spec.criteria.filter((c) => c.enabled);
  const critHeader = (id: string, title: string, type: string) =>
    `${id} · ${title} (${type === "mandatory" ? "Mandatory" : type === "good" ? "Good to have" : "Excellence"})`;

  const headers = [
    "Rank",
    "Mobile (UUID)",
    "GitHub Link",
    "Resolved Repo",
    "Selection Status",
    "AI Review",
    "Overall Score",
    "Shortlist Chance %",
    "Mandatory Met",
    "Mandatory Score",
    "Good-to-have Score",
    "Excellence Score",
    "Architecture Score",
    "Code Quality Score",
    ...criteria.map((c) => critHeader(c.id, c.title, c.type)),
    "Implemented Features",
    "Missing Features",
    "Restriction Violations",
    "Red Flags",
    "Possible Copy Of",
    "AI Review Reasons",
    "AI-attributed Commits",
    "AI Tool / Commit Evidence",
    "AI-style Comments & Emojis",
    "Emojis in Comments/Logs",
    "Architecture Pattern",
    "Architecture Strengths",
    "Architecture Issues",
    "Code Quality Notes",
    "Commits",
    "First Commit",
    "Last Commit",
    "Commits After Deadline",
    "Active Days",
    "Commit Span (days)",
    "Branches",
    "Generic Commit Messages",
    "Web Uploads",
    "Other Authors",
    "AI Authorship",
    "Tests Present",
    "README Present",
    "Source Lines",
    "Source Files",
    "Test Files",
    "Languages",
    "Largest Files",
    "Live Link",
    "Live Link Status",
    "Files Analysed",
    "Remarks",
    "Model Used",
    "Time Taken (s)",
    "Error",
  ];

  const evaluated = rankEvaluations(candidates.map((c) => results[c.id]).filter((r): r is CandidateEvaluation => Boolean(r)));
  const rows: Record<string, string>[] = evaluated.map((e, i) => {
    const byId = new Map(e.criteria.map((r) => [r.id, r]));
    const scored = e.status !== "Error" && e.status !== "Invalid Submission";
    const repo = e.repo;
    const row: Record<string, string> = {
      Rank: scored ? String(i + 1) : "",
      "Mobile (UUID)": e.id,
      "GitHub Link": e.githubUrl,
      "Resolved Repo": repo?.resolvedRepo ?? "",
      "Selection Status": e.status,
      "AI Review":
        e.aiReview?.verdict === "ai-generated"
          ? "AI Generated – Review Manually"
          : e.aiReview?.verdict === "possible"
            ? "Possible AI assistance"
            : e.aiReview
              ? "No AI signals"
              : "",
      "Overall Score": scored ? String(e.overall) : "",
      "Shortlist Chance %": scored ? String(e.chance) : "0",
      "Mandatory Met": scored ? `${e.mandatoryMet}/${e.mandatoryTotal}` : "",
      "Mandatory Score": scored ? String(e.scores.mandatory) : "",
      "Good-to-have Score": scored ? String(e.scores.good) : "",
      "Excellence Score": scored ? String(e.scores.excellence) : "",
      "Architecture Score": scored ? String(e.scores.architecture) : "",
      "Code Quality Score": scored ? String(e.scores.codeQuality) : "",
      "Implemented Features": join(e.implementedFeatures),
      "Missing Features": join(e.missingFeatures),
      "Restriction Violations": join(e.restrictionViolations),
      "Red Flags": join(e.redFlags),
      "Possible Copy Of": join(e.similarity.map((s) => `${s.with} (${Math.round(s.ratio * 100)}% — ${s.reason})`)),
      "AI Review Reasons": join(e.aiReview?.reasons ?? []),
      "AI-attributed Commits": e.aiReview ? String(e.aiReview.aiCommits) : "",
      "AI Tool / Commit Evidence": join(e.aiReview?.commitEvidence ?? []),
      "AI-style Comments & Emojis": join(e.aiReview?.commentEvidence ?? []),
      "Emojis in Comments/Logs": e.aiReview ? String(e.aiReview.emojiCount) : "",
      "Architecture Pattern": e.architecture.pattern,
      "Architecture Strengths": join(e.architecture.strengths),
      "Architecture Issues": join(e.architecture.issues),
      "Code Quality Notes": e.codeQuality.notes,
      Commits: repo?.commits ? String(repo.commits) : "",
      "First Commit": repo?.firstCommit ? formatDay(repo.firstCommit, "iso") : "",
      "Last Commit": repo?.lastCommit ? formatDay(repo.lastCommit, "iso") : "",
      "Commits After Deadline": repo?.commitsAfterDeadline ? String(repo.commitsAfterDeadline) : repo?.commits ? "0" : "",
      "Active Days": repo?.activeDays != null ? String(repo.activeDays) : "",
      "Commit Span (days)": repo?.spanDays != null ? String(repo.spanDays) : "",
      Branches: repo?.branches ? String(repo.branches) : "",
      "Generic Commit Messages": repo?.commitsAnalysed ? `${repo.genericMessages ?? 0}/${repo.commitsAnalysed}` : "",
      "Web Uploads": repo?.webUploads ? String(repo.webUploads) : repo?.commitsAnalysed ? "0" : "",
      "Other Authors": join(repo?.otherAuthors ?? []),
      "AI Authorship": repo?.aiLikelihood && repo.aiLikelihood !== "unknown" ? repo.aiLikelihood : "",
      "Tests Present": repo?.filesTotal ? (repo.hasTests ? "Yes" : "No") : "",
      "README Present": repo?.filesTotal ? (repo.hasReadme ? "Yes" : "No") : "",
      "Source Lines": repo?.sourceLines != null ? String(repo.sourceLines) : "",
      "Source Files": repo?.sourceFiles != null ? String(repo.sourceFiles) : "",
      "Test Files": repo?.testFiles != null ? String(repo.testFiles) : "",
      Languages: repo?.languages ?? "",
      "Largest Files": join(repo?.largestFiles ?? []),
      "Live Link": repo?.liveUrl ?? "",
      "Live Link Status": repo?.liveStatus && repo.liveStatus !== "none" ? repo.liveStatus : "",
      "Files Analysed": repo?.filesTotal ? `${repo.filesInPrompt}/${repo.filesTotal}` : "",
      Remarks: e.remarks,
      "Model Used": e.model,
      "Time Taken (s)": e.durationMs ? String(Math.round(e.durationMs / 1000)) : "",
      Error: e.error,
    };
    for (const c of criteria) {
      const r = byId.get(c.id);
      row[critHeader(c.id, c.title, c.type)] = r
        ? `${STATUS_LABEL[r.status]} ${r.score}/10${r.files.length ? ` — ${r.files.join(", ")}` : ""}${r.evidence ? ` — ${r.evidence}` : ""}`
        : "";
    }
    return row;
  });

  for (const c of candidates) {
    if (results[c.id]) continue;
    rows.push({ "Mobile (UUID)": c.id, "GitHub Link": c.githubUrl, "Selection Status": "Pending" });
  }
  return { headers, rows };
}
