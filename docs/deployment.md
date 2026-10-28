# Deployment (production)

The app runs on **Render** as a Docker web service built from this repository's `main` branch.

| | |
|---|---|
| Live URL | https://psm-placements.onrender.com |
| Sign-in | HTTP Basic: user `psm`. The password is in your local `.env.local` as `RENDER_APP_BASIC_AUTH`, and on Render as `APP_BASIC_AUTH`. |
| Service | `psm-placements`: Docker runtime, free plan, Singapore region |
| Database | Supabase Postgres (Seoul) through the transaction pooler |
| Image | `Dockerfile`: Node 22, Next.js production server, Debian Chromium for PDFs, non-root user, `tini` as PID 1 |

```
GitHub main ──▶ Render (Docker build → health check /api/health → live)
                   │
                   ├─▶ Supabase Postgres (eligible pool)
                   ├─▶ Google Sheets / Drive / BigQuery (service account)
                   └─▶ Gemini → OpenAI → Mistral, GitHub API, LeetCode / Codeforces / CodeChef
```

## Health and readiness

| Endpoint | Sign-in | Returns |
|---|---|---|
| `GET /api/health` | **No** (the only open route) | `{status: "ok", version, startedAt, uptimeSec}`. Always 200 while the app runs. `version` is the deployed commit. |
| `GET /api/health?db=1` | No | Adds `db: "ok"` / `"unavailable"` / `"not-configured"`. The `select 1` is shared by every caller for 30 s. |
| `GET /api/status` | Yes | `ready`, the database round-trip, when each pool product was last refetched, and which integrations are configured (counts and yes/no only, never a key). 503 when the database is unreachable. |
| `GET /api/status?pdf=1` | Yes | Adds a test PDF render (about 15 s on the free plan). |

Render uses `/api/health` as its health check, so a deploy only goes live once the new build answers.

## Calling the app from scripts and agents

The free instance sleeps after 15 minutes without traffic. The first request after that wakes it, which takes about a minute. An agent should do this:

1. **Wait for the app.** Poll `GET /api/health` until it answers 200. Use a 60 s request timeout and a backoff of 5 s, then 10 s, up to 30 s between tries. Give up after 10 minutes.
2. **Check readiness.** Call `GET /api/status` with the sign-in. Continue when `ready` is `true`; if `database.state` is `"unavailable"`, retry later.
3. **Work.** Every other route takes the same sign-in header, `Authorization: Basic base64("psm:<password>")`. The routes are listed in the README ("API routes") and in `docs/architecture.md` §6.

```bash
APP=https://psm-placements.onrender.com
until curl -fsS --max-time 60 "$APP/api/health" >/dev/null; do sleep 10; done
curl -fsS -u "psm:$PASSWORD" "$APP/api/status"
curl -fsS -u "psm:$PASSWORD" -H 'Content-Type: application/json' \
     -d '{"people":[{"userId":"<uuid>"}],"include":["edge2"]}' "$APP/api/pool/lookup"
```

Long screenings are driven from the browser in small parallel requests, and each request finishes within its own time limit. An agent can follow the same pattern, one request per candidate.

## Deploying a change

- **Automatic.** Render redeploys on every push to `main` once it can read the repository. If pushes don't trigger a deploy:
  1. In Render, open Account settings → GitHub and give the Render app access to `PSM_CONSOLIDATION`.
  2. Or start the deploy by hand, as below.
- **By hand.**
  - From the Render dashboard: the service, then Manual Deploy → Deploy latest commit.
  - From the API: `POST https://api.render.com/v1/services/<service id>/deploys` with the Render API key.
- **Rollback.** Render dashboard → Deploys → pick a previous deploy → Rollback.
- **Database changes.** Add `db/migrations/00N_*.sql` and run `npm run db:migrate` locally before deploying. Migrations use `DIRECT_URL`, which Render doesn't need.

## Environment

The values are set in Render → the service → Environment, copied from `.env.local`. Render doesn't receive `DIRECT_URL` (migrations only) or the Render API key.

- **Changing a key.** Edit it in Render, then redeploy (or use "Save, rebuild and deploy").
- **Sheet automation.** `AUTOMATION_TOKEN`, `AUTOMATION_WORKER=on` and `AUTOMATION_SPREADSHEET_IDS` turn it on. The token is also in the coordination sheet's Apps Script properties ([`automation.md`](./automation.md)).
- **Changing the sign-in.** Edit `APP_BASIC_AUTH` (`user:password`, a long random password) in Render, then update `RENDER_APP_BASIC_AUTH` in `.env.local`.

## Keeping it working for a year or more

| Risk | What handles it |
|---|---|
| **Supabase pauses a free project** after 7 days without activity | `.github/workflows/keepalive.yml` calls `/api/health?db=1` every 3 days. It also wakes Render. |
| **GitHub switches off scheduled workflows** after 60 days of repository inactivity | The same workflow re-enables itself on each run, which resets the timer. |
| **The instance sleeps** | Expected. Callers wait for `/api/health`, as above. |
| **Free-plan memory is 512 MB** | One PDF render at a time is fine. A very large run plus a PDF can restart the instance; the browser retries. For heavy daily use, move to a paid instance with 2 GB (Render → Settings → Instance type). |
| **Free-plan hours are shared** (750 a month across the workspace's free services) | A sleeping service uses none. If the workspace runs out, services stop until the next month. |
| **The disk is ephemeral** | The 24 h caches start empty after each deploy or restart. Reports go to Google Drive; the local PDF fallback isn't kept. |
| **Keys expire** | Check the GitHub token's expiry date and the model keys' quotas. `GET /api/status` shows what is configured. |
| **Base image ages** | Node 22 is supported until April 2027. Redeploy with "Clear build cache" every few months to pick up Chromium and OS security fixes. |

## Troubleshooting

| Symptom | Check |
|---|---|
| 401 on every page | The sign-in: user `psm` and the password from `.env.local`. |
| The first request hangs for about a minute | The instance was asleep; it's waking up. |
| `/api/status` returns 503 | The database is paused or unreachable. Open Supabase and restore the project if it is paused, then run the keep-alive workflow. |
| A build fails | Render dashboard → Deploys → the failed deploy's log. The API's `/v1/logs` (type `build`) shows the same log. |
| PDF reports fail | `GET /api/status?pdf=1` shows the Chromium error. |
