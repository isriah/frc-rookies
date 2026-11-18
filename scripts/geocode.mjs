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

const CACHE_FILE = new URL('../cache/geocode.json', import.meta.url);
const ENDPOINT = process.env.GEOCODE_URL || 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'frc-rookie-tracker/1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const placeKey = ({ city, state, country }) =>
  [city, state, country].map((s) => (s ?? '').trim().toLowerCase()).join('|');

export async function openGeocoder({ maxLookups = 60, delayMs = 1100 } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let lookups = 0, dirty = false, lastCall = 0;

  async function query(q, attempt = 1) {
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
        return query(q, attempt + 1);
      }
      throw new Error(`geocoder HTTP ${res.status}`);
    }
    const [hit] = await res.json();
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
    async save() {
      if (!dirty) return;
      await mkdir(new URL('.', CACHE_FILE), { recursive: true });
      const sorted = Object.keys(cache).sort().map((k) => `${JSON.stringify(k)}: ${JSON.stringify(cache[k])}`);
      await writeFile(CACHE_FILE, `{\n${sorted.join(',\n')}\n}\n`);
    },
    get lookups() { return lookups; },
  };
}
