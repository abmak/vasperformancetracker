import React, { useState, useEffect, useMemo, useRef } from 'react';
import { channelAPI } from '../services/api';
import {
  UserPlus, Loader2, CheckCircle, CheckCircle2, Search, X,
  Building2, Layers, Store, AlertCircle, ShieldCheck, Camera,
  Phone, MapPin, Building, FileText, Sparkles, RefreshCw, Upload, Image as ImageIcon,
} from 'lucide-react';
import toast from 'react-hot-toast';
import ManagerPhoto from '../components/channel/ManagerPhoto';
import { LocationCapture } from '../components/channel/LocationCapture';
import { fileToBase64 } from '../utils/helpers';

/**
 * Single Registration.
 *
 * Mirrors the batch workbook column contracts of the IDC hierarchy. Pick the
 * level first — Distributor, Sub-Distributor or Retailer — and the form shows
 * exactly the columns that level's sheet carries:
 *
 *   Distributor      Distributor Name | Mobile | Status | Distributor Region |
 *                    Air Time Type. No Existing Business and no National/Fayda
 *                    ID — a Distributor has no business or personal compliance
 *                    data of its own in the IDC model.
 *   Sub-Distributor  … and the Distributor it belongs to. No Existing Business,
 *                    no Geographical Domain and no National/Fayda ID — a
 *                    Sub-Distributor has no territory or business of its own in
 *                    the IDC model.
 *   Retailer         … + Existing Business, Geographical Domain, the Sub
 *                    Distributor it belongs to, plus three optional compliance
 *                    columns: TIN, Location and National/Fayda ID
 *
 * Uplines are chosen from a **closed list** of already-registered users, never
 * typed in: the registry is the single source of truth for the chain, and the
 * form pulls the selected upline's whole profile (mobile, region, business) from
 * it. Picking a Sub-Distributor also resolves its own Distributor, so the chain
 * stays consistent.
 */

const LEVELS = [
  {
    level: 1, key: 'distributor', name: 'Distributor', icon: Building2,
    nameLabel: 'Distributor Name', namePlaceholder: 'e.g., Ebyan Communication',
    // No Existing Business at this level — a Distributor has no business of
    // its own in the IDC model; the region it trades in is what identifies it.
    businessLabel: null, geoLabel: 'Distributor Region',
    geoPlaceholder: 'e.g., EER, SR, SSWR',
    blurb: 'Top of the chain. Holds the sub-distributors and retailers below it.',
  },
  {
    level: 2, key: 'sub_distributor', name: 'Sub-Distributor', icon: Layers,
    nameLabel: 'Sub Distributor Name', namePlaceholder: 'e.g., Nuuro Ahmed Mohamed',
    // No Existing Business and no Geographical Domain at this level — a
    // Sub-Distributor has no territory or business of its own in the IDC
    // model; the areas its retailers trade in live on the Retailer rows.
    businessLabel: null, geoLabel: null,
    geoPlaceholder: '',
    blurb: 'Belongs to one Distributor, and carries the retailers below it.',
  },
  {
    level: 3, key: 'retailer', name: 'Retailer', icon: Store,
    nameLabel: 'Retailer Name', namePlaceholder: 'e.g., Hoodo geele Abane',
    businessLabel: 'Retailer Existing Business', geoLabel: 'Retailer Geographical Domain',
    geoPlaceholder: 'e.g., Hargele, Kebribeyah',
    blurb: 'Belongs to a Sub-Distributor, under a Distributor.',
  },
];

const BUSINESS_SUGGESTIONS = ['super market', 'Shopes', 'Open Market', 'Kiosk', 'Wholesale'];
const PRODUCT_SUGGESTIONS = ['EVD', 'eTopUP'];

const emptyForm = {
  user_name: '',
  mobile_number: '',
  status: 'Active',
  geo_domain_raw: '',
  business_type: '',
  parent_mobile: '',
  owner_mobile: '',
  product: 'EVD',
  // Available Balance removed — balance is no longer tracked.
  notes: '',
  // Retailer compliance details
  tin: '',
  location: '',
  national_id: '',
  woreda: '',
  sub_city: '',
  house_no: '',
  trade_name: '',
  photo_keywords: '',
};

/**
 * A closed-list picker for an upline.
 *
 * The registry carries thousands of Sub-Distributors, so this is a filterable
 * combobox rather than a <select>: you can only ever land on a registered user,
 * and the selection reports the whole profile back to the form.
 */
function UplinePicker({
  label, hint, options, value, onChange, loading, placeholder, accent, emptyMessage,
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  const selected = useMemo(
    () => options.find((o) => o.mobile_number === value) || null,
    [options, value]
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter((o) => (
        `${o.user_name} ${o.mobile_number} ${o.geo_domain_raw || ''} ${o.business_type || ''}`
          .toLowerCase()
          .includes(q)
      ))
      : options;
    return list.slice(0, 40);
  }, [options, query]);

  // Close the dropdown when the click lands outside the picker.
  useEffect(() => {
    function onDocClick(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  return (
    <div ref={boxRef} className="relative">
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>

      {selected ? (
        <div className={`flex items-start gap-2 px-3 py-2 rounded-lg border ${accent.border} ${accent.bg}`}>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 truncate">{selected.user_name}</p>
            <p className="text-[11px] text-gray-600 font-mono">{selected.mobile_number}</p>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {[selected.category_label, selected.geo_domain_raw, selected.business_type]
                .filter(Boolean).join(' · ') || 'No further profile on file'}
              {selected.downstream_entities > 0 && ` · ${selected.downstream_entities} downstream`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => { onChange(''); setQuery(''); }}
            className="p-1 text-gray-400 hover:text-gray-700 rounded"
            title="Clear selection"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={query}
              disabled={loading}
              onFocus={() => setOpen(true)}
              onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
              placeholder={loading ? 'Loading registered users…' : placeholder}
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          {open && (
            <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
              {matches.length === 0 ? (
                <p className="px-3 py-3 text-xs text-gray-500">
                  {loading ? 'Loading…' : emptyMessage}
                </p>
              ) : matches.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => { onChange(o.mobile_number, o); setOpen(false); setQuery(''); }}
                  className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-50 last:border-0"
                >
                  <p className="text-sm text-gray-800 truncate">{o.user_name}</p>
                  <p className="text-[11px] text-gray-500">
                    <span className="font-mono">{o.mobile_number}</span>
                    {o.geo_domain_raw ? ` · ${o.geo_domain_raw}` : ''}
                    {o.business_type ? ` · ${o.business_type}` : ''}
                  </p>
                </button>
              ))}
              {matches.length === 40 && (
                <p className="px-3 py-2 text-[11px] text-gray-400">Narrow the search to see more…</p>
              )}
            </div>
          )}
        </>
      )}

      {hint && <p className="text-[11px] text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

export default function ChannelSingleImport() {
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [level, setLevel] = useState(3);
  const [form, setForm] = useState(emptyForm);
  const [result, setResult] = useState(null);

  const [distributors, setDistributors] = useState([]);
  const [subDistributors, setSubDistributors] = useState([]);
  const [optionsLoading, setOptionsLoading] = useState(true);

  // TIN Verification state
  const [tinVerifying, setTinVerifying] = useState(false);
  const [tinData, setTinData] = useState(null);
  const [tinError, setTinError] = useState(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoTimestamp, setPhotoTimestamp] = useState(Date.now());
  const photoInputRef = useRef(null);
  // GPS position captured for a retailer, kept outside `form` so the
  // structured payload goes to the API verbatim.
  const [gps, setGps] = useState(null);

  // A resolved GPS position fills two columns, both fill-if-empty so nothing
  // the operator typed (or an earlier source provided) is ever clobbered:
  //   Location / Address  ← the composed "street, city, country" string
  //   Geographical Domain ← the resolved city
  // Removing the GPS pin never deletes what was written — it is the form's
  // text now. Functional updates read the previous state, so a fast capture
  // right after an edit cannot work from stale field values.
  function handleGps(next) {
    setGps(next);
    if (next?.address) {
      setForm((prev) => ({
        ...prev,
        location: prev.location.trim()
          ? prev.location
          : (next.address.composed || '').slice(0, 255),
        geo_domain_raw: prev.geo_domain_raw.trim()
          ? prev.geo_domain_raw
          : (next.address.city || ''),
      }));
    }
  }

  async function handlePhotoUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Please select a valid image file (JPG or PNG)');
      return;
    }
    const currentTin = form.tin || tinData?.tin;
    if (!currentTin) {
      toast.error('Please enter a TIN before uploading photo');
      return;
    }

    setPhotoUploading(true);
    try {
      const photoBase64 = await fileToBase64(file);
      await channelAPI.uploadPhoto({
        tin: currentTin,
        photo_base64: photoBase64,
        content_type: file.type,
      });
      toast.success('Manager photo uploaded successfully');
      setPhotoTimestamp(Date.now());
      setForm(prev => ({ ...prev, photo_keywords: 'custom upload' }));
    } catch (err) {
      toast.error('Failed to upload photo: ' + (err.message || 'Unknown error'));
    } finally {
      setPhotoUploading(false);
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  }

  async function handleVerifyTin() {
    const raw = String(form.tin || '').trim().replace(/\D/g, '');
    if (!raw || raw.length < 8) {
      toast.error('Enter a valid 10-digit TIN number to verify');
      return;
    }
    setTinVerifying(true);
    setTinError(null);
    setTinData(null);
    try {
      const res = await channelAPI.verifyTin(raw);
      if (res && res.found) {
        setTinData(res);
        toast.success(`TIN Verified: ${res.trade_name || res.tin}`);
        // Populate and sync form fields
        setForm((prev) => {
          const next = { ...prev };
          if (res.trade_name) next.user_name = res.trade_name;
          if (res.mobile_phone) {
            let m = res.mobile_phone;
            if (m.startsWith('0')) m = m.slice(1);
            if (!next.mobile_number) next.mobile_number = m;
          }
          // Parish → Geographical Domain, eTrade address → Location. Both are
          // fill-if-empty: a Geographical Domain or address already derived
          // from the operator's reverse-geocoded GPS position (or typed by
          // hand) must never be replaced by the registry's copy.
          if ((res.parish_name || res.geo_domain) && !next.geo_domain_raw) {
            next.geo_domain_raw = res.parish_name || res.geo_domain;
          }
          if (res.location && !next.location) next.location = res.location;
          next.tin = res.tin || raw;
          next.woreda = res.woreda || '';
          next.sub_city = res.sub_city || '';
          next.house_no = res.house_no || '';
          next.trade_name = res.trade_name || '';
          next.photo_keywords = res.photo?.keywords || '';
          return next;
        });
      } else {
        const msg = res?.message || 'TIN not found in eTrade / Ministry of Revenue database';
        setTinError(msg);
        toast.error(msg);
      }
    } catch (err) {
      const msg = err.message || 'Verification failed';
      setTinError(msg);
      toast.error('TIN Verification failed: ' + msg);
    } finally {
      setTinVerifying(false);
    }
  }

  function handleClearTinData() {
    setTinData(null);
    setTinError(null);
  }

  async function loadUplines() {
    setOptionsLoading(true);
    const [d, sd] = await Promise.allSettled([
      channelAPI.getEntityOptions({ level: 1, domain: 'IDC' }),
      channelAPI.getEntityOptions({ level: 2, domain: 'IDC' }),
    ]);
    if (d.status === 'fulfilled') setDistributors(d.value.options || []);
    if (sd.status === 'fulfilled') setSubDistributors(sd.value.options || []);
    setOptionsLoading(false);
  }

  useEffect(() => {
    channelAPI.getMeta()
      .then((d) => { setMeta(d); setLoading(false); })
      .catch(() => setLoading(false));
    loadUplines();
  }, []);

  const spec = LEVELS.find((l) => l.level === level) || LEVELS[2];

  // The level decides the category, so there is no Category dropdown to get wrong.
  const category = useMemo(
    () => (meta?.categories || []).find(
      (c) => c.domain_code === 'IDC' && Number(c.level) === level
    ) || null,
    [meta, level]
  );

  const geoOptions = (meta?.geo_values || []).map((g) => g.value).filter(Boolean);

  function handleChange(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function switchLevel(next) {
    setLevel(next);
    setResult(null);
    // The uplines a level requires change with it, so drop what no longer applies.
    setForm((prev) => ({
      ...prev,
      parent_mobile: next === 3 ? prev.parent_mobile : '',
      owner_mobile: next === 3 ? prev.owner_mobile : (next === 2 ? prev.owner_mobile : ''),
    }));
  }

  // Picking a Sub-Distributor also resolves the Distributor above it, from the
  // registry rather than from the operator.
  function handleParentChange(mobile, option) {
    setForm((prev) => {
      const next = { ...prev, parent_mobile: mobile };
      const ownerMobile = option?.owner_mobile_of_owner || null;
      if (mobile && ownerMobile) next.owner_mobile = ownerMobile;
      if (!mobile) next.owner_mobile = '';
      return next;
    });
  }

  // The workbook always carries a 9-digit local mobile; normalise as the user types.
  function handleMobile(value) {
    let s = String(value).replace(/[^\d+]/g, '').replace(/^\+/, '');
    if (s.startsWith('251') && s.length >= 12) s = s.slice(-9);
    else if (s.startsWith('0') && s.length === 10) s = s.slice(1);
    handleChange('mobile_number', s.slice(0, 15));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setResult(null);

    if (!form.user_name.trim()) { toast.error(`${spec.name} Name is required`); return; }
    if (String(form.mobile_number).replace(/\D/g, '').length < 9) {
      toast.error('Mobile Number must be a 9-digit local number (e.g., 978858396)');
      return;
    }
    if (!category) { toast.error('The IDC category for this level is missing — check the channel setup'); return; }
    if (level === 2 && !form.owner_mobile) { toast.error('Select the Distributor this Sub-Distributor belongs to'); return; }
    if (level === 3 && !form.owner_mobile) { toast.error('Select the Distributor this Retailer belongs to'); return; }
    if (level === 3 && !form.parent_mobile) { toast.error('Select the Sub Distributor this Retailer belongs to'); return; }

    setSaving(true);
    try {
      const data = await channelAPI.createEntity({
        ...form,
        category_code: category.code,
        user_name: form.user_name.trim().replace(/\s+/g, ' '),
        // The TIN was verified against eTrade in this session (tinData is set
        // only after a found verdict, and cleared the moment the TIN field is
        // edited), so the new record is born verified. The backend accepts
        // only true — a payload can never stamp a not-verified verdict.
        ...(tinData ? { tin_verified: true } : {}),
        ...(level === 3 && gps ? {
          latitude: gps.latitude,
          longitude: gps.longitude,
          location_accuracy: gps.accuracy,
          ...(gps.address ? {
            addr_country: gps.address.country,
            addr_city: gps.address.city,
            addr_street: gps.address.street,
          } : {}),
        } : {}),
      });
      setResult({ ...data, level });
      toast.success(`${spec.name} registered`);
      setForm({ ...emptyForm });
      setGps(null);
      // The verified-TIN session belongs to this submission only — the next
      // registration must verify its own TIN, or it would inherit this
      // record's verified badge without ever being checked.
      handleClearTinData();
      setPhotoTimestamp(Date.now());
      // A new Sub-Distributor or Distributor should be selectable immediately.
      loadUplines();
    } catch (err) {
      toast.error('Registration failed: ' + err.message);
    }
    setSaving(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  const selectedParent = subDistributors.find((o) => o.mobile_number === form.parent_mobile) || null;
  const selectedOwner = distributors.find((o) => o.mobile_number === form.owner_mobile) || null;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Single Registration</h1>
        <p className="text-sm text-gray-500 mt-1">
          Register one IDC channel user with the same columns as the batch workbook for its level.
        </p>
      </div>

      {/* ── Level selector ───────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Registration Type</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {LEVELS.map((l) => {
            const Icon = l.icon;
            const active = l.level === level;
            return (
              <button
                key={l.level}
                type="button"
                onClick={() => switchLevel(l.level)}
                className={
                  'flex items-start gap-3 p-3 rounded-lg border text-left transition ' +
                  (active
                    ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                    : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50')
                }
              >
                <Icon size={18} className={active ? 'text-blue-600 mt-0.5' : 'text-gray-400 mt-0.5'} />
                <span>
                  <span className={'block text-sm font-medium ' + (active ? 'text-blue-800' : 'text-gray-800')}>
                    {l.name}
                  </span>
                  <span className="block text-[11px] text-gray-500 mt-0.5">{l.blurb}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-gray-400 mt-3">
          Category: <span className="font-medium text-gray-600">{category ? `${category.name} (Level ${category.level}) · ${category.code}` : 'not configured'}</span>
        </p>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            {spec.name} Details
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Mobile Number */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {spec.level === 1 ? 'Distributor' : spec.level === 2 ? 'Sub Distributor' : 'Retailer'} Mobile Number *
              </label>
              <input
                type="text" inputMode="numeric" value={form.mobile_number}
                onChange={(e) => handleMobile(e.target.value)}
                placeholder="e.g., 978858396"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <p className="text-[11px] text-gray-400 mt-1">9-digit local number. +251… and leading-0 forms are accepted.</p>
            </div>

            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{spec.nameLabel} *</label>
              <input
                type="text" value={form.user_name}
                onChange={(e) => handleChange('user_name', e.target.value)}
                placeholder={spec.namePlaceholder}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Existing business — Distributor and Sub-Distributor sheets no
                longer carry it; only the Retailer does. */}
            {spec.businessLabel && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{spec.businessLabel}</label>
                <input
                  type="text" list="channel-business-options" value={form.business_type}
                  onChange={(e) => handleChange('business_type', e.target.value)}
                  placeholder="e.g., super market, Shopes, Open Market"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <datalist id="channel-business-options">
                  {BUSINESS_SUGGESTIONS.map((b) => <option key={b} value={b} />)}
                </datalist>
              </div>
            )}

            {/* Status */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">User Status</label>
              <select
                value={form.status}
                onChange={(e) => handleChange('status', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="Active">Active</option>
                <option value="Canceled">Canceled</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>

            {/* Geography — hidden on the Sub-Distributor level: a
                Sub-Distributor has no territory of its own. */}
            {spec.geoLabel && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{spec.geoLabel}</label>
                <input
                  type="text" list="channel-geo-options" value={form.geo_domain_raw}
                  onChange={(e) => handleChange('geo_domain_raw', e.target.value)}
                  placeholder={spec.geoPlaceholder}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <datalist id="channel-geo-options">
                  {geoOptions.map((g) => <option key={g} value={g} />)}
                </datalist>
                <p className="text-[11px] text-gray-400 mt-1">
                  {geoOptions.length > 0 ? `${geoOptions.length} areas already in use — start typing to match one` : 'Free text place name'}
                </p>
              </div>
            )}

            {/* Air time type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Air Time Type</label>
              <input
                type="text" list="channel-product-options" value={form.product}
                onChange={(e) => handleChange('product', e.target.value)}
                placeholder="EVD"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <datalist id="channel-product-options">
                {PRODUCT_SUGGESTIONS.map((p) => <option key={p} value={p} />)}
              </datalist>
            </div>
          </div>

          {/* ── Retailer-only compliance details & TIN Verification ─── */}
          {level === 3 && (
            <div className="mt-5 pt-5 border-t border-gray-100">
              <div className="flex items-center justify-between gap-3 mb-1">
                <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wider flex items-center gap-1.5">
                  <ShieldCheck size={14} className="text-emerald-600" />
                  Retailer Verification & Details
                </h4>
                {tinData && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 text-emerald-800 border border-emerald-200">
                    <CheckCircle2 size={11} className="text-emerald-600" />
                    eTrade / MoR Verified
                  </span>
                )}
              </div>
              <p className="text-[11px] text-gray-400 mb-3">
                Verify the retailer's TIN against the national eTrade & Ministry of Revenue registry to automatically populate company name, phone, sub-city, woreda, and house number.
              </p>

              <div className="space-y-4">
                {/* TIN Input row with Verify Button */}
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5">
                  <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                    Retailer TIN (Tax Identification Number)
                  </label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input
                        type="text"
                        value={form.tin}
                        onChange={(e) => {
                          handleChange('tin', e.target.value);
                          if (tinData && e.target.value !== tinData.tin) {
                            setTinData(null);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleVerifyTin();
                          }
                        }}
                        placeholder="e.g., 0097598443 or 0041234567"
                        className="w-full pl-3 pr-8 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                      />
                      {form.tin && (
                        <button
                          type="button"
                          onClick={() => {
                            handleChange('tin', '');
                            handleClearTinData();
                          }}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={handleVerifyTin}
                      disabled={tinVerifying || !form.tin?.trim()}
                      className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-xs font-semibold rounded-lg shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                    >
                      {tinVerifying ? (
                        <>
                          <Loader2 size={13} className="animate-spin" />
                          Verifying...
                        </>
                      ) : (
                        <>
                          <Sparkles size={13} />
                          Verify TIN
                        </>
                      )}
                    </button>
                  </div>
                  <p className="text-[10px] text-gray-500 mt-1">
                    Direct integration with Ministry of Trade (eTrade) & Ministry of Revenue (MoR).
                  </p>

                  {tinError && (
                    <div className="mt-2.5 flex items-start gap-2 p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700">
                      <AlertCircle size={14} className="shrink-0 mt-0.5" />
                      <span>{tinError}</span>
                    </div>
                  )}
                </div>

                {/* Verified TIN Details Summary Card */}
                {tinData && (
                  <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-4 transition-all">
                    <div className="flex items-center justify-between mb-3 border-b border-emerald-200/80 pb-2.5">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-emerald-600 text-white flex items-center justify-center">
                          <CheckCircle2 size={14} />
                        </div>
                        <div>
                          <p className="text-xs font-bold text-emerald-950">Verified Business Record</p>
                          <p className="text-[10px] text-emerald-700 font-mono">TIN: {tinData.tin}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleVerifyTin}
                          className="flex items-center gap-1 text-[11px] text-emerald-700 hover:text-emerald-900 font-medium"
                          title="Re-fetch from eTrade"
                        >
                          <RefreshCw size={11} /> Re-verify
                        </button>
                        <button
                          type="button"
                          onClick={handleClearTinData}
                          className="text-[11px] text-gray-500 hover:text-gray-700 ml-1"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                      {/* Trade / Company Name */}
                      <div className="bg-white/80 p-2.5 rounded-lg border border-emerald-100 sm:col-span-2">
                        <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                          <Building size={11} className="text-emerald-600" />
                          Trade / Company Name
                        </p>
                        <p className="font-bold text-gray-900 text-sm mt-0.5">
                          {tinData.trade_name || '(Not specified)'}
                        </p>
                        {tinData.trade_name_amh && tinData.trade_name_amh !== tinData.trade_name && (
                          <p className="text-[11px] text-gray-600 mt-0.5 font-medium">
                            {tinData.trade_name_amh}
                          </p>
                        )}
                        {tinData.entity_type && (
                          <span className="inline-block mt-1 text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded font-medium">
                            {tinData.entity_type}
                          </span>
                        )}
                      </div>

                      {/* Mobile Phone */}
                      <div className="bg-white/80 p-2.5 rounded-lg border border-emerald-100">
                        <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                          <Phone size={11} className="text-emerald-600" />
                          Registered Mobile Phone
                        </p>
                        <p className="font-bold text-gray-900 font-mono text-sm mt-0.5">
                          {tinData.mobile_phone || '(None)'}
                        </p>
                        {tinData.email && (
                          <p className="text-[10px] text-gray-500 truncate mt-0.5">
                            {tinData.email}
                          </p>
                        )}
                      </div>

                      {/* Sub-City */}
                      <div className="bg-white/80 p-2.5 rounded-lg border border-emerald-100">
                        <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                          <MapPin size={11} className="text-emerald-600" />
                          Sub-City / City
                        </p>
                        <p className="font-semibold text-gray-800 mt-0.5">
                          {tinData.sub_city || '(Not specified)'}
                        </p>
                        {tinData.tax_centre && (
                          <p className="text-[10px] text-gray-500 truncate mt-0.5">
                            {tinData.tax_centre}
                          </p>
                        )}
                      </div>

                      {/* Woreda */}
                      <div className="bg-white/80 p-2.5 rounded-lg border border-emerald-100">
                        <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                          <MapPin size={11} className="text-emerald-600" />
                          Woreda
                        </p>
                        <p className="font-semibold text-gray-800 mt-0.5">
                          {tinData.woreda || '(Not specified)'}
                        </p>
                      </div>

                      {/* House Number */}
                      <div className="bg-white/80 p-2.5 rounded-lg border border-emerald-100">
                        <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1">
                          <Building2 size={11} className="text-emerald-600" />
                          House Number
                        </p>
                        <p className="font-semibold text-gray-800 font-mono mt-0.5">
                          {tinData.house_no || '(None)'}
                        </p>
                      </div>

                      {/* Photo Document Card with visual preview & upload action */}
                      <div className="bg-white p-3.5 rounded-xl border border-emerald-200 sm:col-span-2 lg:col-span-3 flex flex-col sm:flex-row items-start sm:items-center gap-4 shadow-xs">
                        <div className="relative w-20 h-20 rounded-xl overflow-hidden bg-slate-900 border-2 border-emerald-400 shadow-md shrink-0 flex items-center justify-center group">
                          <ManagerPhoto
                            tin={tinData.tin}
                            bust={photoTimestamp}
                            alt={tinData.trade_name || tinData.tin}
                            className="w-full h-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => photoInputRef.current?.click()}
                            className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-white text-[10px] font-medium cursor-pointer"
                            title="Click to upload custom manager photo"
                          >
                            <Camera size={16} />
                            <span>Change</span>
                          </button>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-800 bg-emerald-100 px-2.5 py-0.5 rounded-full border border-emerald-200">
                              <Camera size={12} className="text-emerald-700" />
                              Official Manager Photo Record
                            </span>
                            <span className="text-[10px] text-emerald-600 font-medium bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                              eTrade / MoR Attached
                            </span>
                          </div>
                          <p className="text-sm font-bold text-gray-900 mt-1">
                            {tinData.photo?.document_id ? `Document ID #${tinData.photo.document_id}` : `Verified Taxpayer Record`}
                          </p>
                          <p className="text-xs text-gray-500 font-mono truncate mt-0.5" title={tinData.photo?.keywords || ''}>
                            {tinData.photo?.keywords || `TIN: ${tinData.tin}`}
                          </p>
                          <div className="mt-2.5 flex items-center gap-2">
                            <input
                              type="file"
                              ref={photoInputRef}
                              accept="image/*"
                              className="hidden"
                              onChange={handlePhotoUpload}
                            />
                            <button
                              type="button"
                              onClick={() => photoInputRef.current?.click()}
                              disabled={photoUploading}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-100/70 hover:bg-emerald-100 border border-emerald-300 rounded-lg transition disabled:opacity-50 cursor-pointer shadow-2xs"
                            >
                              {photoUploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                              {photoUploading ? 'Uploading Photo...' : 'Upload / Replace Manager Photo'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* National ID & Location — Retailer-only compliance fields;
                    Distributors and Sub-Distributors don't carry them. */}
                {spec.level === 3 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Retailer National/Fayda ID (optional)
                    </label>
                    <input
                      type="text"
                      value={form.national_id}
                      onChange={(e) => handleChange('national_id', e.target.value)}
                      placeholder="e.g., 39012345678901"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <p className="text-[11px] text-gray-400 mt-1">National (Fayda) identification number.</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Retailer Street Address Information
                    </label>
                    <input
                      type="text"
                      value={form.location}
                      onChange={(e) => handleChange('location', e.target.value)}
                      placeholder="e.g., KIRKOS, WOREDA 10, House: NEW/15/B-17"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <p className="text-[11px] text-gray-400 mt-1">Sub-City, Woreda, Kebele, Landmark or House No.</p>
                  </div>

                  <div className="md:col-span-2">
                    <LocationCapture value={gps} onChange={handleGps} />
                  </div>
                </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Upline section: closed lists only ────────────────────────── */}
        {level > 1 && (
          <div className="border-t border-gray-100 pt-5">
            <div className="flex items-center justify-between gap-3 mb-1">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Upline — chosen from registered users
              </h3>
              <button
                type="button"
                onClick={loadUplines}
                className="text-[11px] text-blue-600 hover:text-blue-800 font-medium"
              >
                Refresh lists
              </button>
            </div>
            <p className="text-[11px] text-gray-400 mb-4">
              Uplines cannot be typed in: the registry holds the chain, so only already-registered users are offered.
              {level === 3 && ' Picking a Sub-Distributor fills in its Distributor automatically.'}
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {level === 3 && (
                <UplinePicker
                  label="Sub Distributor (immediate upline) *"
                  hint={selectedParent?.geo_domain_raw ? `On file in ${selectedParent.geo_domain_raw}` : null}
                  options={subDistributors}
                  value={form.parent_mobile}
                  onChange={handleParentChange}
                  loading={optionsLoading}
                  placeholder="Search Sub Distributors by name or mobile…"
                  emptyMessage="No Sub-Distributors registered yet for the IDC domain."
                  accent={{ border: 'border-emerald-200', bg: 'bg-emerald-50' }}
                />
              )}

              <UplinePicker
                label="Distributor (top of chain) *"
                hint={selectedOwner?.geo_domain_raw ? `Region on file: ${selectedOwner.geo_domain_raw}` : null}
                options={distributors}
                value={form.owner_mobile}
                onChange={(mobile) => handleChange('owner_mobile', mobile)}
                loading={optionsLoading}
                placeholder="Search Distributors by name or mobile…"
                emptyMessage="No Distributors registered yet for the IDC domain."
                accent={{ border: 'border-indigo-200', bg: 'bg-indigo-50' }}
              />
            </div>

            {/* The profile pulled from the registry, so nothing has to be retyped. */}
            {(selectedParent || selectedOwner) && (
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                {selectedParent && <ProfileCard title="Sub Distributor profile" option={selectedParent} />}
                {selectedOwner && <ProfileCard title="Distributor profile" option={selectedOwner} />}
              </div>
            )}

            {!optionsLoading && distributors.length === 0 && level >= 1 && (
              <p className="text-[11px] text-amber-700 mt-3 flex items-center gap-1">
                <AlertCircle size={11} /> No Distributor is registered yet — register one first, or import a distributor sheet.
              </p>
            )}
          </div>
        )}

        {/* ── Notes ──────────────────────────────────────────────────── */}
        <div className="border-t border-gray-100 pt-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
            <textarea
              value={form.notes}
              onChange={(e) => handleChange('notes', e.target.value)}
              rows={2} placeholder="Any additional notes..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            />
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit" disabled={saving}
            className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
            Register {spec.name}
          </button>
          <button
            type="button"
            onClick={() => { setForm({ ...emptyForm }); setGps(null); setResult(null); }}
            className="px-4 py-2.5 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition"
          >
            Clear
          </button>
        </div>
      </form>

      {result && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-3">
          <CheckCircle size={20} className="text-emerald-600" />
          <div>
            <p className="text-sm font-medium text-emerald-800">
              {(LEVELS.find((l) => l.level === result.level) || {}).name} registered
            </p>
            <p className="text-xs text-emerald-600">
              ID: {result.id}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ProfileCard({ title, option }) {
  const rows = [
    ['Category', option.category_label],
    ['Mobile', option.mobile_number],
    ['Region / Domain', option.geo_domain_raw],
    ['Existing business', option.business_type],
    ['Air time type', option.product],
    ['Downstream users', option.downstream_entities],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">{title}</p>
      <p className="text-sm font-medium text-gray-900 mb-1.5">{option.user_name}</p>
      <dl className="space-y-0.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline gap-2 text-[11px]">
            <dt className="text-gray-500 w-28 shrink-0">{k}</dt>
            <dd className="text-gray-800 font-medium truncate">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
