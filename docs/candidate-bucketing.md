# Candidate Bucketing — how to use it

Candidate Bucketing reads each candidate's resume and puts the candidate in **one of five buckets**: MERN Stack, Python Full Stack, Java Full Stack, Generative AI or Frontend. When a candidate can't be bucketed, it gives the reason. Every result comes with:
- an overall score
- a trust score
- the candidate's stage, for example "MERN TR-2 cleared"

Inside each bucket, TR-2 candidates come first, then TR-1, then Assessment.

## In the dashboard

1. Open **Dashboard → Candidate Bucketing**.
2. **Upload the sheet's CSV export**, or paste its rows together with the header row. The parser recognises these columns:

   | Column | What it gives |
   |---|---|
   | Number / Mobile | Candidate ID. Parent and guardian columns are ignored. |
   | Resume | The resume link |
   | Name | Candidate name |
   | `TR 1 Status` / `TR 2 Status` (value "Cleared") | The stage. A `Stage` column also works. |
   | Track | The TR-2 track: MERN / Python FS / Java FS / GenAI / AI-ML / Data Analytics |
   | GitHub, LeetCode, CodeChef, Codeforces | Optional profile links |

   - Rows with no stage count as **Assessment cleared**. You can change this default.
   - Rows with no resume link are listed as *No resume link* and are never sent to the models.
3. Name the run and click **Start bucketing**. Four candidates run in parallel, TR-2 first.
4. The run saves as it goes, so you can close the tab. Reopen the run from the dashboard and use **Resume**, **Re-run** (for candidates whose evidence was unavailable) or **Add batch**.
5. Downloads:
   - **All (CSV)**: every candidate, ranked inside each bucket
   - **This list (CSV)**: one bucket, or the *Not bucketed* list with its reasons

Click any row to see the evidence behind the decision:
- the projects and their GitHub repos
- the commit audit, including any offending commits
- what the code actually uses
- the demo check
- the domain scores, with the resume quotes behind them
- DSA
- each verifier's verdict
- the agent trace

## Rules applied

- **Project validity.** A project counts only when its own section of the resume links a GitHub repo. That repo must:
  - exist and be public;
  - have every non-merge commit by the candidate. A commit by anyone else invalidates the project, and so does a commit with an AI coding-tool signature (Claude Code, Cursor, Copilot, Codex, Devin, aider, Antigravity and others);
  - contain no AI-tool files (`CLAUDE.md`, `.cursorrules`, `.agents/rules/`, and similar).

  A clean audit means *no AI or foreign signatures were found*. It does not prove the code was written by hand: autocomplete tools leave no trace.
- **Project tiers.**
  - Tier A: valid GitHub repo and a demo that loads.
  - Tier B: valid GitHub repo.
  - Tier C: demo only. It can support a bucket, but it can't validate a resume.
- **Validated resume.** A resume is validated only with at least one Tier A or Tier B project.
- **Choosing the bucket.** The bucket comes from what the code proves (dependencies, imports, config), never from the resume's wording. The bucket rules are listed on the setup screen.
- **TR-2 track.** For a TR-2 candidate in MERN, Python FS, Java FS or GenAI, that track's bucket wins if a verified project or internship backs it. Otherwise the resume's bucket is used and the candidate is flagged *TRACK_MISMATCH*. AI-ML and Data Analytics have no bucket of their own.
- **Domain scores** use only projects, internships and open-source work. Skills lists and summaries are ignored.
- **DSA.** Codeforces counts more than CodeChef, which counts more than LeetCode.
- **Trust** measures how much of the decision was actually verified, and how far each verifier agreed with its agent. A model's own confidence is never used.
  - When evidence is missing (GitHub rate limit, model outage), the candidate is marked *Re-run needed* and gets no trust score. It is never rejected for this.

You can tune the weights, caps and limits in `src/lib/bucketing/config.ts`.

## Large batches from the terminal

```bash
npx tsx scripts/bucketing-run.ts "<sheet>.csv" "<output folder>" 4
```

- It can be resumed: run it again and it skips candidates that are already done, and re-runs the *Re-run needed* rows.
- When the hourly GitHub budget runs low, it pauses instead of failing candidates.
- It writes these files to the output folder:
  - `summary.md`
  - `complete.csv`
  - `bucket-*.csv` (one per bucket)
  - `not-bucketed.csv`
  - `open-in-dashboard.json`: load this with **Candidate Bucketing → Open a results file**

Checks that need no network: `npx tsx scripts/bucketing-selftest.ts`.
