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

`vercel.json` asks for `memory: 3008` and `maxDuration: 300` because a cold
Chromium start plus a real visit does not fit in the old 60s / 1GB budget (a
smaller instance gets the browser OOM-killed). If you lower `maxDuration`, lower
`VISIT_DEADLINE_MS` too. `includeFiles` must stay a single glob string - Vercel
rejects an array with "includeFiles should be string" and the whole deployment
fails before building.

### Chromium on Vercel

`@sparticuz/chromium` only unpacks its Amazon Linux shared libraries when
`AWS_EXECUTION_ENV` / `AWS_LAMBDA_JS_RUNTIME` look like a Lambda runtime. Vercel
does not expose those, so by default the browser dies with exit code 127
(`libnss3.so: cannot open shared object file`) and Playwright reports the useless
"Target page, context or browser has been closed". `lib/browser.js` now unpacks
`bin/al2023.tar.br` itself and prepends `/tmp/al2023/lib` to `LD_LIBRARY_PATH`
before launching.

`/api/warm` reports the outcome plus the resolved paths, so it is the fastest way
to check a deployment:

```json
{"ok": true, "ms": 812, "runtime": {"mode": "serverless", "executablePath": "/tmp/chromium",
 "libsPath": "/tmp/al2023/lib", "libsPresent": true, "ldLibraryPath": "/tmp/al2023/lib"}}
```

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
still on screen, **and the browser actually left the shortener** - the final
hostname must differ from the link you opened and must not be an `ouo.*` host.
Clicking a button is not proof of anything, so it no longer counts on its own.

Every attempt returns `ok`, `clicked`, `clicks`, `blocked`, `completed`,
`startHost`, `finalHost` and a `steps` trace (which selector was clicked and
where it navigated), so a miss tells you exactly where the flow stopped:
`challenge not cleared`, `no enabled continue control`, or
`never left ouo.io after N click(s)`.

## Reading your results

- `data/stats.json` — lifetime views and per-run history
- `data/history.csv` — per-visit audit trail (timestamp, link, proxy, result)

The dashboard adds the GitHub Actions totals to its Redis counters, so the totals
tile includes bot runs. Because a deployment is a snapshot, `/api/stats` reads
`data/stats.json` from the bundle when present and otherwise fetches the committed
file from the public repo (`BOT_STATS_REPO` / `BOT_STATS_BRANCH` override the
default), cached for 60s. The line under the tiles shows the split and where the
number came from, and the newest log entries come from `/api/visit` and
`/api/cron`.

## Important

- **Keep the repo public.** Private repos only get 2,000 Action-minutes/month;
  this bot uses ~20,000. Public repos are unlimited.
- The 60-day GitHub inactivity rule is handled automatically because the bot
  commits to `data/` after every run.
- Free proxies are ~1% alive: a typical run finds 5-35 usable exits out of 1000
  probed. The bot tries up to 4 per visit and reuses the ones that have already
  completed a visit before drawing new ones.
- **Why the dashboard can show views while the shortener shows none.** Local
  "views" only prove this script got past a page; the shortener pays only for
  traffic its own fraud filter accepts. Free-proxy exit nodes are datacenter
  and abused IP ranges that shorteners, ad networks and Cloudflare all score as
  invalid, so the impressions they generate are discarded server-side. The
  `completed` flag now requires actually reaching the destination, which is why
  honest numbers will be much lower than the old ones. Getting past that filter
  is a shortener anti-fraud problem, not a bug in this script.
- Earnings are modest at best: ~$1.50 per 1000 *valid* views.
