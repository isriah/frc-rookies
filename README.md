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
- `scripts/events.mjs` records which events each rookie is registered for in
  `site/data/events.json`. It needs one request per event, so it runs every
  three hours (and on every manual run) rather than every 30 minutes.
- Each team's city is turned into map coordinates by `scripts/geocode.mjs`
  (OpenStreetMap's Nominatim). Results are cached in `cache/geocode.json`, so a
  place is only looked up once; at most 60 new places are looked up per run.

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

## Maps

`site/map.html` draws whatever `site/maps.json` describes; `site/js/map.js` is
the renderer. To add a map, add an entry to `maps` — no new code:

```json
{
  "id": "rookies",                      // map.html?map=rookies
  "title": "{season} FRC Rookie Teams",
  "data": "data/teams.json",            // any JSON file
  "items": "teams",                     // the array inside it
  "label": "{number} {name}",           // popup heading
  "details": ["{city}, {state}, {country}", "{sponsors}"],
  "link": "https://frc-events.firstinspires.org/{season}/team/{number}",
  "noun": "teams",
  "layers": [
    { "name": "Rookie teams", "color": "#0d6efd", "where": { "removed": false } },
    { "name": "Removed", "color": "#dc3545", "where": { "removed": true }, "hidden": true }
  ]
}
```

- Every item needs numeric `lat` and `lon`. A script producing a new data file
  can get them from `openGeocoder()` in `scripts/geocode.mjs`.
- `{placeholders}` read from the item, then from top-level values in the data file.
- An item goes in the first layer whose `where` matches: `true`/`false` means
  "has a value / doesn't", otherwise an exact value or a list of allowed values.
- Points are plain dots; add `"cluster": true` to a map to group nearby points
  into numbered clusters instead, and `"radius"` to change the dot size.
- With more than one map, a picker appears on the map page.
- The base map comes from `tiles` at the top of `maps.json`.
- A wrong pin can be fixed by editing that place's entry in `cache/geocode.json`.

## Notes

- Teams present in the first snapshot of a season have no "first seen" date,
  because it is unknown when they appeared.
- The list only includes teams FIRST publishes through FRC Events, so a team can
  appear some time after it first starts registering.
- `teams.json` carries a `heartbeat` month so there is at least one commit a
  month; GitHub pauses scheduled workflows in repositories with no activity for 60 days.
