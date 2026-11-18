// Config-driven map renderer. A map is described entirely by an entry in
// maps.json, so new maps need data files and a config entry, not new code.
//
// Map entry:
//   id       used in the URL: map.html?map=<id>
//   name     label in the map picker
//   title    heading; may use {placeholders}
//   sources  one or more datasets drawn on the same map (see below). A map
//            with a single dataset may put the source fields directly on the
//            map entry instead of using `sources`.
//
// Source (dataset):
//   name     label in the control panel
//   data     URL of a JSON file
//   items    name of the array inside that file (omit if the file is the array)
//   label    popup heading template, e.g. "{number} {name}"
//   details  popup lines (templates); empty lines are dropped
//   link     optional URL template for the popup heading
//   noun     what the points are called, e.g. "teams"
//   shape    "circle" (default) or "diamond"
//   radius   dot size in pixels (default 5)
//   hidden   true to start switched off
//   search   fields the search box looks in (default: every text/number field)
//   layers   [{ name, color, where, hidden }] — each item goes in the first
//            layer whose `where` matches. `where` maps field -> true/false
//            (has a value / doesn't), a value, a list of allowed values, or a
//            "{placeholder}" compared as text. A layer with no `where`
//            catches everything the others don't.
//   color    dot colour when the source has no `layers`
//   choose   show one group at a time, picked from a dropdown of the values
//            found in a field: { field, default } (e.g. one season of events)
//   colorBy  optional gradient colouring by a numeric field, switchable in
//            the panel: { field, label, stops: [colours low -> high], min,
//            max, default: "gradient" | "flat" }
//   cluster  (map-level) true to group nearby points into numbered clusters
//
// Every item needs numeric `lat` and `lon`; items without them are counted
// and reported but not drawn. {placeholders} read from the item first, then
// from top-level values in the data file (such as `season`). A data file with
// a top-level "sample": true is flagged as sample data in the panel.
//
// Requires Leaflet as a global; Leaflet.markercluster only if a map sets "cluster".

const fill = (template, item, file) =>
  String(template ?? '')
    .replace(/\{(\w+)\}/g, (_, k) => item?.[k] ?? file?.[k] ?? '')
    .split(', ')
    .filter((part) => part.trim()) // tidy "City, , Country"
    .join(', ')
    .trim();

function matches(item, where = {}, file) {
  return Object.entries(where).every(([field, want]) => {
    const have = item[field];
    if (typeof want === 'boolean') return Boolean(have) === want;
    if (Array.isArray(want)) return want.includes(have);
    if (typeof want === 'string' && want.includes('{')) return String(have) === fill(want, null, file);
    return have === want;
  });
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function popupFor(item, source) {
  const label = fill(source.label, item, source.file) || '(unnamed)';
  const url = source.link ? fill(source.link, item, source.file) : '';
  const head = el('b');
  head.append(/^https?:\/\//.test(url) ? el('a', { href: url, textContent: label, rel: 'noopener' }) : label);
  const box = el('div', { className: 'popup' }, head);
  for (const line of source.details ?? []) {
    const text = fill(line, item, source.file);
    if (text) box.append(el('div', { textContent: text }));
  }
  return box;
}

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

// Colour at position t (0..1) along a list of #rrggbb stops.
function gradientColor(stops, t) {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const a = hex(stops[i]), b = hex(stops[i + 1]);
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * (x - i))).join(',')})`;
}

const DEFAULT_COLOR = '#0d6efd';

async function loadSource(cfg) {
  const source = { ...cfg, on: !cfg.hidden, points: [], unplaced: 0, error: '' };
  try {
    const res = await fetch(cfg.data, { cache: 'no-cache' });
    if (!res.ok) throw new Error('not available yet');
    source.file = await res.json();
    source.list = cfg.items ? source.file[cfg.items] : source.file;
    if (!Array.isArray(source.list)) throw new Error('unexpected format');
  } catch (e) {
    source.error = e.message;
    source.file = {};
    source.list = [];
    source.on = false;
  }
  source.noun = cfg.noun ?? 'items';
  source.layers = (cfg.layers ?? [{ name: cfg.name ?? source.noun }])
    .map((l) => ({ ...l, color: l.color ?? cfg.color ?? DEFAULT_COLOR, name: fill(l.name, null, source.file), points: [] }));

  if (cfg.choose) {
    const values = [...new Set(source.list.map((it) => it[cfg.choose.field]).filter((v) => v != null))];
    source.choices = values.sort((a, b) => (a < b ? 1 : -1)); // newest / highest first
    const wanted = fill(cfg.choose.default, null, source.file);
    source.choice = String(source.choices.find((v) => String(v) === wanted) ?? source.choices[0] ?? '');
  }
  source.chosen = (p) => !cfg.choose || String(p.item[cfg.choose.field]) === source.choice;
  source.shows = (p) => !p.layer.hidden && source.chosen(p);

  const by = cfg.colorBy;
  if (by) {
    const values = source.list.map((it) => it[by.field]).filter(Number.isFinite);
    source.lo = by.min ?? Math.min(...values);
    source.hi = by.max ?? Math.max(...values);
    source.gradient = by.default !== 'flat';
    // Draw low values first so the high end of the scale ends up on top.
    source.list = [...source.list].sort((a, b) => (a[by.field] ?? -Infinity) - (b[by.field] ?? -Infinity));
  }
  source.colorOf = (item, layer) => {
    if (!by || !source.gradient) return layer.color;
    const v = item[by.field];
    const span = source.hi - source.lo;
    return Number.isFinite(v) ? gradientColor(by.stops, span > 0 ? (v - source.lo) / span : 1) : '#9aa0a6';
  };
  return source;
}

function makeMarker(latlng, source, color) {
  if (source.shape === 'diamond') {
    const size = (source.radius ?? 5) * 2 + 2;
    const icon = L.divIcon({ className: '', iconSize: [size, size], html: `<span class="diamond" style="background:${color}"></span>` });
    return L.marker(latlng, { icon });
  }
  return L.circleMarker(latlng, {
    radius: source.radius ?? 5, color: 'rgba(0,0,0,.55)', weight: 0.8, fillColor: color, fillOpacity: 0.9,
  });
}

export async function renderMap({ mapEl, panelEl, noteEl, searchEl, countEl, config, tiles }) {
  const sources = await Promise.all((config.sources ?? [config]).map(loadSource));

  // Show the world once: no repeated copies, no panning past the edges, and
  // no zooming out further than the level where one world fills the map
  // (its longer side, so there is never blank space above or below).
  const world = L.latLngBounds([[-85, -180], [85, 180]]);
  // Quarter-step zoom lets the furthest-out view match the map's width closely.
  const map = L.map(mapEl, { preferCanvas: true, maxBounds: world, maxBoundsViscosity: 1, zoomSnap: 0.25 });
  const fitMinZoom = () => map.setMinZoom(Math.max(0, Math.ceil(Math.log2(Math.max(mapEl.clientWidth, mapEl.clientHeight) / 256) * 4) / 4));
  fitMinZoom();
  map.on('resize', fitMinZoom);
  map.setView([25, 0], map.getMinZoom());
  L.tileLayer(tiles.url, { attribution: tiles.attribution, maxZoom: tiles.maxZoom ?? 18, noWrap: true, bounds: world }).addTo(map);
  // Plain dots by default; "cluster": true groups nearby points into counts.
  const clustered = config.cluster && typeof L.markerClusterGroup === 'function';
  const group = (clustered ? L.markerClusterGroup({ maxClusterRadius: 40, showCoverageOnHover: false }) : L.layerGroup()).addTo(map);

  const stacked = new Map();
  for (const source of sources) {
    for (const item of source.list) {
      // A layer with no `where` catches whatever the others don't, wherever it is listed.
      const layer = source.layers.find((l) => l.where && matches(item, l.where, source.file)) ?? source.layers.find((l) => !l.where);
      if (!layer) continue;
      if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) { source.unplaced++; continue; }
      // Items at the same point are fanned out in a small spiral so every
      // dot can be seen and clicked.
      const spot = `${item.lat},${item.lon}`;
      const n = stacked.get(spot) ?? 0;
      stacked.set(spot, n + 1);
      // The spread matches how exact the point is: teams known to share a
      // school sit ~40 m apart, a shared postcode ~200 m, a shared city ~1 km.
      const step = { school: 0.0004, exact: 0.0004, postcode: 0.002 }[item.loc] ?? 0.009;
      const r = clustered ? 0 : step * Math.sqrt(n), angle = n * 2.39996;
      const lat = item.lat + r * Math.sin(angle);
      const lon = item.lon + (r * Math.cos(angle)) / Math.max(0.2, Math.cos((item.lat * Math.PI) / 180));
      const marker = makeMarker([lat, lon], source, source.colorOf(item, layer));
      marker.bindPopup(() => popupFor(item, source), { maxWidth: 280 });
      marker.bindTooltip(fill(source.label, item, source.file));
      // Same matching as the list page: every typed word must appear somewhere
      // in the item's searchable fields.
      const fields = source.search ?? Object.keys(item).filter((k) => k !== 'lat' && k !== 'lon');
      const haystack = fields.map((k) => item[k]).filter((v) => typeof v === 'string' || typeof v === 'number').join(' ').toLowerCase();
      const point = { marker, item, layer, source, haystack };
      layer.points.push(point);
      source.points.push(point);
    }
  }

  let words = [], matched = [];
  function refresh() {
    group.clearLayers();
    const candidates = sources.filter((s) => s.on).flatMap((s) => s.points.filter(s.shows));
    matched = candidates.filter((p) => words.every((w) => p.haystack.includes(w)));
    for (const p of matched) group.addLayer(p.marker);
    if (countEl) countEl.textContent = words.length ? `${matched.length} of ${candidates.length} shown match` : '';
    const missing = sources.filter((s) => s.on && s.unplaced).map((s) => `${s.unplaced} ${s.noun}`);
    noteEl.textContent = missing.length
      ? `Not shown because their location could not be placed on the map: ${missing.join(', ')}.`
      : '';
  }

  function recolor(source) {
    for (const p of source.points) {
      if (p.marker.setStyle) p.marker.setStyle({ fillColor: source.colorOf(p.item, p.layer) });
    }
  }

  // Control panel: one block per dataset, with its layers and colour choice.
  panelEl.replaceChildren(...sources.map((source) => {
    const master = el('input', { type: 'checkbox', checked: source.on, disabled: Boolean(source.error) });
    const total = el('span', { className: 'count' });
    const layerCounts = [];
    const showTotal = () => {
      total.textContent = source.error ? `(${source.error})` : `(${source.points.filter(source.shows).length})`;
      for (const [layer, span] of layerCounts) span.textContent = `(${layer.points.filter(source.chosen).length})`;
    };
    const head = el('label', { className: 'panel-head' }, master, source.name ?? source.noun, total);
    if (source.file.sample) head.append(el('span', { className: 'badge sample', textContent: 'SAMPLE DATA', title: 'Placeholder data for previewing; not real' }));
    const body = el('div', { className: 'panel-body' });
    const block = el('section', { className: 'panel-block' }, head, body);

    const swatches = [];
    const showLayers = source.layers.length > 1 || source.layers[0].name !== (source.name ?? source.noun);
    for (const layer of source.layers) {
      const box = el('input', { type: 'checkbox', checked: !layer.hidden });
      box.addEventListener('change', () => { layer.hidden = !box.checked; showTotal(); refresh(); });
      const swatch = el('span', { className: source.shape === 'diamond' ? 'swatch diamond' : 'swatch' });
      swatch.style.background = layer.color;
      swatches.push(swatch);
      const count = el('span', { className: 'count' });
      layerCounts.push([layer, count]);
      const row = el('label', {}, box, swatch, layer.name, count);
      if (showLayers) body.append(row);
      else head.insertBefore(swatch, master.nextSibling);
    }

    if (source.choices?.length) {
      const field = source.choose.field;
      const pick = el('select', { ariaLabel: `${source.name ?? source.noun}: ${field}` },
        ...source.choices.map((v) => new Option(String(v), String(v), false, String(v) === source.choice)));
      pick.addEventListener('change', () => { source.choice = pick.value; showTotal(); refresh(); });
      body.prepend(pick);
    }

    const by = source.colorBy;
    if (by && !source.error) {
      const bar = el('span', { className: 'gradient' });
      bar.style.background = `linear-gradient(90deg, ${by.stops.join(', ')})`;
      const scale = el('div', { className: 'scale' }, String(source.lo), bar, String(source.hi));
      const pick = el('select', { ariaLabel: `Colour ${source.noun} by` },
        new Option(`Colour by ${(by.label ?? by.field).toLowerCase()}`, 'gradient', false, source.gradient),
        new Option('Colour by group', 'flat', false, !source.gradient));
      const apply = () => {
        scale.hidden = !source.gradient;
        for (const s of swatches) s.style.visibility = source.gradient ? 'hidden' : '';
      };
      pick.addEventListener('change', () => { source.gradient = pick.value === 'gradient'; recolor(source); apply(); });
      body.append(pick, scale);
      apply();
    }

    showTotal();
    const setOn = () => { source.on = master.checked; block.classList.toggle('off', !source.on); refresh(); };
    master.addEventListener('change', setOn);
    block.classList.toggle('off', !source.on);
    return block;
  }));

  // Zoom to whatever is currently shown; a single result also opens its popup.
  function zoomToMatches() {
    if (!matched.length) return;
    map.fitBounds(L.latLngBounds(matched.map((p) => p.marker.getLatLng())).pad(0.15), { maxZoom: matched.length === 1 ? 11 : 9 });
    if (matched.length === 1) matched[0].marker.openPopup();
  }

  if (searchEl) {
    // Typing filters the dots; Enter (or the search button on phones) zooms to them.
    searchEl.addEventListener('input', () => {
      words = searchEl.value.toLowerCase().split(/\s+/).filter(Boolean);
      refresh();
    });
    searchEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') zoomToMatches(); });
    searchEl.addEventListener('search', () => { if (searchEl.value) zoomToMatches(); });
  }

  refresh();
  if (matched.length) map.fitBounds(L.latLngBounds(matched.map((p) => p.marker.getLatLng())).pad(0.1), { maxZoom: 6 });
  const first = sources.find((s) => !s.error) ?? sources[0];
  return { map, title: fill(config.title, null, first.file) };
}
