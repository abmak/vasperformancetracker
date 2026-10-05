import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import { Loader2, MapPin, AlertCircle, RefreshCw, X } from 'lucide-react';
import { channelAPI } from '../../services/api';
import 'leaflet/dist/leaflet.css';

/**
 * The two geographical maps of the IDC retailer network.
 *
 *   1. "By Area" — one bubble per Retailer Geographical Domain, sized by how
 *      many retailers trade there. The area names are place names, not
 *      coordinates, so each unique name is geocoded once against Nominatim
 *      (in the browser, throttled to their 1 req/s and cached in localStorage)
 *      and the bubble sits on the resolved spot.
 *
 *   2. "By GPS" — one dot per retailer that captured a position during single
 *      registration, at its exact coordinates. Fed by
 *      /api/channel/dashboard/gps-points.
 *
 * Both maps read OSM tiles client-side, so the VPS's network limits are
 * irrelevant — the operator's browser fetches the tiles.
 */

const AREA_GEO_CACHE_KEY = 'idc-area-geocode-v1';
const PALETTE = ['#15803d', '#0e7490', '#b45309', '#7c3aed', '#be185d', '#4d7c0f', '#1d4ed8', '#b91c1c', '#0f766e', '#a16207', '#6d28d9', '#047857'];

function loadAreaCache() {
  try { return JSON.parse(localStorage.getItem(AREA_GEO_CACHE_KEY) || '{}'); } catch { return {}; }
}
function saveAreaCache(cache) {
  try { localStorage.setItem(AREA_GEO_CACHE_KEY, JSON.stringify(cache)); } catch { /* best effort */ }
}
/** Drop cached misses so the next run retries them (used by the Refresh button). */
function clearFailedAreaCache() {
  const cache = loadAreaCache();
  let changed = false;
  for (const key of Object.keys(cache)) {
    if (!cache[key] || !cache[key].lat) { delete cache[key]; changed = true; }
  }
  if (changed) saveAreaCache(cache);
}

/** Throttled Nominatim geocoder for area names (≤1 req/s, cached forever). */
async function geocodeAreas(names, onProgress) {
  const cache = loadAreaCache();
  const resolved = {};
  // Names already in the cache are skipped whether they resolved or missed —
  // misses are stored as null so a dead name is not re-queried on every visit.
  const pending = names.filter((n) => !(n in cache));
  for (let i = 0; i < pending.length; i++) {
    const name = pending[i];
    onProgress({ done: i, total: pending.length, current: name });
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}, Ethiopia&countrycodes=et&format=json&limit=1&accept-language=en`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const hits = await res.json();
        if (hits && hits[0]) cache[name] = { lat: Number(hits[0].lat), lon: Number(hits[0].lon) };
        else cache[name] = null; // not on OpenStreetMap — don't ask again
      }
    } catch { /* one area failing just leaves it unplotted */ }
    await new Promise((r) => setTimeout(r, 1100)); // Nominatim usage policy: 1 req/s
  }
  onProgress({ done: pending.length, total: pending.length, current: '' });
  saveAreaCache(cache);
  for (const n of names) if (cache[n] && cache[n].lat) resolved[n] = cache[n];
  return resolved;
}

function FitBounds({ points }) {
  const map = useMap();
  const fittedFor = useRef('');
  useEffect(() => {
    const key = points.length + ':' + (points[0] ? points[0].lat.toFixed(3) : '');
    if (!points.length || fittedFor.current === key) return;
    fittedFor.current = key;
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lon], 13);
    } else {
      map.fitBounds(points.map((p) => [p.lat, p.lon]), { padding: [30, 30] });
    }
  }, [points, map]);
  return null;
}

function MapShell({ title, subtitle, loading, error, empty, onRetry, children, footer }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-gray-100 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
            <MapPin size={14} className="text-emerald-600" />
            {title}
          </h3>
          <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>
        </div>
        {onRetry && (
          <button onClick={onRetry} className="p-1.5 text-gray-400 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition" title="Refresh">
            <RefreshCw size={14} />
          </button>
        )}
      </div>
      <div className="relative h-[420px]">
        {loading && (
          <div className="absolute inset-0 z-[500] bg-white/80 flex items-center justify-center">
            <div className="text-center">
              <Loader2 size={22} className="animate-spin text-emerald-600 mx-auto mb-2" />
              <p className="text-xs text-gray-500">{typeof loading === 'string' ? loading : 'Loading…'}</p>
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-[500] bg-white/90 flex items-center justify-center">
            <div className="text-center max-w-xs px-4">
              <AlertCircle size={20} className="text-rose-500 mx-auto mb-2" />
              <p className="text-xs text-gray-600">{error}</p>
            </div>
          </div>
        )}
        {!loading && !error && empty ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-xs text-gray-400 px-6 text-center">{empty}</p>
          </div>
        ) : children}
      </div>
      {footer && <div className="px-4 py-2 border-t border-gray-100 text-[11px] text-gray-500">{footer}</div>}
    </div>
  );
}

/** Map 1 — one bubble per Geographical Domain, sized by retailer count. */
function AreaMap({ areas, onFocusArea }) {
  const [points, setPoints] = useState(null); // [{area, entities, lat, lon}]
  const [progress, setProgress] = useState(null); // {done, total, current}
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  // The parent passes a fresh array on every render, so the effect must key on
  // a stable primitive — the joined area names — or geocoding would restart
  // on every render and never finish.
  const namesRef = useRef([]);
  const areaKey = useMemo(() => {
    const list = (areas || []).filter((a) => a.area && a.area !== 'Unspecified').slice(0, 25);
    namesRef.current = list;
    return list.map((a) => a.area).join('|');
  }, [areas]);

  useEffect(() => {
    const list = namesRef.current;
    if (!areaKey) { setPoints([]); setError(''); setProgress(null); return undefined; }
    let cancelled = false;
    (async () => {
      setError('');
      setPoints(null);
      try {
        const geo = await geocodeAreas(list.map((n) => n.area), (p) => { if (!cancelled) setProgress(p); });
        if (cancelled) return;
        setPoints(list
          .filter((n) => geo[n.area])
          .map((n) => ({ area: n.area, entities: n.entities, lat: geo[n.area].lat, lon: geo[n.area].lon })));
      } catch (e) {
        if (!cancelled) setError('Could not reach the OpenStreetMap geocoder. Check your connection and retry.');
      }
    })();
    return () => { cancelled = true; };
  }, [areaKey, attempt]);

  const loadingLabel = progress
    ? `Locating areas… ${progress.done}/${progress.total}`
    : 'Locating areas…';

  return (
    <MapShell
      title="Retailers by Area — Geographical Domain"
      subtitle="One bubble per registered area, sized by how many retailers trade there. Click a bubble to zoom the GPS map to that area. Area names are resolved against OpenStreetMap."
      loading={points === null ? loadingLabel : false}
      error={error}
      onRetry={() => { clearFailedAreaCache(); setAttempt((a) => a + 1); }}
      empty={points && points.length === 0 ? 'No areas to map yet — retailers appear here once they carry a Geographical Domain.' : ''}
      footer={(() => {
        const done = points || [];
        const missing = points === null ? [] : namesRef.current.filter((n) => !done.some((p) => p.area === n.area)).map((n) => n.area);
        return `${done.length} of ${namesRef.current.length} areas located${missing.length ? ' — not found on OpenStreetMap: ' + missing.join(', ') : ''}${progress && progress.total ? ' (cached after the first visit)' : ''}`;
      })()}
    >
      {points && points.length > 0 && (
        <MapContainer center={[9.15, 40.49]} zoom={5} className="h-full w-full" scrollWheelZoom>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitBounds points={points} />
          {points.map((p, i) => (
            <CircleMarker
              key={p.area}
              center={[p.lat, p.lon]}
              radius={7 + Math.sqrt(Math.max(p.entities, 1)) * 2.2}
              pathOptions={{ color: '#065f46', fillColor: PALETTE[i % PALETTE.length], fillOpacity: 0.55, weight: 1.5 }}
            >
              <Popup>
                <b>{p.area}</b><br />{p.entities} retailer{p.entities === 1 ? '' : 's'}
                {onFocusArea && (
                  <div style={{ marginTop: 6 }}>
                    <button
                      type="button"
                      onClick={() => onFocusArea(p.area, p.entities)}
                      className="text-[11px] font-semibold text-emerald-700 hover:underline cursor-pointer"
                    >
                      Show on the GPS map →
                    </button>
                  </div>
                )}
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      )}
    </MapShell>
  );
}

/** Map 2 — one dot per retailer with captured GPS coordinates. */
function GpsMap({ focusArea, focusTotal, onClearFocus }) {
  const [points, setPoints] = useState(null);
  const [error, setError] = useState('');
  const load = async () => {
    setError('');
    try {
      const data = await channelAPI.getGpsPoints();
      setPoints(data.points || []);
    } catch (e) {
      setError('Failed to load retailer positions: ' + e.message);
    }
  };
  useEffect(() => { load(); }, []);

  // Focus mode: the area map hands over an area name, and this map narrows to
  // the retailers whose Geographical Domain (or reverse-geocoded city) matches
  // it — the click-through from “10 retailers in Addis Ababa” to the actual
  // distribution of those retailers inside the city.
  const focus = String(focusArea || '').trim().toLowerCase();
  const areaOf = (p) => String(p.geo_domain_raw || p.addr_city || '').trim().toLowerCase();
  const visible = points
    ? (focus
      ? points.filter((p) => {
        const a = areaOf(p);
        return Boolean(a) && (a === focus || a.includes(focus) || focus.includes(a));
      })
      : points)
    : null;

  return (
    <div id="retailers-gps-map">
      <MapShell
        title="Retailers by GPS Position"
        subtitle={focus
          ? `Zoomed to ${focusArea} — every captured position inside that area.`
          : 'Every retailer that shared its location during single registration, at its exact captured coordinates.'}
        loading={points === null}
        error={error}
        onRetry={load}
        empty={!focus && points && points.length === 0 ? 'No GPS positions captured yet — register a retailer with “Use my current location”, or add the position from a retailer’s edit form, and its dot appears here.' : ''}
        footer={`${(visible || []).length} retailer${(visible || []).length === 1 ? '' : 's'} with coordinates${focus ? ` in ${focusArea}` : ''}`}
      >
        {focus && (
          <div className="absolute top-2 left-2 right-2 z-[500] flex items-center justify-between gap-2 bg-white/95 border border-emerald-200 rounded-lg px-3 py-1.5 shadow-sm">
            <p className="text-[11px] text-gray-700 truncate">
              Focused on <b>{focusArea}</b> — {(visible || []).length} retailer{(visible || []).length === 1 ? '' : 's'} with captured coordinates
              {focusTotal != null ? ` (${focusTotal} in this area)` : ''}
            </p>
            <button
              onClick={onClearFocus}
              className="p-1 text-gray-400 hover:text-gray-700 rounded shrink-0"
              title="Show every area again"
            >
              <X size={13} />
            </button>
          </div>
        )}
        {visible && visible.length > 0 && (
          <MapContainer key={focus || 'all-points'} center={[9.15, 40.49]} zoom={6} className="h-full w-full" scrollWheelZoom>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <FitBounds points={visible.map((p) => ({ lat: p.latitude, lon: p.longitude }))} />
            {visible.map((p) => (
              <CircleMarker
                key={p.id}
                center={[p.latitude, p.longitude]}
                radius={6}
                pathOptions={{ color: '#065f46', fillColor: '#10b981', fillOpacity: 0.75, weight: 1.5 }}
              >
                <Popup>
                  <b>{p.user_name}</b><br />
                  {p.identifier_code ? `${p.identifier_code} · ` : ''}{p.mobile_number || ''}<br />
                  {p.geo_domain_raw || p.addr_city || '—'}<br />
                  <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                    {p.latitude.toFixed(6)}, {p.longitude.toFixed(6)}
                  </span>
                </Popup>
              </CircleMarker>
            ))}
          </MapContainer>
        )}
        {focus && visible && visible.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-xs text-gray-400 px-6 text-center">
              No captured coordinates in {focusArea} yet — open a retailer there and use
              “Use my current location” in the edit form, or capture it during registration.
            </p>
          </div>
        )}
      </MapShell>
    </div>
  );
}

export default function RetailerMaps({ areas }) {
  // The two maps are linked: clicking a bubble on the area map focuses the GPS
  // map on that area, so “10 retailers in Addis Ababa” turns into the actual
  // distribution of those retailers across the city.
  const [focusArea, setFocusArea] = useState(null);
  const [focusTotal, setFocusTotal] = useState(null);

  const focusOn = (area, total) => {
    setFocusArea(area);
    setFocusTotal(total ?? null);
    // The GPS panel is where the focus lands — bring it into view (the panels
    // stack on narrow screens).
    setTimeout(() => document.getElementById('retailers-gps-map')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
  };
  const clearFocus = () => { setFocusArea(null); setFocusTotal(null); };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <AreaMap areas={areas} onFocusArea={focusOn} />
      <GpsMap focusArea={focusArea} focusTotal={focusTotal} onClearFocus={clearFocus} />
    </div>
  );
}
