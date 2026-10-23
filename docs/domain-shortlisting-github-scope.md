# Domain Shortlisting: inspect GitHub for domain-fit candidates or for all candidates

Use **Evidence sources → Inspect GitHub for** to choose whose public repos the deep GitHub inspection reads.

| Choice | Who is inspected | When to use it |
|---|---|---|
| **Domain-fit candidates** (default) | Only candidates who clear the domain-fit bar (55). Best fit first, up to 80. | Normal runs. This is the fastest option and uses the least GitHub budget. |
| **All candidates** | Every candidate with a GitHub link. Domain-fit candidates come first, then everyone else by fit. No cap. | When you want every candidate's GitHub checked, including people whose resume undersells them. |

## What "All candidates" adds

- **Strong on GitHub, not on the resume.** A candidate is flagged when their resume is below the domain-fit bar but their own code clearly proves the domain: a GitHub score of 60 or more, with at least one domain repo. Flagged candidates appear in three places:
  - a note above the results, with **Show them** to list only those candidates;
  - a **Not on resume** badge in the GitHub column;
  - the **GitHub Strength Not On Resume** column in the complete CSV.
- **Proven on GitHub, not on the resume.** This lists, for every inspected candidate, the domain technologies their code proves but their resume never names. It appears in the GitHub tooltip ("+N not on resume") and in the CSV column of the same name.
- **It is a signal, not a gate.** A flagged candidate is not shortlisted automatically, and the GitHub score lifts the rank of domain-fit candidates only, exactly as before. Everything else about the shortlist stays the same.

## GitHub budget

- A deep inspection costs about 20 GitHub calls per candidate, and GitHub allows 5,000 calls an hour per token. For "All candidates", the screen shows a rough worst-case estimate for the sheet; a 2,000-row sheet needs about 8 hours of budget.
- Inspections from the last 24 hours are reused at no cost, unless **Re-inspect GitHub now** is on.
- The run checks the budget every minute. When fewer than 300 calls are left, it **pauses until GitHub's hourly reset** and shows the resume time, instead of marking candidates as failed. A rate-limited candidate is retried after the reset.
- **Stop** works during a pause. Candidates the run didn't reach are marked "Not inspected (run stopped)".

## How a candidate's GitHub check reads in the CSV

| GitHub Check | Meaning |
|---|---|
| Checked | Inspected (or reused from the last 24 h) |
| Not inspected (below domain-fit bar) | Scope was "Domain-fit candidates" and the resume fell below the bar |
| Not inspected (beyond the top-80 cap) | Scope was "Domain-fit candidates" and more than 80 cleared the bar |
| Not inspected (run stopped) | The run was stopped before this GitHub was read |
| No GitHub link in resume / GitHub user not found / No public repos with code / Check failed | As before |

## For developers

- **Selection, cap, estimate and the two signals:** pure functions in `src/lib/domain-scoring.ts`, namely `planGithubInspection`, `githubHoursFor`, `githubStrengthNotOnResume` and `githubTechsNotOnResume`.
- **Rate-limit flag:** `rateLimited` on `GithubInspectResult`, in `src/lib/domain-screen.ts`.
- **Screen:** `src/components/domain-shortlist/domain-shortlist.tsx`, which holds the scope control, the budget gate, the rate-limit retries, the results note and filter, and the CSV columns.
- **Self-test (no network):** `npx tsx scripts/domain-github-scope-selftest.ts`.
