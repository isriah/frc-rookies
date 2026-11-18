# FRC Rookie Tracker

A nearly-live list of FIRST Robotics Competition rookie teams as they register:
number, name, sponsors, location and website. Unofficial; not affiliated with FIRST.

## How it works

- `.github/workflows/update.yml` runs every 30 minutes.
- `scripts/update.mjs` reads the season's teams from the official
  [FRC Events API](https://frc-events.firstinspires.org/services/API), keeps the
  rookies, and merges them into `site/data/teams.json`, recording when each team
  was first seen. Teams that disappear are kept and flagged as removed.
- The workflow commits the data when it changes and deploys `site/` to GitHub Pages.
- `site/feed.xml` is an Atom feed of newly seen teams.

## Setup

1. Register for a free API key at <https://frc-events.firstinspires.org/services/API>.
2. In the repository, go to **Settings → Secrets and variables → Actions** and add
   two secrets: `FRC_API_USERNAME` and `FRC_API_TOKEN`.
3. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Run the workflow once from the **Actions** tab (**Update rookie list → Run workflow**).

The season is chosen automatically (next year's season from May onward). To pin
it, add a repository variable named `SEASON`, e.g. `2027`.

## Run locally

```
FRC_API_USERNAME=... FRC_API_TOKEN=... node scripts/update.mjs
python -m http.server -d site 8000
```

## Notes

- Teams present in the first snapshot of a season have no "first seen" date,
  because it is unknown when they appeared.
- The list only includes teams FIRST publishes through FRC Events, so a team can
  appear some time after it first starts registering.
- `teams.json` carries a `heartbeat` month so there is at least one commit a
  month; GitHub pauses scheduled workflows in repositories with no activity for 60 days.
