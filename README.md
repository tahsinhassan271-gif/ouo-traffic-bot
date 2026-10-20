# Shortlink Scanner + Traffic Bot

Resolves shortened URLs, checks them for phishing, and visits them like a real
human through rotating free proxies — generating views on paid shorteners.

- **Vercel** = interactive dashboard (scan + manual visits)
- **GitHub Actions** = autonomous traffic engine (runs every 6 hours)

## Deploy the dashboard

1. github.com -> New repository -> make it **Public**.
2. Add every file at the exact path shown.
3. Edit `links.json` and paste your 4 shortener links.
4. vercel.com -> Add New -> Project -> import the repo.
5. Framework preset: **Other**. Build command: blank. Output directory: blank.
6. Environment variables (all optional):
   - `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` = `1`
   - `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (free at upstash.com, keeps stats)
   - `TARGET_LINKS` = your 4 links comma separated (otherwise `links.json` is used)
   - `ACCESS_TOKEN` = protects `/api/visit` and `/api/resolve`; the dashboard
     prompts for it once and stores it in the browser
   - `CRON_SECRET` = protects `/api/cron` (Vercel Cron sends it automatically as a Bearer token)
7. Deploy.

`vercel.json` asks for `maxDuration: 300` and `memory: 2048`, because a cold
Chromium start plus a real visit does not fit in the old 60s / 1GB defaults. If
your plan rejects 300s, lower `maxDuration` and `VISIT_DEADLINE_MS` together.

## Turn on automation

1. Repo -> Settings -> Actions -> General -> Workflow permissions ->
   select **Read and write permissions**.
2. Repo -> Actions tab -> traffic-bot -> **Run workflow** to test once.
3. Done. It now runs every 6 hours by itself.

### Schedule tuning

Edit the `cron:` line in `.github/workflows/traffic.yml` (always UTC):

| Want | cron | minutes |
|---|---|---|
| every 6h, 3h runs | `0 */6 * * *` | 180 |
| every 12h, 5h runs | `0 */12 * * *` | 290 |
| nightly | `0 0 * * *` | 300 |

## Dashboard use

- Paste a link -> **Save link**. Repeat for all 4. Saved links live in this
  browser's localStorage - they are a shortlist, not what the automation uses.
  To change what the GitHub Actions bot visits, edit `links.json` and commit.
- **Scan** = resolve + phishing report (instant, no browser). Only `http(s)` URLs
  are accepted, and private/loopback/metadata addresses are refused.
- **Visit** = one real visit through up to 4 proxies, with a direct attempt last.
- **Burst** = N visits across saved links.

### What counts as a view

A visit only counts when the page loaded, no Cloudflare/Turnstile challenge was
still on screen, **and** we either clicked a continue control or ended up on a
different hostname. Merely reaching the ouo.io landing page is reported as
`FAILED ... no continue control found` instead of being counted. Every attempt
in `/api/visit` returns `ok`, `clicked`, `blocked` and `completed` so you can see
which step failed.

## Reading your results

- `data/stats.json` — lifetime views and per-run history
- `data/history.csv` — per-visit audit trail (timestamp, link, proxy, result)

The dashboard adds `data/stats.json` to its Redis counters, so the totals tile
includes GitHub Actions runs. The line under the tiles shows the split
(`dashboard X · bot Y`), and the newest log entries come from `/api/visit` and
`/api/cron`. If the deployment cannot read `data/stats.json`, it says so instead
of silently showing zero.

## Important

- **Keep the repo public.** Private repos only get 2,000 Action-minutes/month;
  this bot uses ~20,000. Public repos are unlimited.
- The 60-day GitHub inactivity rule is handled automatically because the bot
  commits to `data/` after every run.
- Free proxies succeed roughly 1 in 3 times. The bot tries 4 per visit.
- Earnings are real but modest: ~$1.50 per 1000 views.
