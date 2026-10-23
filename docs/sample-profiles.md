# Sample profiles

When a CRM pitches NxtWave to a company, the hiring manager often asks for a few sample profiles.
This feature finds the **strongest of the strong** in one sheet of resumes (thousands of rows),
organised by tech role, and writes two workbooks: one to send to the company and one for the team.
Five or ten profiles per role is enough — one great profile beats ten average ones. Sidebar:
*Company sheets › Sample profiles*; saved runs reopen from the dashboard (*Companies* tab).

**Evidence is limited to three things:** the resume, the candidate's own GitHub code, and their
competitive-programming profiles. Roles come from that evidence, never from the resume's title
or a fixed list of buckets.

## Input (read only)

One Google Sheet, shared with the service account (Viewer). The tab with the resume links is picked
automatically (it can be changed). Columns are recognised by their headers — name, email, mobile,
resume link, and when present GitHub, LeetCode, Codeforces, CodeChef, college, degree, year. The
header row is found, not assumed. With no "Resume" header, the column with the most document links is
used. Repeated rows (same email, then same mobile) are read once. Nothing is written to the sheet.

## The funnel — cheap and strict first

| Stage | Who reaches it | Work | Cost |
|---|---|---|---|
| **Screen** | every row with a resume link | Download the resume (Drive folders are followed), read its text and links: PDF link annotations, URLs in the text, and handles written as "LeetCode: ravi_07". Fingerprint the file. The sheet's GitHub and DSA columns fill only what the resume doesn't link. | no model |
| **DSA** | rows with a GitHub link **and** a coding-profile link | The bar is read platform by platform — Codeforces (batched, 50 handles per call), then LeetCode, then CodeChef (the slowest host, 1 request / 5 s). Reading stops at the first platform that clears the bar. | paced APIs, 24 h cache |
| **GitHub** | rows that clear the bar, or whose only remaining platform is CodeChef | One GraphQL query per account: account type, name, the 60 most recently pushed own non-fork repositories with size and commit count. Missing accounts, organisations and accounts with no real code stop here. | 1 query |
| **Read** | DSA cleared and a real GitHub account | One model read (Gemini → OpenAI → Mistral, `SHOWCASE_LLM_CHAIN`). It returns every project with its technologies, the candidate's own words on what they built, and complexity signals, each quoted. It also returns jobs and internships with dates and company type, education, skills, and the name at the top. Every title, quote, technology and link is checked against the resume text, and anything not found is dropped. A scanned resume is transcribed first. | 1 model call, 24 h cache |
| **Verify** | 2 strong projects in a role (or 1 exceptional one plus experience) | Proves up to 3 flagship projects on GitHub (details below). Also reads the coding platforms the bar skipped and the profiles' owner names. | ~20–45 GitHub REST calls, 24 h cache |
| **Trust** | candidates still in | The trust agent: a second model, leading with a different Gemini model (`SHOWCASE_TRUST_CHAIN`). | 1 model call, 24 h cache |
| **Score** | browser, pure | Roles, gates, score, tiers, top N per role. | none |

Every result is saved in the browser (IndexedDB) the moment it arrives, so a stop or a refresh
loses nothing. **Continue** resumes from where each candidate stopped. Rate limits from GitHub,
Codeforces or the model pause the affected step and retry it. Every row keeps the reason it stopped
where it did, and the internal workbook's *All screened* tab lists them all.

## DSA bar (mandatory for every role, adjustable in the screen)

Default: **Codeforces ≥ 1500 OR CodeChef ≥ 1700** (highest rating), **OR LeetCode contest rating ≥ 1800
with 500+ problems solved** (LeetCode exposes only the current rating). Every route needs at least
**3 rated contests** on that platform, so one lucky contest can't pass.

- Only profiles linked from the resume or the sheet count. A resume that only *says* "600+ LeetCode
  problems" with no link is unverifiable, and the reason is recorded. A handle written in the text
  without a link counts once the profile owner's name matches the candidate.
- A profile whose owner is clearly someone else doesn't count. Owner names come from the LeetCode
  real name or a linked GitHub, the CodeChef page and the Codeforces name.
- A handle that appears on two rows of the sheet counts for nobody.
- Changing the bar re-ranks instantly. Platforms not read yet are read on Continue. A Codeforces
  reading taken under a higher bar is re-read when its rating can now clear.

## Projects: the program caps the model

The model scores each project 0–100 against what a product company hiring at 15+ LPA expects in that
role (85+ exceptional, 70–84 clearly strong, most student projects 40–65). The program then caps it:

| Cap | When |
|---|---|
| 40 | Course / tutorial / clone work. This covers NxtWave course apps (Nxt Trendz, Nxt Watch, Jobby App, Tasty Kitchens, Food Munch, Wikipedia Search …), ccbp.tech links, the model's quoted course words, and a distinctive title that appears on **3+ resumes in the same sheet**. |
| 45 | Common tutorial builds (calculator, weather app, "Netflix clone" …) |
| 55 | Basic depth |
| 60 / 72 / 82 / 90 | Zero / one / two / three verified complexity signals. Signals are quoted from the resume or backed by the code: deployed, real users, scale numbers, architecture, performance, data volume, model evaluation, security, tests / CI, integrations, realtime. |
| 65 | No description of what they built |

A **strong project** is quality ≥ 75 after the caps. An **exceptional project** is ≥ 85.

## GitHub proof

A project's repository is either the resume's own link for it or a repo on the candidate's account
whose name matches the title. Forks never count. The code is inspected: manifests, imports and config
show which technologies it really uses. Every commit is audited: whose it is (login, emails, name) and
whether it carries AI coding-tool signatures. App-generator residue (Lovable / Bolt / v0-style) is
looked for too.

A project is **verified in code** when the repository's code shows the project's stack and all of the
following hold:

- **10+** of the commits are the candidate's own
- at least **50%** of the commits are theirs
- the work spans **3+ days** (not a one-day dump)
- the repo has **10+** source files
- there are no AI-generator traces (a switch can allow them)

Repos that fall short are **weak**: they still count, at a lower weight, but don't pass the gate. The
code also backs resume claims, and backed claims lift the project's cap: CI workflows and tests,
docker-compose / Redis / queues, WebSocket libraries, auth libraries, payment / cloud SDKs, and deploy
config or a homepage.

## Roles

Roles come from the technologies each project names and its code proves:

- Frontend Engineer
- Backend Engineer
- Full Stack Developer — a UI framework plus its own server
- Mobile App Developer — Android / Kotlin, iOS / Swift, Flutter, React Native (React Native is mobile, not web)
- Generative AI Engineer
- AI / ML Engineer
- Data Scientist
- Data Analyst
- Data Engineer
- DevOps / Cloud Engineer
- SDET / QA Automation
- Embedded / IoT Engineer
- Blockchain / Web3 Developer
- Game Developer
- Cybersecurity Engineer
- SDE

Any other role the model names becomes its own tab. Roles that the technology catalogue doesn't model
are proven by file paths and dependencies instead: `.sol` / Hardhat, Unity / Godot projects, `.ino` /
PlatformIO, Airflow / dbt, Terraform / Helm. The model's reading only orders the roles the evidence
shows; it never adds one. A full-stack project also counts toward Frontend and Backend, at 0.85 weight.

A candidate is placed **once**, in the role of their strongest projects, with "also strong for" listing
the others. A switch lists them in every role they qualify for. The **SDE** tab is cross-role: it holds
every qualified candidate whose DSA also clears the higher SDE bar (CF 1700 / CC 1900 / LC 2000 with 700
solved, 5 contests).

## Gates, score, tiers

A role is passed when **all** of these hold:

1. DSA bar.
2. 2 strong projects in the role, or 1 exceptional project plus 3+ months of in-role experience.
3. At least 1 of those strong projects verified in code.
4. Trust not Low (when the trust agent is on).

**Profile score** = the weighted average of three parts, plus an experience bonus, multiplied by trust:

- **Projects 50:** the best project + 0.6 × the second + 0.3 × the third. Each project is weighted by
  its proof: verified 1, weak 0.8, unchecked 0.7, failed 0.6.
- **DSA 20:** the bar scores 40; Codeforces 1900 / CodeChef 2100 / LeetCode 2200 score 100; clearing
  on two platforms adds +10.
- **GitHub engineering 10:** proven projects, code-backed claims and active days.
- **Experience bonus, up to +10 points:** a year of in-role, full-time work at a product company earns
  all of it. Internships count half and IT services less. Experience is a strong bonus, not a
  requirement.
- **Trust multiplier:** 0.6 + 0.4 × trust / 100.

| Tier | Profile score | Also needs |
|---|---|---|
| **Showcase** | ≥ 75 | High trust |
| **Strong** | ≥ 60 | — |
| Not shown | below 60 | — |

**Near misses** are candidates one check short, or below the Strong bar. They get their own internal
tab for a human look.

The company workbook takes the **top 10 per role** (adjustable). **Take out** removes a profile by
hand, and the next one moves up.

## Trust

The score is 100 minus the checks below:

- **Resume belongs to the candidate:** −55 when neither the sheet's email nor its mobile is on the
  resume and the name differs. That alone makes trust Low.
- **GitHub account name differs** from the candidate: −8.
- **AI coding-tool commits** in the proven repos: −6 each, at most −12.
- **The trust agent's flags:** inflated claims, impossible dates, course work passed off as original,
  contradictions with the code or the coding profiles. Each flag must quote words that are actually
  in the resume or the evidence. High −15, medium −8, low −3; a repeat of the same kind −2; at most −45
  in all, so three serious flags make trust Low on their own.

Flags that refute themselves, or that dispute a "solved N+" claim the profiles meet, are set aside.
Bands: **High** ≥ 80, **Medium** ≥ 60, **Low** below 60.

## Outputs

- **Company workbook:**
  - **About tab:** the bar in plain words, the tiers and the count per role.
  - **One tab per role:** the Candidate ID (a stable `NW-XXXXXX` hash of email / mobile; set
    `SHOWCASE_ID_SALT`), tier, profile score and a one-line headline. Then education, DSA numbers,
    and three flagship projects: the resume's own words on what they built, the stack, the quoted
    highlights, "✓ Verified in code — N own commits over D days; code shows …" and the links. Then
    experience, verified skills and "also strong for".
  - **No name, email or phone.** Emails, phone numbers and the candidate's name words are scrubbed
    from every text. Profile links (GitHub / DSA / project) show names on those sites, so a switch
    leaves them out.
- **Internal workbook:**
  - Summary: the rules and the funnel per stage.
  - The same role tabs, plus name, email, mobile, resume link, sheet row, score parts, trust checks
    and every gate.
  - *Near misses*, *Taken out by hand* and *All screened* (every row, its status, the stage it
    stopped at and why).
- A CSV of the current role tab, company or internal.

## Throughput (2,500 rows)

| Stage | Throughput |
|---|---|
| Screen | 12 resumes in parallel, about 10–20 min |
| Codeforces | about 1 min per 1,000 handles |
| LeetCode | 2 profiles / s |
| CodeChef | read only when nothing else clears and the GitHub account is real |
| Read / verify / trust | DSA + GitHub survivors only (typically a few hundred, then fewer) |

One GitHub token gives roughly 250 deep inspections an hour. On the rate limit, the queue waits for
the reset instead of failing candidates. Re-runs, or a second sheet with the same people, reuse
everything cached in the last 24 hours (`.cache/github-inspect/`).

## Files

| Where | What |
|---|---|
| `src/lib/showcase/` | `types`, `parse` (sheet → rows), `roles` (catalogue, course / toy detection), `dsa-rules` (bar, owners, shared handles), `screen`, `dsa`, `github-probe`, `reader`, `verify`, `trust`, `scoring` (pure decision), `pipeline` (what to run next), `export` (workbooks, scrub), `store` (IndexedDB) |
| shared | `src/lib/trust-review.ts` (trust agent core, also used by Academy bucketing), `src/lib/dsa-cache.ts` (24 h DSA cache), `src/lib/resume-folder.ts` |
| routes | `src/app/api/showcase/{screen,dsa,probe,read,verify,trust}/route.ts` |
| UI | `src/components/showcase/{sample-profiles,showcase-results,showcase-rules}.tsx` |
| tests | `scripts/showcase-selftest.ts` (`npx tsx scripts/showcase-selftest.ts`) |
