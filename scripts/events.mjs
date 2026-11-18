// Works out which events each rookie team is registered for and writes
// site/data/events.json:
//
//   { "season": 2027,
//     "events": { "NCGRE": { name, start, end, city, state, country, week } },
//     "teams":  { "11701": ["SCCHA", "NCGRE"] } }      // sorted by start date
//
// The API has no "events for every team" call, so this asks for each event's
// team list (one request per event). That is a few hundred requests, so the
// updater only does it every few hours rather than on every run.

import { writeFile, readFile } from 'node:fs/promises';

const EVENTS_FILE = new URL('../site/data/events.json', import.meta.url);

async function get(api, auth, path) {
  const res = await fetch(`${api}/${path}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`FRC API ${path}: HTTP ${res.status}`);
  return res.json();
}

async function eventTeamNumbers(api, auth, season, code) {
  const numbers = [];
  for (let page = 1, pageTotal = 1; page <= pageTotal && page <= 20; page++) {
    const body = await get(api, auth, `${season}/teams?eventCode=${encodeURIComponent(code)}&page=${page}`);
    pageTotal = body.pageTotal ?? 1;
    for (const t of body.teams ?? []) numbers.push(t.teamNumber);
  }
  return numbers;
}

// Run `worker` over `items`, a few at a time.
async function pool(items, size, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

const clean = (s) => (s ?? '').toString().replace(/\s+/g, ' ').trim();
const day = (s) => (typeof s === 'string' ? s.slice(0, 10) : '');

export async function eventsFileExists() {
  try {
    await readFile(EVENTS_FILE);
    return true;
  } catch {
    return false;
  }
}

// The raw event list for a season, as the API returns it.
export async function fetchEventList({ api, auth, season }) {
  const body = await get(api, auth, `${season}/events`);
  const list = body.Events ?? body.events;
  if (!Array.isArray(list)) throw new Error('FRC API: unexpected events response');
  return list;
}

// Merges two seasons' event lists into one entry per event code, marked
// "both", "new" (this season only) or "previous" (last season only). Details
// come from the newest season the event appears in. Events are matched by
// code; codes occasionally change between years, so a renamed event can show
// up as one "previous" plus one "new".
export function compareSeasons(season, current, previous) {
  const record = (e, eventSeason, status) => ({
    code: e.code,
    name: clean(e.name),
    type: clean(e.type),
    city: clean(e.city),
    state: clean(e.stateprov ?? e.stateProv),
    country: clean(e.country),
    venue: clean(e.venue),
    start: day(e.dateStart),
    end: day(e.dateEnd),
    eventSeason,
    status,
  });
  const before = new Map(previous.filter((e) => e.code).map((e) => [e.code, e]));
  const out = [];
  for (const e of current) {
    if (!e.code) continue;
    out.push(record(e, season, before.has(e.code) ? 'both' : 'new'));
    before.delete(e.code);
  }
  for (const e of before.values()) out.push(record(e, season - 1, 'previous'));
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

export async function refreshEvents({ api, auth, season, rookieNumbers }) {
  const list = await fetchEventList({ api, auth, season });

  const rookies = new Set(rookieNumbers);
  const events = {};
  const byTeam = new Map();
  await pool(list.filter((e) => e.code), 4, async (e) => {
    const here = (await eventTeamNumbers(api, auth, season, e.code)).filter((n) => rookies.has(n));
    if (!here.length) return;
    events[e.code] = {
      name: clean(e.name),
      start: day(e.dateStart),
      end: day(e.dateEnd),
      city: clean(e.city),
      state: clean(e.stateprov ?? e.stateProv),
      country: clean(e.country),
      week: Number.isInteger(e.weekNumber) ? e.weekNumber : null,
    };
    for (const n of here) byTeam.set(n, [...(byTeam.get(n) ?? []), e.code]);
  });

  const order = (a, b) => (events[a].start + a).localeCompare(events[b].start + b);
  const teams = {};
  for (const n of [...byTeam.keys()].sort((a, b) => a - b)) teams[n] = byTeam.get(n).sort(order);
  const sortedEvents = Object.fromEntries(Object.keys(events).sort(order).map((c) => [c, events[c]]));

  const lines = (obj) => Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  await writeFile(EVENTS_FILE,
    `{\n"season": ${season},\n"events": {\n${lines(sortedEvents)}\n},\n"teams": {\n${lines(teams)}\n}\n}\n`);
  return { eventsChecked: list.length, eventsWithRookies: Object.keys(events).length, teamsRegistered: byTeam.size };
}
