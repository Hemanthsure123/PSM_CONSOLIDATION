# Domain Shortlisting: GitHub inspection

Domain Shortlisting checks each domain-fit candidate's public GitHub. It reads the repositories' code and
dependency files to see which of the domain's technologies the candidate actually uses. Repo names and
READMEs are not trusted on their own.

The code is in:

- `src/lib/github-analysis.ts`: the technology catalogue, file reading, evidence grading and scoring.
- `src/lib/domain-screen.ts`: `inspectDomainGithub`, which turns an analysis into what the table and CSV show.
- `src/lib/github-inspect-cache.ts`: the 24 h cache.

## Who is inspected

GitHub inspection runs after resume screening, and only for candidates who meet both conditions:

- they reached the domain-fit bar (55);
- their resume links a GitHub profile or repo.

The highest domain fit goes first, up to 80 candidates. Six are inspected at a time, each with a 150 s limit.

## What is looked for

The **Mandatory** field and **Domain name — What defines it** are matched against the technology catalogue
(65 technologies). Technologies named in Mandatory are mandatory; those named only in the brief are
good-to-have.

The catalogue covers these languages and stacks:

- **Python and ML:** PyTorch, TensorFlow, scikit-learn, Transformers, Hugging Face, LLMs, NLP, …
- **Web:** React, Node.js / Express, Angular, Vue, Django, FastAPI/Flask, Spring Boot, REST APIs.
- **Mobile:** Android / Kotlin, Flutter, React Native, Swift / iOS.
- **Languages:** Go, Rust, C/C++, PHP (with Laravel), Ruby (with Ruby on Rails), Java, C# / .NET.
- **Data and infrastructure:** SQL, MongoDB, Redis, Kafka, GraphQL, Docker, Kubernetes, CI/CD, cloud,
  Terraform.
- **QA:** Selenium, Playwright, Cypress, API testing, BDD, Appium, performance testing.
- **Data analytics:** Power BI, Tableau, Excel, pandas, data visualisation.

Some names are everyday words in lower case: Go, Swift and C. These count only in two forms:

- as a list item: "Java, Go, Python", "C / C++", "Languages: C";
- capitalised mid-sentence: "services in Go".

So "go-to-market", "let's go", "swift delivery" and "C-suite" never add a technology. "iOS" on its own does
not mean native Swift, because "Flutter apps for Android and iOS" is common wording. "Rails" on its own is
not Ruby on Rails, because "guard-rails" is common LLM wording.

## What is read

The analysis covers up to 8 repositories per candidate. Forks, archived repos, empty repos and the
profile-README repo are skipped. Repos the resume links come first; repos are then ranked by domain words,
language, recency, stars and size.

### Files read per repo

Up to 8 files are read per repo, plus 4 for the languages added later:

- **Dependency files:** requirements / pyproject / Pipfile / environment.yml / setup.py, package.json,
  pom.xml, build.gradle, pubspec.yaml, go.mod, Cargo.toml, composer.json, Gemfile, Package.swift, Podfile,
  vcpkg.json, conanfile.txt.
- **Infrastructure:** Dockerfile, docker-compose and CI workflows.
- **Source files:** entry points first, plus one test file.
- **Other:** one notebook (code cells only) and the README.

### How the files are interpreted

- **Imports** are understood for Python, JS/TS, Java/Kotlin/C#, Dart, Go, Rust, PHP, Ruby, Swift and
  C/C++ (`#include <…>`).
- **Go** `// indirect` dependencies are transitive, so they are not the candidate's choice and are ignored.
- **Ignored as not the candidate's code:**
  - vendored and generated files (node_modules, venv, dist, protobuf output, Rails' schema dump);
  - the platform shells a cross-platform app generates: the ios/, android/, macos/, linux/, windows/ and
    web/ folders next to a pubspec.yaml or package.json, at any depth. Every Flutter app has an
    AppDelegate.swift and a CMakeLists.txt there.
- **Repos over 200 MB** (committed datasets or model weights) are read at the top level only.

## Grading the evidence

| Evidence | Example | Weight |
|---|---|---|
| Imported or called in code | `import torch` in train.py | 1.0 |
| Strong artifact | a committed `.pbix` / `.jmx` | 0.9 |
| Config that is itself the proof | Dockerfile, `main.tf`, `go.mod`, `Cargo.toml`, `*.xcodeproj` | 0.85 |
| Declared dependency | `torch` in requirements.txt | 0.7 (0.35 in a repo with almost no code, 0.25 for a bulk `pip freeze`) |
| A library that depends on it | pytorch-lightning, sidekiq | ≤ 0.6 |
| Mentioned in Docker / CI config | `image: redis:7` | 0.5 |
| Artifact files | `.pt`, `.graphql`, `.rb` | 0.5 |
| Repo topic / README / description | "built with PyTorch" | 0.45 / 0.3, and never enough on its own |

A technology's confidence is its strongest finding, plus 0.15 for each other kind of finding (maximum 1).
It is **proven** at 0.5 or more with non-README evidence.

A repo is **domain-relevant** when two things hold:

- it proves a core technology;
- it is the candidate's own repo, or they committed to it from their account.

Plain languages (Python, JavaScript, Java, Go, Rust, C/C++, PHP, Ruby, HTML/CSS) are core only when the
domain names nothing more specific.

## The score (0–100)

Score = 35 × strength + 25 × coverage + 15 × breadth + 25 × depth.

- **Strength** is the best core technology. With mandatory technologies, half of it is their average.
- **Coverage** is the average of the best 3 core technologies.
- **Breadth** covers every named technology.
- **Depth** is made up of:
  - the number of relevant repos (3 or more counts as full), weighted 60%;
  - how many of them were touched in the last 18 months, weighted 25%;
  - code size, weighted 15%.

  Depth counts only in proportion to real evidence.

Two caps apply:

- A profile with nothing beyond README / topics scores at most 30.
- Each weakly proven mandatory technology lowers the ceiling by 6, 14 or 22.

The GitHub score adds up to +20 to the final rank.

## Commits

- **Own repos:** the latest 100 commits are read.
- **Someone else's repo** (a team, org or course repo the resume links): the candidate's own commits are
  requested (`?author=`), since in a busy repo they may not be among the latest 100. The repo counts only
  if the candidate committed to it.
- **AI-commit signal:** shown in the CSV and tooltip only. It never changes the score.

## What the table and CSV show

| Column | Meaning |
|---|---|
| GitHub Proven Tech | Technologies the code proves |
| **GitHub Evidence** | One line per proven technology: the finding and the repo, e.g. `Redis: github.com/redis/go-redis declared in go.mod (order-service)` |
| **Mandatory Not Proven on GitHub** | Each mandatory technology the code doesn't prove, and why: *no evidence in the inspected repos*, *only named in a README / topics*, or *weak evidence* (with the finding) |
| **Claimed but Not Found on GitHub** | The domain's technologies the resume names that the code doesn't prove. The resume is matched by the same rules as the mandatory check. |
| **GitHub Checked At** | When the inspection ran, and "(reused, 24 h cache)" when it came from the cache |

The GitHub cell's tooltip shows the same lines.

## The 24 h cache

A complete inspection is reused for 24 hours. The cache key is built from:

- the GitHub user;
- the resume's repo links;
- the technologies looked for;
- the analyzer version (`GITHUB_ANALYSIS_VERSION`).

### What is stored

These are stored and reused:

- complete inspections;
- a user that doesn't exist;
- a profile with no public code.

These are **never** stored:

- failures;
- rate-limited or budget-cut (partial) inspections;
- inspections where the commit count couldn't be read.

### How the cache behaves

- **Two layers:** one in memory (bounded) and one on disk (`.cache/github-inspect`, one JSON file per
  entry), so a server restart keeps the cache.
- **Writes:** atomic.
- **Bad entries:** an unreadable or expired entry counts as a miss and is removed.
- **Cleanup:** expired entries are swept every 15 minutes.
- **Duplicate requests:** identical requests running at the same time share one inspection.
- **Disk problems:** a read-only disk degrades to memory-only.

### Controls

- **Re-inspect GitHub now:** a run switch that ignores the cache and inspects everyone afresh. The fresh
  results are still stored.
- `GITHUB_CACHE_TTL_HOURS`: default 24; 0 turns the cache off.
- `GITHUB_CACHE_DIR`: the folder for cached entries.
- **Changing the logic:** bump `GITHUB_ANALYSIS_VERSION` in `github-analysis.ts` whenever scoring, the
  catalogue or what is read changes. Old entries are then never reused.

## Tests

`npx tsx scripts/github-inspection-selftest.ts` runs offline against a mock GitHub. It covers:

- the wording rules;
- the mandatory check;
- every added technology on realistic repos;
- the Flutter / React Native shells;
- team repos and very large repos;
- the guarantee that adding a language never changes what is read or scored for a repo in the original
  languages;
- evidence, gaps and claims;
- every cache rule.
