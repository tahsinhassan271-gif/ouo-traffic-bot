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
   - `TARGET_LINKS` = your 4 links comma separated
7. Deploy.

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

- Paste a link -> **Save link**. Repeat for all 4.
- **Scan** = resolve + phishing report (instant, no browser).
- **Visit** = one real visit through a random proxy.
- **Burst** = N visits across saved links.

## Reading your results

- `data/stats.json` — lifetime views and per-run history
- `data/history.csv` — per-visit audit trail (timestamp, link, proxy, result)

## Important

- **Keep the repo public.** Private repos only get 2,000 Action-minutes/month;
  this bot uses ~20,000. Public repos are unlimited.
- The 60-day GitHub inactivity rule is handled automatically because the bot
  commits to `data/` after every run.
- Free proxies succeed roughly 1 in 3 times. The bot tries 4 per visit.
- Earnings are real but modest: ~$1.50 per 1000 views.
