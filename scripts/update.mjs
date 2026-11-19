// Fetches the season's rookie teams from the FRC Events API and merges them
// into site/data/teams.json, keeping the date each team was first seen.
//
// Each team also gets lat/lon for the map (see geocode.mjs).
//
// Required env: FRC_API_USERNAME, FRC_API_TOKEN (free, https://frc-events.firstinspires.org/services/API)
// Optional env: SEASON (e.g. 2027), FRC_API_BASE (for testing), SITE_URL (the published site),
//   EVENTS=always|never (event registrations normally refresh every 3 hours)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openGeocoder } from './geocode.mjs';
import { refreshEvents, eventsFileExists, fetchEventList, eventRecords } from './events.mjs';

// How many seasons of event locations to keep for the map's year dropdown.
const EVENT_SEASONS = 2;

const API = process.env.FRC_API_BASE || 'https://frc-api.firstinspires.org/v3.0';
const DATA_DIR = new URL('../site/data/', import.meta.url);
const TEAMS_FILE = new URL('teams.json', DATA_DIR);
const ALL_TEAMS_FILE = new URL('all-teams.json', DATA_DIR);
const EVENT_PLACES_FILE = new URL('event-locations.json', DATA_DIR);
const META_FILE = new URL('meta.json', DATA_DIR);
const FEED_FILE = new URL('../site/feed.xml', import.meta.url);

class SeasonUnavailable extends Error {}

// Names are kept as FIRST publishes them; only whitespace is tidied.
const clean = (s) => (s ?? '').toString().replace(/\s+/g, ' ').trim();

async function fetchSeason(season, auth) {
  const teams = [];
  for (let page = 1, pageTotal = 1; page <= pageTotal; page++) {
    const res = await fetch(`${API}/${season}/teams?page=${page}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (res.status === 400 || res.status === 404) {
      throw new SeasonUnavailable(`season ${season}: HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`FRC API ${season} page ${page}: HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.teams)) throw new Error('FRC API: unexpected response shape');
    pageTotal = body.pageTotal ?? 1;
    teams.push(...body.teams);
    if (page > 200) throw new Error('FRC API: too many pages');
  }
  return teams;
}

const toRecord = (t) => ({
  number: t.teamNumber,
  name: clean(t.nameShort),
  sponsors: clean(t.nameFull),
  school: clean(t.schoolName),
  city: clean(t.city),
  state: clean(t.stateProv),
  country: clean(t.country),
  district: clean(t.districtCode),
});

export function merge(previous, rookies, season, now) {
  const sameSeason = previous && previous.season === season;
  const old = new Map(sameSeason ? previous.teams.map((t) => [t.number, t]) : []);
  // On the very first snapshot of a season we don't know when teams appeared.
  const baseline = !sameSeason || previous.teams.length === 0;
  const out = new Map();
  for (const r of rookies) {
    const prev = old.get(r.number);
    out.set(r.number, { ...r, firstSeen: prev ? prev.firstSeen : baseline ? null : now });
  }
  // Keep teams that vanished from the API, flagged, so the list is a record.
  for (const [number, prev] of old) {
    if (!out.has(number)) out.set(number, { ...prev, removed: prev.removed ?? now });
  }
  return {
    season,
    heartbeat: now.slice(0, 7), // changes monthly so the repo never looks inactive
    teams: [...out.values()].sort((a, b) => a.number - b.number),
  };
}

const stringify = (snap) =>
  `{\n"season": ${snap.season},\n"heartbeat": ${JSON.stringify(snap.heartbeat)},\n"teams": [\n` +
  snap.teams.map((t) => JSON.stringify(t)).join(',\n') +
  '\n]\n}\n';

const xml = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

function feed(snap, now) {
  const recent = snap.teams
    .filter((t) => t.firstSeen && !t.removed)
    .sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : b.number - a.number))
    .slice(0, 100);
  const updated = recent[0]?.firstSeen ?? now;
  const entries = recent.map((t) => {
    const where = [t.city, t.state, t.country].filter(Boolean).join(', ');
    return `  <entry>
    <id>urn:frc-rookies:${snap.season}:${t.number}</id>
    <title>${xml(`${t.number} ${t.name}`)} — ${xml(where)}</title>
    <updated>${t.firstSeen}</updated>
    <link href="https://frc-events.firstinspires.org/${snap.season}/team/${t.number}"/>
    <summary>${xml(t.sponsors)}</summary>
  </entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>urn:frc-rookies:${snap.season}</id>
  <title>${snap.season} FRC Rookie Teams</title>
  <updated>${updated}</updated>
  <author><name>FRC Rookie Tracker (unofficial)</name></author>
${entries.join('\n')}
</feed>
`;
}

async function main() {
  const { FRC_API_USERNAME: user, FRC_API_TOKEN: token } = process.env;
  if (!user || !token) throw new Error('Set FRC_API_USERNAME and FRC_API_TOKEN');
  const auth = Buffer.from(`${user}:${token}`).toString('base64');
  const nowDate = new Date();
  const now = nowDate.toISOString().replace(/\.\d+Z$/, 'Z');

  let previous = null;
  try {
    previous = JSON.parse(await readFile(TEAMS_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  // Next season's teams start registering in spring; before FIRST opens the
  // new season in the API, fall back to the current one.
  let season = Number(process.env.SEASON) || nowDate.getUTCFullYear() + (nowDate.getUTCMonth() >= 4 ? 1 : 0);
  let all;
  try {
    all = await fetchSeason(season, auth);
  } catch (e) {
    if (!(e instanceof SeasonUnavailable) || process.env.SEASON) throw e;
    season -= 1;
    if (previous && previous.season > season) throw e; // never go backwards
    all = await fetchSeason(season, auth);
  }
  if (all.length === 0) throw new Error('FRC API returned no teams; refusing to update');

  const rookies = all.filter((t) => t.rookieYear === season && Number.isInteger(t.teamNumber)).map(toRecord);
  const snap = merge(previous, rookies, season, now);

  // Add map coordinates. Places not yet in the cache are looked up a few at a
  // time; teams still waiting simply have no lat/lon until a later run.
  const geo = await openGeocoder({ maxLookups: Number(process.env.GEOCODE_MAX) || 60 });
  // A team's own location, most precise first: a hand-entered override, then
  // the postcode-level point from FIRST's old team search, then its city.
  const readJson = async (url) => {
    try {
      return JSON.parse(await readFile(url, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`Ignoring ${url.pathname.split('/').pop()}: ${e.message}`);
      return {};
    }
  };
  const overrides = await readJson(new URL('../locations/overrides.json', import.meta.url));
  const known = await readJson(new URL('../cache/team-locations.json', import.meta.url));
  const valid = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
  const locateTeam = async (t) => {
    // `loc` records how the point was found, so the map knows how exact it is.
    if (valid(overrides[t.number])) return { lat: overrides[t.number].lat, lon: overrides[t.number].lon, loc: 'exact' };
    if (valid(known[t.number])) return { lat: known[t.number].lat, lon: known[t.number].lon, loc: 'postcode' };
    const city = await geo.locate(t);
    return city ? { ...city, loc: 'city' } : city;
  };
  for (const t of snap.teams) {
    delete t.website;
    delete t.lat;
    delete t.lon;
    delete t.loc;
    const point = await locateTeam(t);
    if (point) Object.assign(t, point);
  }

  // Every team this season, for the all-teams map. Rookies were located
  // first, so they get priority when the lookup budget is tight.
  const everyone = [];
  for (const t of all) {
    if (!Number.isInteger(t.teamNumber)) continue;
    const rec = { number: t.teamNumber, name: clean(t.nameShort), school: clean(t.schoolName), city: clean(t.city),
      state: clean(t.stateProv), country: clean(t.country), rookieYear: Number.isInteger(t.rookieYear) ? t.rookieYear : null };
    const point = await locateTeam(rec);
    if (point) Object.assign(rec, point);
    everyone.push(rec);
  }
  everyone.sort((a, b) => a.number - b.number);

  // Event locations for each season in EVENT_SEASONS, newest first, so the map
  // can switch between years. One request per season; if any fails the
  // previous file is left as it is.
  let eventPlaces = null;
  const eventSeasons = Array.from({ length: EVENT_SEASONS }, (_, i) => season - i);
  try {
    const lists = await Promise.all(eventSeasons.map((s) => fetchEventList({ api: API, auth, season: s })));
    eventPlaces = lists.flatMap((list, i) => eventRecords(eventSeasons[i], list));
    for (const e of eventPlaces) {
      const point = await geo.locate(e);
      if (point) Object.assign(e, point);
    }
  } catch (e) {
    console.warn(`Event locations not refreshed: ${e.message}`);
  }

  // Last, try each team's school for a more exact pin (rookies first). A hand
  // override always wins, and a school that can't be found, or that turns up
  // far from where the team is believed to be, leaves the team where it was.
  for (const t of [...snap.teams.filter((x) => !x.removed), ...everyone]) {
    if (valid(overrides[t.number])) continue;
    const point = await geo.locateSchool(t, valid(t) ? { lat: t.lat, lon: t.lon } : null);
    if (point) Object.assign(t, point, { loc: 'school' });
  }
  await geo.save();

  await mkdir(DATA_DIR, { recursive: true });
  if (previous && previous.season !== season) {
    await mkdir(new URL('archive/', DATA_DIR), { recursive: true });
    await writeFile(new URL(`archive/teams-${previous.season}.json`, DATA_DIR), stringify(previous));
  }
  const allText = stringify({ season, heartbeat: now.slice(0, 7), teams: everyone });
  let allPrevious = '';
  try {
    allPrevious = await readFile(ALL_TEAMS_FILE, 'utf8');
  } catch {}
  if (allPrevious !== allText) await writeFile(ALL_TEAMS_FILE, allText);

  if (eventPlaces) {
    const head = `"season": ${season},\n"events": [\n`;
    const placesText = `{\n${head}${eventPlaces.map((e) => JSON.stringify(e)).join(',\n')}\n]\n}\n`;
    let placesPrevious = '';
    try {
      placesPrevious = await readFile(EVENT_PLACES_FILE, 'utf8');
    } catch {}
    if (placesPrevious !== placesText) await writeFile(EVENT_PLACES_FILE, placesText);
    const count = (s) => eventPlaces.filter((e) => e.season === s).length;
    console.log(`Event locations: ${eventSeasons.map((s) => `${count(s)} in ${s}`).join(', ')}`);
  }

  const text = stringify(snap);
  const changed = !previous || stringify(previous) !== text;
  if (changed) await writeFile(TEAMS_FILE, text);
  await writeFile(FEED_FILE, feed(snap, now));

  // Event registrations take a few hundred requests, so only refresh them when
  // the last refresh is about three hours old, when missing, or when asked to.
  // Going by age rather than the clock copes with GitHub skipping scheduled runs.
  // meta.json isn't committed, so on GitHub the last refresh time is read back
  // from the published site. If that fails, refresh to be safe.
  let eventsChecked;
  try {
    eventsChecked = JSON.parse(await readFile(META_FILE, 'utf8')).eventsChecked;
  } catch {}
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  const siteUrl = process.env.SITE_URL || (repo ? `https://${owner}.github.io/${repo}` : '');
  if (!eventsChecked && siteUrl) {
    try {
      const res = await fetch(`${siteUrl}/data/meta.json`, { cache: 'no-store' });
      if (res.ok) eventsChecked = (await res.json()).eventsChecked;
    } catch {}
  }
  const mode = process.env.EVENTS;
  const age = nowDate - new Date(eventsChecked ?? 0);
  const due = !(age < 2.75 * 3600 * 1000);
  if (mode !== 'never' && (mode === 'always' || due || !(await eventsFileExists()))) {
    try {
      const rookieNumbers = snap.teams.filter((t) => !t.removed).map((t) => t.number);
      const r = await refreshEvents({ api: API, auth, season, rookieNumbers });
      eventsChecked = now;
      console.log(`Events: ${r.eventsChecked} checked, ${r.eventsWithRookies} with rookies, ${r.teamsRegistered} rookies registered`);
    } catch (e) {
      console.warn(`Event registrations not refreshed: ${e.message}`); // keep the previous file
    }
  }
  await writeFile(META_FILE, JSON.stringify({ lastChecked: now, season, totalTeams: all.length, eventsChecked }) + '\n');

  const active = snap.teams.filter((t) => !t.removed).length;
  console.log(`Season ${season}: ${all.length} teams, ${active} rookies, ${geo.lookups} places geocoded, data ${changed ? 'changed' : 'unchanged'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
