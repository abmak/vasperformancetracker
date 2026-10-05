import { useState } from 'react';
import { MapPin, Loader2, RefreshCw, X, Crosshair, AlertCircle, Navigation } from 'lucide-react';

/**
 * Reverse geocode a position against Nominatim (OpenStreetMap).
 *
 * Runs in the operator's browser — the phone that took the GPS fix — because
 * the VPS has no outbound HTTPS, and Nominatim allows cross-origin calls.
 * Low volume (one call per registration), which fits their usage policy.
 */
export async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&accept-language=en`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('reverse geocoding failed');
  return res.json();
}

/** Pick the most specific settlement Nominatim offers for a position. */
export function addressCity(a) {
  return a.city || a.town || a.village || a.municipality || a.county || a.state || '';
}

/** The street-level part: road + house number, falling back to the area. */
export function addressStreet(a) {
  return [a.road, a.house_number].filter(Boolean).join(' ') || a.neighbourhood || a.suburb || '';
}

/**
 * GPS location capture for retailer records.
 *
 * Asks the operator to share their device position (the phone they are
 * standing on at the shop) and keeps it alongside the free-text address.
 * The position is then reverse-geocoded to country / city / street, which
 * the form saves as structured fields and uses to fill the location column.
 * Capture is optional: the form is usable when the browser refuses, though
 * the button nudges toward granting permission.
 *
 * Shared by Single Registration and the Entity Registry's edit modal, so a
 * retailer captured either way lands on the GPS map the same way.
 */
export function LocationCapture({ value, onChange }) {
  const [status, setStatus] = useState('idle'); // idle | locating | ok | error | denied | insecure
  const [errorMsg, setErrorMsg] = useState('');
  const [address, setAddress] = useState(null); // {country, city, street, composed}
  const [addrStatus, setAddrStatus] = useState('idle'); // idle | resolving | ok | failed

  const locate = () => {
    setErrorMsg('');
    if (!('geolocation' in navigator)) {
      setStatus('error');
      setErrorMsg('This browser does not support location sharing.');
      return;
    }
    // Geolocation needs a secure context. The app is served over plain HTTP on
    // the VPS, so localhost dev works but the live site must opt in to the
    // browser's one exception for the host itself.
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      setStatus('insecure');
      setErrorMsg('Location sharing needs HTTPS. The page is currently served over plain HTTP.');
      return;
    }
    setStatus('locating');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const gps = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null,
          capturedAt: new Date().toISOString(),
        };
        onChange(gps);
        setStatus('ok');

        // Resolve the position into a readable address (country, city, street).
        setAddrStatus('resolving');
        try {
          const j = await reverseGeocode(gps.latitude, gps.longitude);
          const a = j.address || {};
          const country = a.country || '';
          const city = addressCity(a);
          const street = addressStreet(a);
          const composed = [street, city, country].filter(Boolean).join(', ')
            || (j.display_name || '').split(',').slice(0, 3).join(', ').trim();
          const resolved = { country, city, street, composed };
          setAddress(resolved);
          setAddrStatus('ok');
          onChange({ ...gps, address: resolved });
        } catch {
          setAddrStatus('failed');
        }
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatus('denied');
          setErrorMsg('Permission denied. Allow location access for this site in your browser settings, then try again.');
        } else if (err.code === err.TIMEOUT) {
          setStatus('error');
          setErrorMsg('Getting a position took too long. Move to an open area and retry.');
        } else {
          setStatus('error');
          setErrorMsg(err.message || 'Could not determine your position.');
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  const accuracyLabel = (m) => (!m && m !== 0 ? null : m < 10 ? 'high' : m < 50 ? 'fair' : 'low');

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        Retailer GPS Location
      </label>
      {value ? (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-emerald-200 bg-emerald-50">
          <MapPin size={15} className="text-emerald-600 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-mono font-medium text-gray-900">
              {value.latitude.toFixed(6)}, {value.longitude.toFixed(6)}
            </p>
            <p className="text-[11px] text-gray-600 mt-0.5">
              {value.capturedAt ? 'Captured just now' : 'Previously captured'}
              {value.accuracy != null && ` · ±${Math.round(value.accuracy)}m (${accuracyLabel(value.accuracy)} accuracy)`}
            </p>
            {addrStatus === 'resolving' && (
              <p className="text-[11px] text-gray-500 mt-1 flex items-center gap-1">
                <Loader2 size={11} className="animate-spin" />
                Resolving address…
              </p>
            )}
            {addrStatus === 'ok' && address && (
              <p className="text-[11px] text-emerald-700 mt-1 font-medium" title={address.composed}>
                {address.composed || 'Address resolved'}
              </p>
            )}
            {addrStatus === 'failed' && (
              <p className="text-[11px] text-amber-600 mt-1">
                Could not resolve a street address — the coordinates are still saved.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={locate}
            disabled={status === 'locating'}
            className="p-1 text-gray-400 hover:text-emerald-700 rounded"
            title="Re-capture position"
          >
            {status === 'locating'
              ? <Loader2 size={14} className="animate-spin" />
              : <RefreshCw size={14} />}
          </button>
          <button
            type="button"
            onClick={() => { onChange(null); setStatus('idle'); setAddress(null); setAddrStatus('idle'); setErrorMsg(''); }}
            className="p-1 text-gray-400 hover:text-gray-700 rounded"
            title="Remove location"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={locate}
          disabled={status === 'locating'}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 border border-dashed border-gray-300 rounded-lg text-sm font-medium text-gray-600 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700 transition disabled:opacity-60"
        >
          {status === 'locating' ? (
            <>
              <Loader2 size={15} className="animate-spin" />
              Getting your location…
            </>
          ) : (
            <>
              <Crosshair size={15} />
              Use my current location
            </>
          )}
        </button>
      )}
      {(status === 'denied' || status === 'error' || status === 'insecure') && (
        <p className="text-[11px] text-rose-600 mt-1 flex items-start gap-1">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </p>
      )}
      {!value && status !== 'locating' && (
        <p className="text-[11px] text-gray-400 mt-1 flex items-start gap-1">
          <Navigation size={12} className="shrink-0 mt-0.5" />
          The browser will ask to turn location on — stand at or near the shop for the exact spot.
        </p>
      )}
    </div>
  );
}
