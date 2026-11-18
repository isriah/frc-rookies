// Config-driven map renderer. A map is described entirely by an entry in
// maps.json, so new maps need a data file and a config entry, not new code.
//
// Map entry:
//   id       used in the URL: map.html?map=<id>
//   title    heading; may use {placeholders}
//   data     URL of a JSON file
//   items    name of the array inside that file (omit if the file is the array)
//   label    popup heading template, e.g. "{number} {name}"
//   details  popup lines (templates); empty lines are dropped
//   link     optional URL template for the popup heading
//   noun     what the points are called, e.g. "teams"
//   layers   [{ name, color, where, hidden }] — each item goes in the first
//            layer whose `where` matches. `where` maps field -> true/false
//            (has a value / doesn't), a value, or a list of allowed values.
//
// Every item needs numeric `lat` and `lon`; items without them are counted
// and reported but not drawn. {placeholders} read from the item first, then
// from top-level values in the data file (such as `season`).
//
// Requires Leaflet and Leaflet.markercluster to be loaded as globals.

const fill = (template, item, file) =>
  String(template ?? '')
    .replace(/\{(\w+)\}/g, (_, k) => item?.[k] ?? file?.[k] ?? '')
    .split(', ')
    .filter((part) => part.trim()) // tidy "City, , Country"
    .join(', ')
    .trim();

function matches(item, where = {}) {
  return Object.entries(where).every(([field, want]) => {
    const have = item[field];
    if (typeof want === 'boolean') return Boolean(have) === want;
    if (Array.isArray(want)) return want.includes(have);
    return have === want;
  });
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function popupFor(item, config, file) {
  const label = fill(config.label, item, file) || '(unnamed)';
  const url = config.link ? fill(config.link, item, file) : '';
  const head = el('b');
  head.append(/^https?:\/\//.test(url) ? el('a', { href: url, textContent: label, rel: 'noopener' }) : label);
  const box = el('div', { className: 'popup' }, head);
  for (const line of config.details ?? []) {
    const text = fill(line, item, file);
    if (text) box.append(el('div', { textContent: text }));
  }
  return box;
}

export async function renderMap({ mapEl, legendEl, noteEl, config, tiles }) {
  const res = await fetch(config.data, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${config.data}`);
  const file = await res.json();
  const items = config.items ? file[config.items] : file;
  if (!Array.isArray(items)) throw new Error(`No list of ${config.noun ?? 'items'} in ${config.data}`);

  const map = L.map(mapEl, { worldCopyJump: true, preferCanvas: true }).setView([25, 0], 2);
  L.tileLayer(tiles.url, { attribution: tiles.attribution, maxZoom: tiles.maxZoom ?? 18 }).addTo(map);
  const cluster = L.markerClusterGroup({ maxClusterRadius: 40, showCoverageOnHover: false }).addTo(map);

  const layers = (config.layers ?? [{ name: config.noun ?? 'Items', color: '#0d6efd' }]).map((l) => ({ ...l, markers: [], unplaced: 0 }));
  for (const item of items) {
    const layer = layers.find((l) => matches(item, l.where));
    if (!layer) continue;
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) { layer.unplaced++; continue; }
    const marker = L.circleMarker([item.lat, item.lon], {
      radius: 7, color: '#fff', weight: 2, fillColor: layer.color, fillOpacity: 0.9,
    });
    marker.bindPopup(() => popupFor(item, config, file), { maxWidth: 280 });
    marker.bindTooltip(fill(config.label, item, file));
    layer.markers.push(marker);
  }

  const noun = config.noun ?? 'items';
  function refresh() {
    cluster.clearLayers();
    const shown = layers.filter((l) => !l.hidden);
    cluster.addLayers(shown.flatMap((l) => l.markers));
    const unplaced = shown.reduce((n, l) => n + l.unplaced, 0);
    noteEl.textContent = unplaced
      ? `${unplaced} ${noun} are not shown because their location could not be placed on the map.`
      : '';
  }

  legendEl.replaceChildren(...layers.map((layer) => {
    const box = el('input', { type: 'checkbox', checked: !layer.hidden });
    box.addEventListener('change', () => { layer.hidden = !box.checked; refresh(); });
    const swatch = el('span', { className: 'swatch' });
    swatch.style.background = layer.color;
    return el('label', {}, box, swatch, layer.name,
      el('span', { className: 'count', textContent: `(${layer.markers.length})` }));
  }));

  refresh();
  const visible = layers.filter((l) => !l.hidden).flatMap((l) => l.markers);
  if (visible.length) map.fitBounds(L.latLngBounds(visible.map((m) => m.getLatLng())).pad(0.1), { maxZoom: 6 });
  return { map, file, title: fill(config.title, null, file) };
}
