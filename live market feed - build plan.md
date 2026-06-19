# Live Market Feed — build plan (for /goal execution)

Authored 2026-06-18. Self-contained: the executing session has none of the conversation
context that produced this. Read it top to bottom before touching anything.

Base folder for everything below (the "feed folder"):
`C:\Users\JadNaitali\OneDrive - Foodtastic Inc\TDV MCP\Knowledge Base\Market briefs\`

---

## 1. Mission

Replace the Windows desktop toast alerts with a **live HTML market feed** — a single
always-on web page that streams market events (company X posts, watchlist headlines, SEC
filings, gauge flips, big moves) in reverse chronological order, with a sentiment/analysis
layer on top, hosted on the public internet so it works even when the laptop is closed.

The feed is **100% deterministic data — no LLM, no Anthropic API, no recurring cost.** It runs
in the cloud on GitHub Actions (free) and is served by GitHub Pages (free). The only thing that
ever costs Jad's Claude tokens is the optional prose "market read," which stays **on-demand only**
(run `morning brief` / `evening recap` in a session) and is explicitly out of scope for the cloud
cron.

## 2. Hard cost rule (do not violate)

- **No Anthropic API calls anywhere in the cron path.** The feed must build with `node` and free
  public HTTP feeds only. If you find yourself reaching for an API key, you've gone off-plan.
- GitHub Actions minutes and GitHub Pages are free for public repos. Keep the repo public
  (Jad has explicitly accepted that the feed and watchlist are publicly reachable — privacy is
  a non-issue here, do not add auth or gating).

## 3. AUTHORIZED OVERRIDE — read before the safety reflex kicks in

The project `CLAUDE.md` says "never download or install software, no cloning repos, no npm install."
**Jad explicitly authorized, on 2026-06-18,** publishing this project to a GitHub repo on his own
account and using GitHub Actions + GitHub Pages to host the feed. That rule is about not pulling
third-party software into the local trust model. This is the opposite direction — pushing his own
code to his own account — and the cloud runner uses **preinstalled Node with zero `npm install`**
(every script here is dependency-free, Node built-ins + global `fetch` only). Proceed without
re-litigating this. Do **not** run any local installer.

## 4. What already exists (reuse, do not rebuild)

All in the feed folder:

- `fetch-feeds.js` — pulls every free feed (Yahoo prices, Google/Yahoo news RSS, Reddit RSS,
  StockTwits, X syndication, CNN + crypto Fear & Greed gauges, calendars, themes). Flags it
  accepts: `--light --symbols-file <path> --runtype intraday --window-hours N --out <path>`.
  Zero dependencies.
- `intraday-watch.js` — the event detector. `node intraday-watch.js --once` does one poll:
  runs `fetch-feeds.js --light` (writing `Briefs/<today>/intraday raw.json`), diffs against
  `intraday state.json`, and prints one line per material event to stdout. Event line grammar
  (already implemented):
  `WATCHER-READY …` · `MOVE <SYM> <pct>% · <label>` · `POST <SYM> @<handle> <H:MM ET> | <text>`
  · `NEWS <SYM> <src> <H:MM ET> | <title>` · `THEME <theme> <H:MM ET> | <title>`
  · `FILING <SYM> <type> <H:MM ET> | <form> <items>` · `GAUGE <name> <old> -> <new> (<score>)`
  · `WATCHER-SLEEPING <until>` (off-hours, no-op) · `WATCHER-DEGRADED <reason>`.
  First run **primes** (records baseline, emits no events) — expected, not a bug.
- `regime engine.js` — macro risk-on/risk-off voters → one regime read + drivers. Writes
  `regime state.json`. Run it to get the current read.
- `symbol map.json` — the watchlist + routing table, with `section` per name (trading / macro /
  crypto) and a `themes` block. In the cloud there is no TradingView, so the feed uses this cached
  file as-is (this is already the documented fallback). Commit the current version.
- `intraday-watch.json` — config (poll cadence, market-hours gate, `movePctThreshold` currently
  `null` = price-move alerts off until Jad sets a number — **do not invent one**).
- `sentiment history.csv` — the brief's running history (leave its schema alone).
- `brief-template.html` — the existing one-pager. **Match its visual language** (embedded Geist
  font, refined-fintech look — see the `brief-design-direction` memory; dark-dashboard and
  broadsheet directions were already rejected, do not reopen them).

## 5. What to build (keep it minimal — no speculative config, no refactoring adjacent code)

### 5a. `build feed data.js` (new, at feed-folder root)
The single orchestrator the cron runs. Steps:
1. `node intraday-watch.js --once`, capture stdout lines.
2. Parse the event lines into structured objects `{ time, type, symbol, section, text, url? }`.
   Append to a rolling `docs/feed-events.json` (dedup by a stable hash of the line; keep a rolling
   window — suggest last 3 trading days, but if window size matters to Jad, ask rather than guess).
3. Read the `Briefs/<today>/intraday raw.json` that step 1 just wrote (no second fetch) for the
   snapshot: per-symbol % change, StockTwits bull/bear + sample size + velocity, unique news count,
   latest post/filing, the two Fear & Greed gauges, theme headlines.
4. `node regime engine.js` (or read fresh `regime state.json`) for the regime read + drivers.
5. Compute the **mood composite** — see 6b for the no-fabrication rule.
6. Append one row to `docs/mood-history.csv` (only columns you actually compute — timestamp,
   CNN F&G, crypto F&G, aggregate StockTwits bull %, regime score, composite mood). This feeds the
   timeline charts. Decoupled from `sentiment history.csv` on purpose — don't touch the brief's CSV.
7. Write `docs/feed-data.json` = `{ generatedAt (ET), marketOpen (bool), snapshot, mood, regime,
   events, perName, timeline (read back from mood-history.csv), degraded[] }`.
8. **Sleeping/closed case:** if step 1 returned `WATCHER-SLEEPING` (off-hours/weekend, no fresh
   raw), still regenerate `feed-data.json` from the last known state and set `marketOpen:false` so
   the page shows a "market closed — last updated <time>" banner instead of erroring.
9. Every degraded feed must land in `degraded[]` and render on the page — never silently drop one.

### 5b. `docs/market-feed.html` (new, static, authored once, committed)
Self-contained single page. `fetch('feed-data.json')` on load and every 60s, then re-render. No
external scripts/fonts/CDNs (inline everything; embed the Geist font as the brief does). Charts are
**inline SVG generated by the page's own JS** — do not pull Chart.js or any CDN library.

### 5c. `.github/workflows/feed.yml` (new)
- Triggers: `schedule: cron: '*/15 11-22 * * 1-5'` (≈ 7am–6pm ET weekdays; UTC, best-effort, may
  drift 5–15 min — fine; the script self-gates to market hours and no-ops off-hours) **plus**
  `workflow_dispatch` (manual test button).
- `permissions: contents: write`.
- Job: `ubuntu-latest` → checkout → setup-node (node 20, **no install step**) → `node "build feed data.js"`
  → `git add -A && git commit -m "feed update [skip ci]"` (only if changed) → push.
- Only `schedule` + `workflow_dispatch` triggers (no `push` trigger) so the cron's own commits
  can't loop. The `[skip ci]` is belt-and-suspenders.

## 6. The four analysis features (Jad picked all four)

**6a. Event stream (core).** Reverse-chron list from `feed-events.json`. Each row shows time (ET,
H:MM), a clear type tag, symbol, text, and a link if present. Client-side filter/search bar: by
symbol, by type (post/news/filing/move/gauge/theme), by section (trading/macro/theme).

**6b. Aggregate mood meter.** One dial at the top. **Composite = the simple unweighted mean of
whichever of these components are present this run, each normalized 0–100 (higher = greedier /
more risk-on): CNN Fear & Greed, crypto Fear & Greed (only if crypto is in the watchlist),
aggregate StockTwits bull %, regime score.** Show every component value next to the dial — nothing
hidden inside the number. **Do NOT invent weights.** If Jad later wants weighting, it's a one-line
change; flag it as an open question, don't fabricate a formula.

**6c. Sentiment timeline charts.** Inline SVG line charts from `mood-history.csv`: the two gauges
and the composite mood over time. Shows direction, not just today's snapshot.

**6d. Regime + per-name.** A regime panel (risk-on/off read + the drivers from `regime engine.js`).
Per-watchlist-name cards: % change, StockTwits ratio + sample size + velocity, news count, latest
post/filing — reusing the snapshot data the brief already computes.

## 7. Repo + Pages setup

- The **feed folder itself is the repo** (`git init` there). This keeps the fetch/regime/watch
  scripts as a single source of truth (no duplicated copies to drift) and does **not** publish the
  MCP control scripts that live in the parent `TDV MCP` folder.
- Pages source: branch `main`, folder `/docs`. Feed URL becomes
  `https://<user>.github.io/<repo>/market-feed.html`.
- If `gh auth status` is authenticated, create the repo, push, and enable Pages via `gh` /
  `gh api`. If not, print the exact 3–4 commands for Jad to run himself (he can run them inline
  with the `! <command>` prefix in his session) — do not attempt his GitHub login.

## 8. Safe sequencing (do these in order — this is the spine of the plan)

1. **Build local-first.** Write `build feed data.js` + `docs/market-feed.html`. Run
   `node "build feed data.js"` locally (where the feeds are known to work), open
   `file:///.../docs/market-feed.html`, and iterate the design.
2. **Design pass (mandatory).** Use the `frontend-design` skill. Run **at least 3** full
   render → headless-screenshot → self-critique (alignment, hierarchy, density, clipping,
   typography, 1-decimal rounding, ET timestamps, dates-not-week-numbers) → fix → re-render cycles
   before showing Jad. End with a clickable `file:///` link.
3. **Wire the cloud.** Add `feed.yml`, create + push the repo, enable Pages.
4. **PROVE the cloud fetch — this is the one unproven thing.** Fire the workflow via
   `workflow_dispatch`, then inspect the committed `docs/feed-data.json` and its `degraded[]` list.
   Confirm Yahoo prices + news + gauges actually returned **real data from the GitHub runner IP**
   (datacenter IPs sometimes get rate-limited/blocked by Reddit / StockTwits / X — those degrading
   is tolerable; Yahoo prices + news + gauges degrading is not).
5. **Report the cloud-test result to Jad and get his go before removing anything.** (See §9.)

## 9. What to remove — and the CONFIRM gate

Jad authorized **killing all three Windows scheduled tasks** (`TDV Morning Brief`,
`TDV Evening Recap`, `TDV Intraday Watch`) and the toast machinery. **But** removing scheduled
tasks mutates his real setup, and the fresh session must not do it blindly:

- **If §8 step 4 proved the cloud feed works:** report that, then remove all three tasks
  (`powershell -ExecutionPolicy Bypass -File .\install-schedule.ps1 -Remove`), delete
  `intraday-toast.ps1` and the toast/intraday blocks in `install-schedule.ps1`. Tell Jad plainly:
  the 8am/5pm briefs no longer auto-generate — he runs `morning brief` / `evening recap` on demand,
  and the live feed is the new unattended intel surface.
- **FALLBACK if the cloud feeds get blocked from the runner:** do NOT kill local scheduling. Instead
  replace the toast task with one local scheduled task that runs `build feed data.js` locally and
  `git push`es `docs/` (laptop-driven freshness; the page is still always reachable, just only fresh
  while the laptop is on). Surface this outcome to Jad as the degraded-but-working path.
- Either way, **confirm with Jad before the destructive removal step.**

## 10. Docs + memory updates (final step)

- Update the project `CLAUDE.md` "watch the market / intraday" + "morning/evening brief" trigger
  sections and `README.md` (the pieces table + "How to run it") to describe the live feed and the
  cloud cron, and to drop the toast / `intraday-toast.ps1` / `install-schedule.ps1` intraday-task
  references.
- Write a memory note (under the project memory folder) documenting the cloud feed architecture,
  the feed URL, and the cloud-feed-reliability result from §8 step 4. Add the one-line pointer to
  `MEMORY.md`.

## 11. Constraints & gotchas checklist

- No Anthropic API calls in the cron. Free tier only.
- Plain-English file names matching repo convention (the existing folder uses readable names like
  `regime engine.js`, `symbol map.json`); web-served assets use hyphens to keep URLs clean
  (`market-feed.html`, `feed-data.json`, `mood-history.csv`, `feed-events.json`).
- Round every number to 1 decimal. Timestamps in ET with the bar/publish time shown. Dates as
  "Jun 18, 2026", never week numbers.
- Self-contained HTML — inline CSS/JS, embedded font, inline-SVG charts, no CDN/external requests.
- Reuse existing scripts; don't refactor adjacent code; no speculative config knobs; keep
  `build feed data.js` lean.
- The mood composite uses no invented weights (§6b).
- First cloud run primes and shows no events — expected.
- Cron commits must not retrigger the workflow (schedule + dispatch only, `[skip ci]`).

## 12. Definition of done

- `docs/market-feed.html` renders the four features cleanly (verified by screenshot, ≥3 cycles).
- A `workflow_dispatch` run commits a fresh `docs/feed-data.json` with real (non-degraded) prices,
  news, and gauges from the cloud runner.
- The page auto-refreshes and is reachable at its Pages URL with the laptop closed.
- Local scheduled tasks resolved per §9 (removed if cloud proven; fallback task if not) — after
  Jad's confirm.
- Docs + memory updated. Feed URL handed to Jad.
