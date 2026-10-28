# Domain Shortlisting: the results CSVs, Signals and trust rules

A run gives you two CSVs, both built from the same ranked outcomes:

- **Shortlist CSV:** only the shortlisted candidates, best first.
- **Complete CSV:** every row of the sheet. It holds:
  - shortlisted candidates;
  - candidates who were not shortlisted, with the reason;
  - links that weren't resumes;
  - resumes that couldn't be evaluated;
  - rows a Stop left unread.

## Columns

A column is included only when the run measured what it reports. A blank cell means "unknown", never 0.

| Group | Columns | Included when |
|---|---|---|
| Outcome | Rank, Name, Status, Not Shortlisted Because, Priority, Rank Score, Domain, Domain Score, Resume Core Skills | Always |
| DSA | DSA Score; LeetCode / Codeforces / CodeChef Solved, Contests Participated and Rating; Total Solved, Total Contests, Codeforces Max Rating, CodeChef Highest Rating; the three profile URLs; DSA Notes | DSA was screened (the DSA toggle or a DSA gate) |
| GitHub | GitHub Check, GitHub Fit Score, GitHub Domain Repos, GitHub Proven Tech, GitHub Evidence, Mandatory Not Proven on GitHub, Claimed but Not Found on GitHub, GitHub Top Repos, GitHub Commits (2y), Last Domain Commit, Last Domain Commit Repo, Commit Email Linked To Profile, GitHub AI-Commit Signal, GitHub AI-Commit Detail, GitHub Notes, GitHub Checked At, GitHub Profile, GitHub Account Is Theirs, Proven on GitHub Not on Resume, GitHub Strength Not On Resume, GitHub Score Used in Rank | GitHub was inspected. The score, repo and commit columns appear only when GitHub counts in the rank or a commits gate is set. The three Last Domain Commit columns appear only with that lookup. |
| Code review | Project Review Score, Project Review, Project Features (files), Requirements Proven in Code, Requirements Not Shown, Project Concerns | A deep project review ran for someone |
| Requirements | Meets Mandatory | Mandatory requirements were set |
| | Has Domain Experience, Domain Experience | Always |
| Presentation | Resume Presentation Score, Resume Presentation Notes | Presentation was graded |
| From the sheet | Placed Company, Package (LPA), Assessment Report, TR-1 / TR-2 Panelist, Panelist LinkedIn, Recording | That column was mapped **and** has values |
| Internal | Resume, Matched In Pool By, Internal Standing, Internal Stage, Internal Product | Always. Internal Standing reads "External" when the eligible pool was looked up and the candidate isn't in it. It reads "Not checked" when no phone or user ID column was mapped. |
| Signals | Signals | Always |
| Audit | Scored By, Phone, User ID | Complete CSV only |

**Multi-value cells** are one item per line: Signals, GitHub Evidence, Top Repos and the review cells. Excel and Google Sheets keep these lines inside one cell.

## Signals

Signals explain, one bullet per line, why the candidate is in this row. They are built from the same numbers the ranking used, so they always match the order:

- **Where they landed:** shortlisted at rank N of M, or why not, with the priority.
- **Rank score:** how it is made, for example `Rank score 96 = domain fit 82 + GitHub +14`. For internally assessed candidates, a note says the internal stage orders them first.
- **Internal assessment:** the standing, stage and product, and how the candidate was matched. Otherwise "External".
- **Domain fit:** the score and the evidence behind it, plus up to two quotes from the resume with their source. If the score was lowered, the line says what the model said and why.
- **Resume:** skills shown in projects and experience; whether every mandatory requirement is met; the domain experience.
- **GitHub:** the score and rank points, domain repos, commits and the technologies the code proves. It also notes:
  - an account that isn't theirs;
  - the code review;
  - mandatory items not proven;
  - claims not found in the code;
  - strength the resume doesn't show;
  - the AI-commit signal.
- **DSA:** the score, rank points and each platform's solved count, contests and rating.
- **Presentation:** the score and notes.

## Trust rules

### Resume Core Skills and Domain Score come from evidence only

The model reads the resume, but its answer is checked against the resume's **evidence text**. That text is the projects, internships and jobs, certifications, and achievements (hackathons, coding contests, competitions, research, open source). The Skills list and the profile summary are removed first.

- **Core skills:** each one needs an exact quote from that text showing the skill used. A skill without a matching quote is dropped.
- **Domain score:** the model must quote the evidence behind it. The program then caps the score:

| The quotes that hold up | Highest score |
|---|---|
| None, or every skill named is only in the Skills list / summary | 35 (below every shortlisting bar) |
| Certifications only | 50 (below the 55 bar) |
| One piece of evidence | 79 (80+ needs two) |
| Two or more | The model's score |

A lowered score shows a `*` in the results table, with the reason on hover. The Signals line gives the model's original number and the reason.

### The GitHub account must be theirs

The inspection reads the account's display name and compares it with the candidate's name:

- **Match:** the display name shares a name word with the candidate, or the login contains one.
- **Mismatch:** the account shows a different full name, for example a tutorial author's repo linked on the resume.
- **Unclear:** there's no display name, or it's a handle. This is treated as theirs.

A mismatched account is still shown and flagged. It does not count:

- it adds 0 rank points;
- it is left off the PDF card;
- it can't raise a "strong GitHub, not on resume" flag;
- its commits can't pass a commits gate.

### The order is complete and stable

The shortlist is ordered by these keys, in turn:

1. Priority group (internally assessed with a good resume, then assessed with an average resume, then external with a good resume).
2. The internal stage (TR-2 → TR-1 → assessment).
3. The rank score.
4. Ties are broken by domain fit, then GitHub evidence, then DSA score, then the number of skills proven, then the name.

Two runs on the same data always give the same order.

## For developers

| What | Where |
|---|---|
| Grounding (quotes, caps) and the identity check | `src/lib/domain-evidence.ts` |
| Rank parts, order and tie-breaks | `rankParts`, `compareShortlist` in `src/lib/domain-scoring.ts` |
| Signals | `src/lib/domain-signals.ts` |
| CSV columns and rows | `src/lib/domain-csv.ts` (pure) |
| Self-test | `npx tsx scripts/domain-csv-selftest.ts` |
