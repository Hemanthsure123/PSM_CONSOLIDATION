# Zaggle (ZagMoney) · SDE 1 Backend — screening

A screen built for one JD: **Zaggle (ZagMoney), SDE 1 – Backend Engineer, Bengaluru.** Open it from the dashboard with **Zaggle · SDE 1 Backend**.

## What it checks (from the JD and the client's rubric)

**Mandatory.** All seven are needed for 100%:

| # | Requirement | How it is checked | Points |
|---|---|---|---|
| 1 | A backend language: Java, Kotlin, Go, Python, Node.js or C# | Exact resume words in Skills / Projects / Experience | 15 |
| 2 | Data Structures & Algorithms | Same | 15 |
| 3 | APIs | Same | 15 |
| 4 | SQL (a relational database; NoSQL-only doesn't count) | Same | 15 |
| 5 | 1 year of relevant full-time backend / software experience | Summed across companies with overlaps counted once (6 + 3 + 3 = 12) | 20 |
| 6 | Experience at a software product company | At least one counted job at a product company | 10 |
| 7 | No consulting / IT services background | No job at an IT services, consulting or staffing firm | 10 |

**Good to have.** Each one found raises the score above 100%: +2 when it's shown in a project or job, +1 when it's only in the skills list. The items are Java, Kotlin, Spring Boot, background jobs, event-driven systems, event consumers, retries, third-party / payment / banking integrations, debugging, RCA, data modelling, backend architecture, clean code, reliable services, end-to-end ownership, fintech, payments, credit products, rewards, production issues and system design.

## How the experience is worked out

- The model lists every job: company, title, type, the dates exactly as written, what the work was and what kind of company it is.
- The program then reads the dates from the resume's own words. Months are counted LinkedIn-style, with both ends included:
  - Jan–Dec 2025 = 12 months;
  - "Present" ends at the screening month.
- **Counts:** full-time and contract jobs whose work is backend, full stack or general software engineering.
- **Doesn't count:**
  - internships and apprenticeships;
  - part-time and freelance work;
  - frontend-only, mobile-only, QA, data, DevOps and non-software roles.
  - Rule switches can change the internship and frontend/mobile defaults.
- **Overlapping jobs are counted once.** Jan–Dec 2025 plus Jun 2025–Mar 2026 = 15 months, not 22.
- **Default window:** 12–23 months. That's "1 year": at least a year, under two.
- **Employers on the known list** (TCS, Infosys, Wipro, HCLTech, Cognizant, Accenture, Capgemini, LTIMindtree, Deloitte, EY, KPMG, PwC and others) are always IT services / consulting.
- **Other employers** are classified from the resume:
  - a firm that builds for clients counts as IT services;
  - one that runs its own product counts as a product company;
  - "unclear" sends the candidate to **Review**.

## Statuses

| Status | Meaning |
|---|---|
| **Shortlisted** | Every mandatory requirement met |
| **Review – Check Manually** | Would qualify, but the product company is unclear or the dates are approximate (a year only, a duration only, or the model's reading) |
| **Not Shortlisted** | A mandatory requirement is missing; the reasons are listed |
| **No Relevant Full-time Experience** | No counted job at all (freshers, internships only) |
| **Invalid – Not a Resume** | A photo, certificate or similar |
| **Error** | Retried automatically; "Re-run failed" retries again |

## Using it

1. Name the run, then paste the mobile and resume columns, batches of up to a few thousand rows at a time.
2. Click **Start screening**. Add later batches from the results page.
3. Download the **Shortlisted**, **Review** or **Complete ranking** CSV.
4. Rule changes re-rank everyone instantly, with no re-reading. The rules are the experience window, counting internships, counting frontend/mobile roles, IT-services internships, and top N.

**Models:** Gemini first, OpenAI when Gemini is rate-limited, then Mistral (override with `ZAGGLE_LLM_CHAIN`). Self-test: `npx tsx scripts/zaggle-selftest.ts`.
