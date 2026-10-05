import React, { useState, useEffect, useRef } from 'react';
import { channelAPI } from '../../services/api';
import {
  Edit3, Trash2, AlertTriangle, AlertCircle, X, Camera, Upload, Loader2,
  ShieldCheck, Check, RefreshCw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import ManagerPhoto from './ManagerPhoto';
import { fileToBase64 } from '../../utils/helpers';
import { buildVerifyChoices } from '../../utils/verifyChoices';
import { LocationCapture } from './LocationCapture';

// Edit & Delete entity modals shared by Channel Reports (level tables) and the
// Channel Dashboard's Entity Registry — one behaviour, one place to fix it.

export function EditEntityModal({ isOpen, onClose, entity, onUpdated }) {
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(false);
  const [verifyingTin, setVerifyingTin] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoTimestamp, setPhotoTimestamp] = useState(Date.now());
  const photoInputRef = useRef(null);
  // TIN-verify consent flow: the official record, which fields the operator
  // ticked to replace, and whether the panel is open.
  const [verifyRes, setVerifyRes] = useState(null);
  const [verifyChoices, setVerifyChoices] = useState([]);
  const [replaceSel, setReplaceSel] = useState({});
  const [applyingVerify, setApplyingVerify] = useState(false);
  // GPS capture for retailer edits — the same widget Single Registration uses.
  // gpsTouched marks whether the operator changed the position in this edit;
  // the backend only rewrites coordinates when the payload carries them.
  const [gps, setGps] = useState(null);
  const [gpsTouched, setGpsTouched] = useState(false);

  useEffect(() => {
    if (entity) {
      setForm({
        user_name: entity.user_name || '',
        mobile_number: entity.mobile_number || '',
        status: entity.status || 'active',
        business_type: entity.business_type || '',
        product: entity.product || 'EVD',
        geo_domain_raw: entity.geo_domain_raw || '',
        tin: entity.tin || '',
        national_id: entity.national_id || '',
        location: entity.location || '',
        woreda: entity.woreda || '',
        sub_city: entity.sub_city || '',
        house_no: entity.house_no || '',
        trade_name: entity.trade_name || '',
        notes: entity.notes || '',
      });
      setPhotoTimestamp(Date.now());
      setVerifyRes(null);
      setVerifyChoices([]);
      setReplaceSel({});
      // A retailer saved with a position keeps it visible (and re-capturable):
      // capturedAt stays null so the widget reads “Previously captured”.
      setGps(entity.latitude != null && entity.longitude != null ? {
        latitude: Number(entity.latitude),
        longitude: Number(entity.longitude),
        accuracy: entity.location_accuracy_m != null ? Number(entity.location_accuracy_m) : null,
        capturedAt: null,
      } : null);
      setGpsTouched(false);
    }
  }, [entity]);

  if (!isOpen || !entity) return null;

  async function handlePhotoUploadInModal(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file (JPG or PNG)');
      return;
    }
    const currentTin = form.tin || entity.tin;
    if (!currentTin) {
      toast.error('This record has no TIN — verify a TIN first to attach a manager photo');
      return;
    }
    setPhotoUploading(true);
    try {
      const photoBase64 = await fileToBase64(file);
      await channelAPI.uploadPhoto({
        tin: currentTin,
        photo_base64: photoBase64,
        content_type: file.type,
        entity_id: entity.id,
      });
      toast.success('Manager photo updated successfully');
      setPhotoTimestamp(Date.now());
    } catch (err) {
      toast.error('Failed to upload photo: ' + (err.message || 'Error'));
    } finally {
      setPhotoUploading(false);
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  }

  async function handleVerifyTinInModal() {
    const raw = String(form.tin || '').trim().replace(/\D/g, '');
    if (!raw || raw.length < 8) {
      toast.error('Please enter a valid 10-digit TIN number');
      return;
    }
    setVerifyingTin(true);
    try {
      // Preview only — the official photo is NOT stored until the operator
      // consents to replacing it below.
      const res = await channelAPI.verifyTinPreview(raw);
      if (res && res.found) {
        toast.success(`TIN Verified: ${res.trade_name || raw}`);
        const choices = buildVerifyChoices(entity, form, res);
        setVerifyRes(res);
        setVerifyChoices(choices);
        // Nothing is ticked by default — replacement is explicit consent.
        setReplaceSel(Object.fromEntries(choices.map((c) => [c.field, false])));
        setPhotoTimestamp(Date.now());
      } else {
        setVerifyRes(null);
        setVerifyChoices([]);
        toast.error(res?.message || 'TIN not found in eTrade / Ministry of Revenue database');
      }
    } catch (err) {
      toast.error('TIN Verification failed: ' + err.message);
    } finally {
      setVerifyingTin(false);
    }
  }

  /** Apply exactly the ticked fields: the form is updated in place (the
   *  operator still sees — and can still edit — every value before saving the
   *  record) and the photo replace is executed through the entity verify
   *  endpoint with the same consent list. */
  async function handleApplyVerifiedFields() {
    const selected = verifyChoices.filter((c) => replaceSel[c.field]);
    if (!selected.length) {
      toast.error('Select at least one field to replace');
      return;
    }
    setApplyingVerify(true);
    try {
      const d = verifyRes || {};
      const fields = selected.map((c) => c.field);
      setForm((prev) => {
        const next = { ...prev };
        if (fields.includes('business_name') && d.trade_name) {
          next.trade_name = d.trade_name;
          next.user_name = d.trade_name;
        }
        if (fields.includes('phone') && d.mobile_phone) {
          let m = d.mobile_phone;
          if (m.startsWith('251')) m = `0${m.slice(3)}`;
          if (m.startsWith('0')) m = m.slice(1);
          next.mobile_number = m;
        }
        if (fields.includes('location')) {
          next.location = d.location || '';
          next.sub_city = d.sub_city || '';
          next.woreda = d.woreda || '';
          next.house_no = d.house_no || '';
        }
        if (fields.includes('geo_domain') && (d.parish_name || d.geo_domain)) {
          next.geo_domain_raw = d.parish_name || d.geo_domain;
        }
        return next;
      });
      if (fields.includes('photo')) {
        // Persist the official photo over whatever this TIN had — the custom
        // upload included, because the operator ticked it.
        await channelAPI.verifyEntityTin(entity.id, { fields: ['photo'], tin: d.tin || form.tin });
      }
      setPhotoTimestamp(Date.now());
      setVerifyRes(null);
      setVerifyChoices([]);
      setReplaceSel({});
      toast.success(
        fields.includes('photo') && fields.length === 1
          ? 'Manager photo replaced from the official record'
          : `Replaced ${fields.length} field${fields.length === 1 ? '' : 's'} — review and save the record`
      );
    } catch (err) {
      toast.error(err.message || 'Could not apply the selected fields');
    } finally {
      setApplyingVerify(false);
    }
  }

  /** GPS edits flow through here: the widget reports the raw capture, and —
   *  once Nominatim resolves it — the address parts on top. Address parts only
   *  ever fill blanks: an operator's own text is never overwritten. */
  function handleGpsEdit(next) {
    setGps(next);
    setGpsTouched(true);
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

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.user_name?.trim()) {
      toast.error('Name is required');
      return;
    }
    setLoading(true);
    try {
      // Coordinates ride along only when this edit touched them — and an
      // explicit removal sends nulls, which clears the stored fix server-side.
      const payload = { ...form };
      if (gpsTouched) {
        if (gps && gps.latitude != null && gps.longitude != null) {
          payload.latitude = gps.latitude;
          payload.longitude = gps.longitude;
          if (gps.accuracy != null) payload.location_accuracy = gps.accuracy;
          if (gps.address) {
            payload.addr_country = gps.address.country || null;
            payload.addr_city = gps.address.city || null;
            payload.addr_street = gps.address.street || null;
          }
        } else {
          payload.latitude = null;
          payload.longitude = null;
        }
      }
      await channelAPI.updateEntity(entity.id, payload);
      toast.success('Record updated successfully');
      if (onUpdated) onUpdated();
      onClose();
    } catch (err) {
      toast.error('Failed to update record: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-in fade-in overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-xl border border-gray-100 my-8">
        <div className="flex items-center justify-between pb-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
              <Edit3 size={20} />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900">
                Edit {entity.level === 1 ? 'Distributor' : entity.level === 2 ? 'Sub-Distributor' : 'Retailer'} Record
              </h3>
              <p className="text-xs text-gray-500 font-mono">Mobile: {entity.mobile_number} · ID: #{entity.id}</p>
            </div>
          </div>
          <button onClick={onClose} disabled={loading} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="py-4 space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          {/* Manager Photo Card with Upload Button — the photo comes from
              eTrade's Registration API during TIN verification, keyed by TIN.
              Offered for every level that carries a TIN (retailers included). */}
          {(form.tin || entity.tin) && (
          <div className="bg-gradient-to-r from-emerald-50 to-teal-50 p-3.5 rounded-xl border border-emerald-200 flex flex-col sm:flex-row items-center gap-3.5 shadow-2xs">
            <div className="relative w-16 h-16 rounded-xl overflow-hidden bg-slate-900 border-2 border-emerald-400 shadow-sm shrink-0 flex items-center justify-center group">
              <ManagerPhoto
                tin={form.tin || entity.tin}
                bust={photoTimestamp}
                alt={form.user_name || entity.user_name}
                className="w-full h-full object-cover"
              />
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-white text-[9px] font-medium cursor-pointer"
                title="Click to upload custom manager photo"
              >
                <Camera size={14} />
                <span>Upload</span>
              </button>
            </div>
            <div className="flex-1 min-w-0 text-center sm:text-left">
              <div className="flex items-center justify-center sm:justify-start gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">
                  <Camera size={11} className="text-emerald-700" />
                  Manager Photo
                </span>
                {entity.tin && (
                  <span className="text-[10px] font-mono text-emerald-700 font-semibold bg-white/80 px-1.5 py-0.5 rounded border border-emerald-200">
                    TIN: {entity.tin}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-700 font-medium mt-1 truncate">
                {form.trade_name || form.user_name || entity.user_name}
              </p>
              <div className="mt-1.5 flex items-center justify-center sm:justify-start gap-2">
                <input
                  type="file"
                  ref={photoInputRef}
                  accept="image/*"
                  className="hidden"
                  onChange={handlePhotoUploadInModal}
                />
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  disabled={photoUploading}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 bg-white hover:bg-emerald-100 border border-emerald-300 rounded-lg shadow-2xs transition disabled:opacity-50 cursor-pointer"
                >
                  {photoUploading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
                  {photoUploading ? 'Uploading...' : 'Upload / Change Photo'}
                </button>
              </div>
            </div>
          </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            {/* Name */}
            <div className="sm:col-span-2">
              <label className="block font-semibold text-gray-700 mb-1">Full / Business Name *</label>
              <input
                type="text"
                value={form.user_name || ''}
                onChange={(e) => setForm({ ...form, user_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            {/* TIN & Verify Button */}
            <div className="sm:col-span-2 bg-slate-50 p-3 rounded-xl border border-slate-200">
              <label className="block font-semibold text-gray-700 mb-1">
                TIN (Tax Identification Number)
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={form.tin || ''}
                  onChange={(e) => setForm({ ...form, tin: e.target.value })}
                  placeholder="e.g. 0097598443"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono bg-white focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={handleVerifyTinInModal}
                  disabled={verifyingTin || !form.tin?.trim()}
                  className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg shadow-xs transition disabled:opacity-50 cursor-pointer"
                >
                  {verifyingTin ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                  Verify TIN
                </button>
              </div>
              {form.trade_name && (
                <p className="text-[11px] text-emerald-800 font-medium mt-1">
                  🏢 Trade Name: {form.trade_name}
                </p>
              )}
            </div>

            {/* Verify → consent: the official record is compared against what
                is registered, and only the ticked fields are replaced. */}
            {verifyRes && verifyChoices.length > 0 && (
              <div className="sm:col-span-2 bg-amber-50/80 border border-amber-300 rounded-xl p-3.5">
                <p className="text-xs font-bold text-amber-900 flex items-center gap-1.5">
                  <AlertTriangle size={13} />
                  Replace registered data with the official eTrade / MoR record?
                </p>
                <div className="mt-2.5 space-y-1.5">
                  {verifyChoices.map((c) => (
                    <label key={c.field} className="flex items-start gap-2.5 bg-white/70 border border-amber-200 rounded-lg px-2.5 py-2 cursor-pointer hover:bg-white transition">
                      <input
                        type="checkbox"
                        checked={Boolean(replaceSel[c.field])}
                        onChange={(e) => setReplaceSel((prev) => ({ ...prev, [c.field]: e.target.checked }))}
                        disabled={applyingVerify}
                        className="mt-0.5 h-4 w-4 text-amber-600 rounded border-gray-300 focus:ring-amber-500"
                      />
                      <div className="text-[11px] leading-snug min-w-0">
                        <p className="font-semibold text-gray-800">{c.label}</p>
                        <p className="text-gray-600 truncate">
                          <span className="text-gray-400">registered:</span> {c.to || '(empty)'}
                          {' → '}
                          <span className="text-emerald-700 font-medium">official:</span> {c.from}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
                <div className="flex items-center justify-end gap-2 mt-2.5">
                  <button
                    type="button"
                    onClick={() => { setVerifyRes(null); setVerifyChoices([]); setReplaceSel({}); }}
                    disabled={applyingVerify}
                    className="px-3 py-1.5 text-[11px] font-medium text-gray-600 hover:bg-amber-100 rounded-lg transition"
                  >
                    Dismiss
                  </button>
                  <button
                    type="button"
                    onClick={handleApplyVerifiedFields}
                    disabled={applyingVerify || !Object.values(replaceSel).some(Boolean)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded-lg shadow-xs transition"
                  >
                    {applyingVerify ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    Replace Selected
                  </button>
                </div>
              </div>
            )}
            {verifyRes && verifyChoices.length === 0 && (
              <div className="sm:col-span-2 bg-emerald-50 border border-emerald-200 rounded-xl px-3.5 py-2.5 text-[11px] text-emerald-800 font-medium">
                ✓ The registered data already matches the official record — nothing to replace.
              </div>
            )}

            {/* Status */}
            <div>
              <label className="block font-semibold text-gray-700 mb-1">Status</label>
              <select
                value={form.status || 'active'}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500"
              >
                <option value="active">Active</option>
                <option value="canceled">Canceled</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>

            {/* Phone Number — verified against the official record too; the
                consent panel offers to replace it when they differ. */}
            <div>
              <label className="block font-semibold text-gray-700 mb-1">Phone Number</label>
              <input
                type="text"
                value={form.mobile_number || ''}
                onChange={(e) => setForm({ ...form, mobile_number: e.target.value })}
                placeholder="e.g. 911223344"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono bg-white focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Geographical Domain — a Sub-Distributor has no territory of its
                own in the IDC model, so the field is hidden at level 2. */}
            {Number(entity.level) !== 2 && (
              <div>
                <label className="block font-semibold text-gray-700 mb-1">Geographical Domain / Region</label>
                <input
                  type="text"
                  value={form.geo_domain_raw || ''}
                  onChange={(e) => setForm({ ...form, geo_domain_raw: e.target.value })}
                  placeholder="e.g. ADDIS ABABA, Hargele"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            {/* Existing Business — only a Retailer carries one now; the
                Distributor and Sub-Distributor sheets dropped the column. */}
            {Number(entity.level) === 3 && (
              <div>
                <label className="block font-semibold text-gray-700 mb-1">Existing Business</label>
                <input
                  type="text"
                  value={form.business_type || ''}
                  onChange={(e) => setForm({ ...form, business_type: e.target.value })}
                  placeholder="e.g. Supermarket, Shop, Kiosk"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            {/* Product */}
            <div>
              <label className="block font-semibold text-gray-700 mb-1">Product / Air Time</label>
              <input
                type="text"
                value={form.product || ''}
                onChange={(e) => setForm({ ...form, product: e.target.value })}
                placeholder="e.g. EVD, eTopUP"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Street address — the composed Sub-City / Woreda / House string
                (named 'location' on the record for history's sake). */}
            <div className="sm:col-span-2">
              <label className="block font-semibold text-gray-700 mb-1">Street Address Information</label>
              <input
                type="text"
                value={form.location || ''}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder="e.g. KIRKOS, WOREDA 10, House: 154"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* GPS capture — retailer-only, optional. Same widget as Single
                Registration: the position comes from the operator's device and
                is reverse-geocoded in the browser, so an imported retailer can
                gain coordinates without being re-registered. */}
            {Number(entity.level) === 3 && (
              <div className="sm:col-span-2">
                <LocationCapture value={gps} onChange={handleGpsEdit} />
              </div>
            )}

            {/* Sub-City, Woreda, House No */}
            <div>
              <label className="block font-semibold text-gray-700 mb-1">Sub-City</label>
              <input
                type="text"
                value={form.sub_city || ''}
                onChange={(e) => setForm({ ...form, sub_city: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block font-semibold text-gray-700 mb-1">Woreda / Kebele</label>
              <input
                type="text"
                value={form.woreda || ''}
                onChange={(e) => setForm({ ...form, woreda: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* National / Fayda ID — a Retailer-only compliance field:
                Distributors and Sub-Distributors don't carry one. */}
            {Number(entity.level) === 3 && (
              <div>
                <label className="block font-semibold text-gray-700 mb-1">National / Fayda ID</label>
                <input
                  type="text"
                  value={form.national_id || ''}
                  onChange={(e) => setForm({ ...form, national_id: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            <div>
              <label className="block font-semibold text-gray-700 mb-1">House Number</label>
              <input
                type="text"
                value={form.house_no || ''}
                onChange={(e) => setForm({ ...form, house_no: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Notes */}
            <div className="sm:col-span-2">
              <label className="block font-semibold text-gray-700 mb-1">Notes / Remarks</label>
              <textarea
                rows={2}
                value={form.notes || ''}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg shadow-sm transition"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              {loading ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function DeleteEntityModal({ isOpen, onClose, entity, onDeleted }) {
  const [force, setForce] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!isOpen || !entity) return null;

  const hasChildren = (Number(entity.sub_distributors) || 0) > 0 || (Number(entity.retailers) || 0) > 0 || (Number(entity.direct_children) || 0) > 0;

  async function handleDelete() {
    setLoading(true);
    try {
      await channelAPI.deleteEntity(entity.id, force);
      toast.success('Record deleted successfully');
      if (onDeleted) onDeleted();
      onClose();
    } catch (err) {
      if (err.message?.includes('downstream')) {
        toast.error(err.message);
        setForce(true);
      } else {
        toast.error('Failed to delete: ' + err.message);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-in fade-in">
      <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-gray-100">
        <div className="flex items-center gap-3 pb-3 border-b border-gray-100">
          <div className="p-2 bg-red-50 text-red-600 rounded-lg">
            <AlertTriangle size={22} />
          </div>
          <div>
            <h3 className="text-base font-bold text-gray-900">Delete Channel Record</h3>
            <p className="text-xs text-gray-500">Confirm record removal from register</p>
          </div>
        </div>

        <div className="py-4 space-y-3 text-sm">
          <p className="text-gray-700">
            Are you sure you want to delete <strong className="text-gray-900">{entity.user_name}</strong> ({entity.mobile_number})?
          </p>

          <div className="bg-gray-50 p-3 rounded-xl border border-gray-200 text-xs space-y-1">
            <p><span className="text-gray-500">Level:</span> <strong className="text-gray-800">Level {entity.level || '—'}</strong></p>
            <p><span className="text-gray-500">Geographical Domain:</span> {entity.geo_domain_raw || '—'}</p>
            {entity.tin && <p><span className="text-gray-500">TIN:</span> <span className="font-mono text-blue-700 font-bold">{entity.tin}</span></p>}
          </div>

          {hasChildren && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900 space-y-2">
              <p className="font-semibold flex items-center gap-1">
                <AlertCircle size={14} className="text-amber-600" />
                Downstream Records Warning
              </p>
              <p>
                This account has <strong>{entity.sub_distributors || entity.retailers || entity.direct_children}</strong> downstream records beneath it.
              </p>
              <label className="flex items-center gap-2 cursor-pointer pt-1 font-semibold text-amber-950 select-none">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  className="rounded border-amber-300 text-red-600 focus:ring-red-500"
                />
                Force delete and detach downstream children
              </label>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 rounded-lg shadow-sm transition"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
            {loading ? 'Deleting...' : 'Delete Record'}
          </button>
        </div>
      </div>
    </div>
  );
}
