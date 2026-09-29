import { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, X, Check, Target, CalendarCog } from 'lucide-react';
import { targetsAPI, servicesAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { formatCurrency, formatPercent, getAchievementBg, getProgressBarColor } from '../utils/helpers';
import { getDateFilter, setDateFilter } from '../utils/dateFilter';
import toast from 'react-hot-toast';

export default function Targets() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('targets.edit');
  const canDelete = hasPermission('targets.delete');
  const canCreate = hasPermission('targets.create');
  const [targets, setTargets] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  // Date range filter — persisted across page navigation
  const [filterStartDate, setFilterStartDate] = useState(() => getDateFilter('targets_start'));
  const [filterEndDate, setFilterEndDate] = useState(() => getDateFilter('targets_end'));
  const [form, setForm] = useState({
    service_id: '', service_name: '', target_amount: '', period_type: 'monthly',
    target_start_date: '2026-05-01', target_end_date: '2026-05-31',
    fiscal_year: 2026, assigned_by: 'VAS Director', notes: '',
  });

  useEffect(() => { loadTargets(); loadServices(); }, [filterStartDate, filterEndDate]);

  async function loadTargets() {
    try {
      const data = await targetsAPI.getAll({ start_date: filterStartDate, end_date: filterEndDate });
      setTargets(data);
    } catch (err) {
      toast.error('Failed to load targets');
    }
    setLoading(false);
  }

  async function loadServices() {
    try {
      const data = await servicesAPI.getAll();
      setServices(data.filter(s => s.status === 'active'));
    } catch (err) { /* ignore */ }
  }

  function calculateEndDate(startDate, periodType) {
    if (!startDate) return '';
    const [y, m] = startDate.split('-').map(Number);
    if (periodType === 'monthly') {
      // Last day of the same month
      const lastDay = new Date(y, m, 0).getDate();
      return `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    } else if (periodType === 'quarterly') {
      // Last day of the quarter that contains the start month
      const quarterMonth = Math.ceil(m / 3) * 3;
      const lastDay = new Date(y, quarterMonth, 0).getDate();
      return `${y}-${String(quarterMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    } else if (periodType === 'yearly') {
      // Exactly 12 months from start date
      // If Jan start → end Dec 31 same year; otherwise end last day of (startMonth-1) next year
      let endYear, endMonth;
      if (m === 1) { endYear = y; endMonth = 12; }
      else { endYear = y + 1; endMonth = m - 1; }
      const lastDay = new Date(endYear, endMonth, 0).getDate();
      return `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    }
    return startDate;
  }

  function openCreate() {
    setForm({
      service_id: '', service_name: '', target_amount: '', period_type: 'monthly',
      target_start_date: '2026-05-01', target_end_date: '2026-05-31',
      fiscal_year: 2026, assigned_by: 'VAS Director', notes: '',
    });
    setEditingId(null);
    setShowModal(true);
  }

  function openEdit(t) {
    setForm({
      service_id: t.service_id || '', service_name: t.service_name || '',
      target_amount: t.target_amount, period_type: t.period_type,
      target_start_date: t.target_start_date ? t.target_start_date.split('T')[0] : '',
      target_end_date: t.target_end_date ? t.target_end_date.split('T')[0] : '',
      fiscal_year: t.fiscal_year, assigned_by: t.assigned_by || '', notes: t.notes || '',
    });
    setEditingId(t.id);
    setShowModal(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    // Validate required fields
    if (!form.service_id && !form.service_name) {
      toast.error('Please select a service');
      return;
    }
    // Accept comma-separated amount formats: "2,500,000" — strip separators.
    const cleanAmount = parseFloat(String(form.target_amount).replace(/[\s,]/g, ''));
    if (!form.target_amount || Number.isNaN(cleanAmount) || cleanAmount <= 0) {
      toast.error('Please enter a valid target amount');
      return;
    }
    if (!form.target_start_date) {
      toast.error('Please select a start date');
      return;
    }
    try {
      const data = {
        ...form,
        target_amount: cleanAmount,
        fiscal_year: parseInt(form.fiscal_year) || new Date().getFullYear(),
      };
      if (form.service_id) data.service_id = parseInt(form.service_id);

      if (editingId) {
        await targetsAPI.update(editingId, data);
        toast.success('Target updated');
      } else {
        await targetsAPI.create(data);
        toast.success('Target created');
      }
      setShowModal(false);
      loadTargets();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this target?')) return;
    try {
      await targetsAPI.delete(id);
      toast.success('Target deleted');
      loadTargets();
    } catch (err) {
      toast.error(err.message);
    }
  }

  // ── Allocation mode & monthly allocation editor ──────────────────────────
  const [allocModal, setAllocModal] = useState(null); // { target, mode, allocations, months }
  const [allocSaving, setAllocSaving] = useState(false);
  // In-flight free-text of month inputs (comma formatted) — overrides the
  // formatted display while the user is typing a value like "1,500,0".
  const [allocText, setAllocText] = useState({});
  // First month the bulk-paste values fill (defaults to the period's first month)
  const [allocStartMonth, setAllocStartMonth] = useState('');

  function monthsBetween(startStr, endStr) {
    if (!startStr || !endStr) return [];
    const [sy, sm] = startStr.split('-').map(Number);
    const [ey, em] = endStr.split('-').map(Number);
    const months = [];
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
      months.push(`${y}-${String(m).padStart(2, '0')}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return months;
  }

  async function openAllocModal(t) {
    try {
      const data = await targetsAPI.getAllocations(t.id);
      const start = data.target_start_date ? String(data.target_start_date).split('T')[0].substring(0, 10) : '';
      const end = data.target_end_date ? String(data.target_end_date).split('T')[0].substring(0, 10) : '';
      const months = monthsBetween(start, end);
      setAllocModal({
        target: data,
        mode: data.allocation_mode || 'automatic',
        allocations: data.allocations || {},
        months,
      });
      setAllocText({});
      setAllocStartMonth(months[0] || '');
    } catch (err) {
      toast.error('Failed to load allocation settings');
    }
  }

  function setAllocMonth(month, value) {
    setAllocModal((prev) => ({
      ...prev,
      allocations: { ...prev.allocations, [month]: value === '' ? '' : Number(value) },
    }));
  }

  // Parse free-text month allocations: accepts comma/space/newline separated
  // numbers (e.g. "150000000, 120000000, 200000000") and thousands separators
  // (e.g. "150,000,000"). Values fill the period's months in order; leftover
  // months are left untouched. Returns { amounts, invalid } for user feedback.
  function parseAllocText(text, monthCount) {
    const parts = String(text || '')
      .split(/[\n,;]/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const amounts = [];
    let invalid = 0;
    for (const p of parts) {
      const n = Number(p.replace(/[\s,']/g, ''));
      if (Number.isNaN(n) || n < 0) { invalid++; continue; }
      amounts.push(n);
    }
    return { amounts: amounts.slice(0, monthCount), invalid, extra: Math.max(0, amounts.length - monthCount) };
  }

  // Bulk-fill month inputs from a comma-separated list, starting at the
  // selected start month and running forward in period order. Values beyond
  // the period's last month are ignored. Returns the number of months filled.
  function applyAllocText(text, startMonth) {
    if (!allocModal) return 0;
    const months = allocModal.months;
    const startIdx = startMonth ? months.indexOf(startMonth) : 0;
    if (startIdx === -1) {
      toast.error('Selected start month is outside this target\'s period');
      return 0;
    }
    const capacity = months.length - startIdx;
    const { amounts, invalid, extra } = parseAllocText(text, capacity);
    if (amounts.length === 0) {
      toast.error('No valid numbers found — use comma separated values, e.g. 150000000, 120000000, 200000000');
      return 0;
    }
    const allocations = { ...allocModal.allocations };
    months.slice(startIdx).forEach((m, i) => {
      if (i < amounts.length) allocations[m] = amounts[i];
    });
    setAllocModal((prev) => ({ ...prev, allocations }));
    const startLabel = months[startIdx];
    const [sy, sm] = startLabel.split('-');
    const startName = new Date(Number(sy), Number(sm) - 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    let msg = `Filled ${amounts.length} month${amounts.length === 1 ? '' : 's'} starting ${startName}`;
    if (extra > 0) msg += ` — ${extra} extra value${extra === 1 ? '' : 's'} ignored (list longer than the remaining months)`;
    if (invalid > 0) msg += ` — ${invalid} invalid entr${invalid === 1 ? 'y' : 'ies'} skipped`;
    toast.success(msg);
    return amounts.length;
  }

  // Split the target equally across every month (starting point for manual editing)
  function distributeEvenly() {
    const { target, months } = allocModal;
    const amount = parseFloat(target.target_amount) || 0;
    if (months.length === 0 || amount <= 0) return;
    const per = Math.round((amount / months.length) * 100) / 100;
    const allocations = {};
    months.forEach((m, i) => {
      // Last month absorbs rounding so the total exactly matches the target
      allocations[m] = i === months.length - 1 ? Math.round((amount - per * (months.length - 1)) * 100) / 100 : per;
    });
    setAllocModal((prev) => ({ ...prev, allocations }));
  }

  function allocTotal() {
    return Object.values(allocModal?.allocations || {}).reduce((s, v) => s + (Number(v) || 0), 0);
  }

  async function saveAllocations() {
    setAllocSaving(true);
    try {
      await targetsAPI.setAllocations(allocModal.target.target_id, {
        allocation_mode: allocModal.mode,
        allocations: allocModal.mode === 'manual' ? allocModal.allocations : {},
      });
      toast.success(allocModal.mode === 'manual'
        ? 'Manual monthly allocations saved — all reports now use them'
        : 'Automatic allocation enabled — targets split equally across the period');
      setAllocModal(null);
      loadTargets();
    } catch (err) {
      toast.error(err.message);
    }
    setAllocSaving(false);
  }

  const totalTarget = targets.reduce((s, t) => s + parseFloat(t.target_amount || 0), 0);

  // Format date for display
  function fmtDate(d) {
    if (!d) return '-';
    const date = new Date(d);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Revenue Targets</h1>
          <p className="text-sm text-gray-500">Set and manage revenue targets per service</p>
        </div>
        {canCreate && (
          <button onClick={openCreate} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
            <Plus size={16} /> Add Target
          </button>
        )}
      </div>

      {/* Date Range Filter */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <label className="text-sm font-medium text-gray-600">Date Range:</label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Start:</span>
            <input type="date" value={filterStartDate} onChange={(e) => { setFilterStartDate(e.target.value); setDateFilter('targets_start', e.target.value); }}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">End:</span>
            <input type="date" value={filterEndDate} onChange={(e) => { setFilterEndDate(e.target.value); setDateFilter('targets_end', e.target.value); }}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="ml-auto text-sm text-gray-600">
            Total Target: <span className="font-bold text-blue-600">{formatCurrency(totalTarget)}</span>
            <span className="text-gray-400 mx-2">·</span>
            <span>{targets.length} targets</span>
          </div>
        </div>
      </div>

      {/* Targets Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left py-3 px-4 font-semibold text-gray-600">Service</th>
                  <th className="text-center py-3 px-4 font-semibold text-gray-600">Period</th>
                  <th className="text-center py-3 px-4 font-semibold text-gray-600">Start Date</th>
                  <th className="text-center py-3 px-4 font-semibold text-gray-600">End Date</th>
                  <th className="text-right py-3 px-4 font-semibold text-gray-600">Target Amount</th>
                  <th className="text-center py-3 px-4 font-semibold text-gray-600">Assigned By</th>
                  <th className="text-center py-3 px-4 font-semibold text-gray-600">Notes</th>
                  <th className="text-center py-3 px-4 font-semibold text-gray-600">Allocation</th>
                  <th className="text-center py-3 px-4 font-semibold text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.id} className="border-t border-gray-50 hover:bg-gray-50">
                    <td className="py-3 px-4">
                      <div className="font-medium text-gray-900">{t.service_name}</div>
                    </td>
                    <td className="text-center py-3 px-4">
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 capitalize">
                        {t.period_type}
                      </span>
                    </td>
                    <td className="text-center py-3 px-4 text-gray-600">{fmtDate(t.target_start_date)}</td>
                    <td className="text-center py-3 px-4 text-gray-600">{fmtDate(t.target_end_date)}</td>
                    <td className="text-right py-3 px-4 font-semibold text-gray-900">{formatCurrency(t.target_amount)}</td>
                    <td className="text-center py-3 px-4 text-gray-600">{t.assigned_by}</td>
                    <td className="text-center py-3 px-4 text-gray-500 text-xs max-w-[200px] truncate">{t.notes}</td>
                    <td className="text-center py-3 px-4">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        (t.allocation_mode === 'manual') ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700'
                      }`}>
                        {t.allocation_mode === 'manual' ? 'Monthly manual' : 'Auto split'}
                      </span>
                    </td>
                    <td className="text-center py-3 px-4">
                      <div className="flex items-center justify-center gap-1">
                        {canEdit && <button onClick={() => openAllocModal(t)} title="Allocation mode & monthly targets" className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-purple-600"><CalendarCog size={14} /></button>}
                        {canEdit && <button onClick={() => openEdit(t)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-blue-600"><Edit2 size={14} /></button>}
                        {canDelete && <button onClick={() => handleDelete(t.id)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-red-600"><Trash2 size={14} /></button>}
                      </div>
                    </td>
                  </tr>
                ))}
                {targets.length === 0 && (
                  <tr><td colSpan={9} className="text-center py-12 text-gray-400">No targets found for this date range</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Allocation Mode & Monthly Allocation Modal */}
      {allocModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-semibold">Target Allocation — {allocModal.target.service_name}</h2>
              <button onClick={() => setAllocModal(null)} className="p-1 hover:bg-gray-100 rounded"><X size={18} /></button>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Period: {allocModal.target.target_start_date ? String(allocModal.target.target_start_date).split('T')[0] : '-'} → {allocModal.target.target_end_date ? String(allocModal.target.target_end_date).split('T')[0] : '-'} · Total {formatCurrency(allocModal.target.target_amount)}
            </p>

            {/* Mode toggle */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <button
                onClick={() => setAllocModal({ ...allocModal, mode: 'automatic' })}
                className={`text-left p-3 rounded-lg border-2 transition ${allocModal.mode === 'automatic' ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}
              >
                <div className="font-medium text-sm text-gray-900">⚡ Automatic</div>
                <div className="text-xs text-gray-500 mt-0.5">Target split equally across every month of the period (current logic)</div>
              </button>
              <button
                onClick={() => setAllocModal({ ...allocModal, mode: 'manual' })}
                className={`text-left p-3 rounded-lg border-2 transition ${allocModal.mode === 'manual' ? 'border-purple-600 bg-purple-50' : 'border-gray-200 hover:border-gray-300'}`}
              >
                <div className="font-medium text-sm text-gray-900">📅 Manual monthly</div>
                <div className="text-xs text-gray-500 mt-0.5">You allocate the target for each month — all reports compare actual vs these amounts</div>
              </button>
            </div>

            {allocModal.mode === 'manual' && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-gray-700">Monthly target allocation (ETB)</label>
                  <button onClick={distributeEvenly} className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium">
                    Auto-fill equal split
                  </button>
                </div>

                {/* Bulk entry: comma separated values, filling from a chosen start month */}
                {allocModal.months.length > 1 && (
                  <div className="mb-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <select
                        value={allocStartMonth || allocModal.months[0]}
                        onChange={(e) => setAllocStartMonth(e.target.value)}
                        className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm shrink-0"
                        title="First month the pasted values fill"
                      >
                        {allocModal.months.map((m) => {
                          const [yy, mm] = m.split('-');
                          const label = new Date(Number(yy), Number(mm) - 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                          return <option key={m} value={m}>{label}</option>;
                        })}
                      </select>
                      <span className="text-xs text-gray-400 shrink-0">← values start here</span>
                      <input
                        type="text"
                        placeholder={`Paste comma separated amounts, e.g. ${allocModal.months.map(() => '100000').join(', ')}`}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyAllocText(e.target.value, allocStartMonth || allocModal.months[0]); e.target.value = ''; } }}
                        className="flex-1 min-w-[200px] border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500"
                      />
                      <button
                        onClick={(e) => {
                          const input = e.target.previousElementSibling;
                          const n = applyAllocText(input.value, allocStartMonth || allocModal.months[0]);
                          if (n > 0) input.value = '';
                        }}
                        className="text-xs px-3 py-1.5 rounded-lg bg-purple-50 hover:bg-purple-100 text-purple-700 font-medium shrink-0"
                      >
                        Fill months
                      </button>
                    </div>
                    <p className="text-[11px] text-gray-400 mt-1">Pick the starting month, paste comma separated amounts, then Enter or “Fill months” — values fill forward in period order.</p>
                  </div>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-72 overflow-y-auto p-1">
                  {allocModal.months.map((m) => {
                    const [yy, mm] = m.split('-');
                    const label = new Date(Number(yy), Number(mm) - 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                    const val = allocModal.allocations[m];
                    const shown = allocText[m] !== undefined
                      ? allocText[m]
                      : (val === '' || val === undefined || val === null ? '' : Number(val).toLocaleString('en-US', { maximumFractionDigits: 2 }));
                    return (
                      <div key={m} className="flex items-center gap-1.5">
                        <span className="text-xs text-gray-600 w-16 shrink-0">{label}</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={shown}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setAllocText((prev) => ({ ...prev, [m]: raw }));
                            const n = parseFloat(raw.replace(/[\s,]/g, ''));
                            setAllocModal((prev) => ({
                              ...prev,
                              allocations: { ...prev.allocations, [m]: raw === '' || Number.isNaN(n) ? '' : n },
                            }));
                          }}
                          onBlur={() => setAllocText((prev) => { const { [m]: _drop, ...rest } = prev; return rest; })}
                          placeholder="0"
                          className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500"
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between mt-3 text-sm">
                  <span className="text-gray-500">Allocated total: <span className="font-semibold text-gray-900">{formatCurrency(allocTotal())}</span></span>
                  <span className={Math.abs(allocTotal() - parseFloat(allocModal.target.target_amount || 0)) < 0.01 ? 'text-green-600 text-xs' : 'text-amber-600 text-xs'}>
                    {Math.abs(allocTotal() - parseFloat(allocModal.target.target_amount || 0)) < 0.01
                      ? '✓ matches target amount'
                      : `Target is ${formatCurrency(allocModal.target.target_amount)} — you can allocate more or less if intended`}
                  </span>
                </div>
              </div>
            )}

            {allocModal.mode === 'automatic' && (
              <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 text-xs text-gray-600">
                With <b>Automatic</b>, {formatCurrency(allocModal.target.target_amount)} is divided equally across the {allocModal.months.length} month(s) of the period — {formatCurrency(allocModal.months.length > 0 ? (parseFloat(allocModal.target.target_amount) || 0) / allocModal.months.length : 0)} per month. This is the existing behaviour used by reports, alerts and the dashboard.
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4">
              <button type="button" onClick={() => setAllocModal(null)} className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
              <button onClick={saveAllocations} disabled={allocSaving} className="px-4 py-2 text-sm text-white bg-purple-600 rounded-lg hover:bg-purple-700 flex items-center gap-1 disabled:opacity-50">
                <Check size={14} /> {allocSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{editingId ? 'Edit Target' : 'Add New Target'}</h2>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded"><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Service *</label>
                <select required value={form.service_id || form.service_name} onChange={(e) => {
                  const val = e.target.value;
                  const svc = services.find(s => s.id.toString() === val);
                  if (svc) {
                    setForm({ ...form, service_id: val, service_name: svc.name });
                  } else {
                    setForm({ ...form, service_id: '', service_name: val });
                  }
                }} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  <option value="">Select a service</option>
                  {services.map(s => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Target Amount (ETB) *</label>
                <input required type="text" inputMode="decimal" min="0" value={form.target_amount} onChange={(e) => setForm({ ...form, target_amount: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="e.g., 2,500,000 or 2500000" />
                <p className="text-xs text-gray-400 mt-1">Commas allowed — 2,500,000 and 2500000 both work</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Period Type *</label>
                <select value={form.period_type} onChange={(e) => {
                  const newType = e.target.value;
                  const newEnd = form.target_start_date ? calculateEndDate(form.target_start_date, newType) : form.target_end_date;
                  setForm({ ...form, period_type: newType, target_end_date: newEnd });
                }} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Target Start Date *</label>
                  <input required type="date" value={form.target_start_date} onChange={(e) => {
                    const startDate = e.target.value;
                    const endDate = calculateEndDate(startDate, form.period_type);
                    setForm({ ...form, target_start_date: startDate, target_end_date: endDate });
                  }} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Target End Date *</label>
                  <input required type="date" value={form.target_end_date} onChange={(e) => setForm({ ...form, target_end_date: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />                    <p className="text-xs text-gray-400 mt-1">
                    Auto-calculated: {form.period_type === 'monthly' ? 'End of month' : form.period_type === 'quarterly' ? 'End of quarter' : 'Same date next year (minus 1 day)'}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Assigned By</label>
                  <input value={form.assigned_by} onChange={(e) => setForm({ ...form, assigned_by: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="Optional notes" />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
                <button type="submit" className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 flex items-center gap-1"><Check size={14} /> {editingId ? 'Update' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
