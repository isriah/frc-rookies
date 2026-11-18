// Turns "city, state, country" into coordinates using OpenStreetMap's Nominatim,
// with a cache committed to the repo so each place is only ever looked up once.
// Reusable by any script that needs points for a map:
//
//   const geo = await openGeocoder();
//   const point = await geo.locate({ city, state, country });   // { lat, lon } or null
//   await geo.save();
//
// Nominatim's usage policy allows at most one request per second, so lookups
// are throttled and capped per run; anything left over is picked up next run.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// GEOCODE_CACHE points the cache somewhere else (used by tests).
const CACHE_FILE = process.env.GEOCODE_CACHE
  ? pathToFileURL(process.env.GEOCODE_CACHE)
  : new URL('../cache/geocode.json', import.meta.url);
const SCHOOL_FILE = process.env.GEOCODE_CACHE
  ? pathToFileURL(process.env.GEOCODE_CACHE + '.schools.json')
  : new URL('../cache/schools.json', import.meta.url);
const ENDPOINT = process.env.GEOCODE_URL || 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'frc-rookie-tracker/1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Teams list states by name ("North Carolina") and events by code ("NC").
// Spell US and Canadian codes out so both share one cache entry.
const STATES = {
  usa: { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
    DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
    VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' },
  canada: { AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
    NS: 'Nova Scotia', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
    NT: 'Northwest Territories', NU: 'Nunavut' },
};

export const placeKey = ({ city, state, country }) => {
  const k = (country ?? '').trim().toLowerCase();
  const s = (state ?? '').trim();
  const full = s.length === 2 ? STATES[k]?.[s.toUpperCase()] : undefined;
  return [(city ?? '').trim(), full ?? s, k].map((part) => part.toLowerCase()).join('|');
};

const isSchool = (hit) =>
  /^(school|college|university|kindergarten)$/.test(hit.type ?? '') ||
  (hit.category === 'office' && hit.type === 'educational_institution');

function distanceKm(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

export async function openGeocoder({ maxLookups = 60, delayMs = 1100 } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  // Schools get their own cache file: "school|city|state|country" -> point.
  let schools = {};
  try {
    schools = JSON.parse(await readFile(SCHOOL_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let lookups = 0, dirty = false, schoolsDirty = false, lastCall = 0;

  // The best match for a free-text query, as the service returns it, or null.
  async function search(q, attempt = 1) {
    const wait = lastCall + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(`${ENDPOINT}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    });
    if (!res.ok) {
      // The public service has brief busy spells; back off and try twice more.
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(10000 * attempt);
        return search(q, attempt + 1);
      }
      throw new Error(`geocoder HTTP ${res.status}`);
    }
    const [hit] = await res.json();
    return hit ?? null;
  }

  async function query(q) {
    const hit = await search(q);
    // Three decimals is ~100 m: plenty for a city-level pin.
    return hit ? { lat: +(+hit.lat).toFixed(3), lon: +(+hit.lon).toFixed(3) } : null;
  }

  return {
    // Returns { lat, lon }, null when the place can't be found, or undefined
    // when this run's lookup budget is spent (try again next run).
    async locate(place) {
      if (!place.city || !place.country) return null;
      // Military post offices and numeric junk have no real place to find.
      if (/^(apo|fpo|dpo)$/i.test(place.city.trim()) || !/\p{L}/u.test(place.city)) return null;
      const key = placeKey(place);
      if (key in cache) return cache[key];
      if (lookups >= maxLookups) return undefined;
      lookups++;
      let point;
      try {
        point = await query([place.city, place.state, place.country].filter(Boolean).join(', '));
        // State codes from some sources ("34", "CU") confuse the geocoder.
        if (!point && place.state) point = await query(`${place.city}, ${place.country}`);
      } catch (e) {
        console.warn(`Geocoding stopped: ${e.message}`);
        lookups = maxLookups; // service trouble: stop for this run, keep what we have
        return undefined;
      }
      cache[key] = point;
      dirty = true;
      return point;
    },
    // A team's school, for a more exact pin than its postcode or city. Only
    // accepted when the match is actually a school and sits within 30 km of
    // `near` (where we already believe the team is), so a same-named school
    // elsewhere is never used. Returns like locate().
    async locateSchool(team, near) {
      const name = (team.school ?? '').trim();
      if (name.length < 5 || /family|community/i.test(name) || !team.city || !team.country) return null;
      const key = `${name.toLowerCase()}|${placeKey(team)}`;
      if (key in schools) return schools[key];
      if (lookups >= maxLookups) return undefined;
      lookups++;
      let hit;
      try {
        hit = await search([name, team.city, team.state, team.country].filter(Boolean).join(', '));
      } catch (e) {
        console.warn(`Geocoding stopped: ${e.message}`);
        lookups = maxLookups;
        return undefined;
      }
      let point = null;
      if (hit && isSchool(hit)) {
        const p = { lat: +(+hit.lat).toFixed(4), lon: +(+hit.lon).toFixed(4) };
        if (!near || distanceKm(p, near) <= 30) point = p;
      }
      schools[key] = point;
      schoolsDirty = true;
      return point;
    },
    async save() {
      const write = async (file, data) => {
        await mkdir(new URL('.', file), { recursive: true });
        const sorted = Object.keys(data).sort().map((k) => `${JSON.stringify(k)}: ${JSON.stringify(data[k])}`);
        await writeFile(file, `{\n${sorted.join(',\n')}\n}\n`);
      };
      if (dirty) await write(CACHE_FILE, cache);
      if (schoolsDirty) await write(SCHOOL_FILE, schools);
      dirty = schoolsDirty = false;
    },
    get lookups() { return lookups; },
  };
}
