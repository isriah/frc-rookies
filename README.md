# FRC Rookie Tracker

A nearly-live list of FIRST Robotics Competition rookie teams as they register:
number, name, sponsors, location and website. Unofficial; not affiliated with FIRST.

## How it works

- `.github/workflows/update.yml` is scheduled every 15 minutes. GitHub
  skips a large share of scheduled runs, so real checks are further apart.
- `scripts/update.mjs` reads the season's teams from the official
  [FRC Events API](https://frc-events.firstinspires.org/services/API), keeps the
  rookies, and merges them into `site/data/teams.json`, recording when each team
  was first seen. Teams that disappear are kept and flagged as removed.
- The workflow commits the data when it changes and deploys `site/` to GitHub Pages.
- `site/feed.xml` is an Atom feed of newly seen teams.
- `site/data/all-teams.json` holds every team this season (number, name, city,
  rookie year, coordinates) for the all-teams map.
- `scripts/events.mjs` records which events each rookie is registered for in
  `site/data/events.json`. It needs one request per event, so it runs when
  the last refresh is about three hours old (and on every manual run) rather
  than on every check. `meta.json` records when that was, as `eventsChecked`.
- `site/data/event-locations.json` lists every event from this season and the
  previous one, each tagged with its season, for the map's year dropdown.
  `EVENT_SEASONS` in `scripts/update.mjs` sets how many years are kept.
- Map locations come from three places, most precise first:
  1. `locations/overrides.json` — hand-entered fixes, `{ "254": { "lat": 37.27, "lon": -121.84 } }`.
     Add a team here to put it exactly where it belongs.
  2. `cache/schools.json` — the team's school, looked up by name with
     OpenStreetMap's Nominatim and accepted only when the match is a school
     within 30 km of where the team is otherwise placed.
  3. `cache/team-locations.json` — postcode-level points from FIRST's old public
     team search, kept for countries where that data proved reliable (US, Canada,
     Australia and others; not Türkiye or Mexico). It is a one-time export, so
     teams newer than it are not in it.
  4. `cache/geocode.json` — the centre of the team's or event's listed city.
     Most entries were matched from the [GeoNames](https://www.geonames.org/)
     place database (CC BY 4.0); `scripts/geocode.mjs` looks up anything new
     with OpenStreetMap's Nominatim, at most 60 places per run.

## Setup

1. Register for a free API key at <https://frc-events.firstinspires.org/services/API>.
2. In the repository, go to **Settings → Secrets and variables → Actions** and add
   two secrets: `FRC_API_USERNAME` and `FRC_API_TOKEN`.
3. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Run the workflow once from the **Actions** tab (**Update rookie list → Run workflow**).

The season is chosen automatically (next year's season from May onward). To pin
it, add a repository variable named `SEASON`, e.g. `2027`.

## Outside timer

GitHub's schedule is best-effort and has been skipping most runs, so `trigger/`
holds a small Cloudflare Worker that starts the workflow every 15 minutes
instead. GitHub's own schedule stays on as a fallback.

1. On GitHub, go to **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens** and create a token with **Repository access** set to
   only this repository and **Actions: Read and write** as its one permission.
2. Deploy the Worker and give it the token (you are asked to paste it):

   ```
   cd trigger
   npx wrangler deploy
   npx wrangler secret put GITHUB_TOKEN
   ```

Runs it starts show as "workflow_dispatch" in the Actions tab. `npx wrangler tail`
shows the Worker's log; a failed call to GitHub is logged with the reason. When
the token expires, create a new one and repeat the `secret put` step.

## Run locally

```
FRC_API_USERNAME=... FRC_API_TOKEN=... node scripts/update.mjs
python -m http.server -d site 8000
```

## Maps

`site/map.html` draws whatever `site/maps.json` describes; `site/js/map.js` is
the renderer. The site ships one map, `everything`, which combines teams,
removed teams and events. To add another, add an entry to `maps` — no new
code. A simple single-dataset entry looks like this:

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
- To colour dots on a gradient by a number instead of by layer, add
  `"colorBy": { "field": "rookieYear", "label": "Rookie year", "stops": ["#440154", "#fde725"] }`
  (any number of colour stops, low to high; `min`/`max` are optional).
- The search box matches every typed word against all of an item's text and
  number fields; add `"search": ["number", "name"]` to limit which fields.
- A map can draw several datasets at once: give it a `sources` list, each with
  its own `data`, `layers`, popup templates and optional `shape` (`"diamond"`).
  The panel beside the map gets a block per dataset to switch it, its layers
  and its colouring on and off. See the `everything` map and the notes at the
  top of `site/js/map.js`.
- With more than one map, a picker appears on the map page (`name` is its label).
- The base map comes from `tiles` at the top of `maps.json`.
- A wrong pin can be fixed by editing that place's entry in `cache/geocode.json`.

## Notes

- Teams present in the first snapshot of a season have no "first seen" date,
  because it is unknown when they appeared.
- The list only includes teams FIRST publishes through FRC Events, so a team can
  appear some time after it first starts registering.
- `teams.json` carries a `heartbeat` month so there is at least one commit a
  month; GitHub pauses scheduled workflows in repositories with no activity for 60 days.
