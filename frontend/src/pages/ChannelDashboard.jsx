import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { channelAPI } from '../services/api';
import RetailerMaps from '../components/channel/RetailerMaps';
import ColumnPicker, { loadColumnPrefs } from '../components/ColumnPicker';
import {
  Tooltip, LabelList, Legend, ResponsiveContainer, PieChart, Pie, Cell,
  BarChart, Bar, ComposedChart, Line,
  XAxis, YAxis, CartesianGrid,
} from 'recharts';
import {
  Building2, Users, TrendingUp,
  MapPin, Search, ChevronLeft, ChevronRight, RefreshCw,
  Globe, Layers, ArrowUpRight,
  Filter, Loader2, Store, X, CornerDownRight,
  Activity, PieChart as PieChartIcon, BarChart3,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { ImportStamp, IdentifierTag, STATUS_COLORS, groupDownstream } from '../components/channel/EntityBits';

const fmtNum = (n) => (n || 0).toLocaleString();

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

export default function ChannelDashboard() {
  const { hasAnyPermission } = useAuth();
  const [kpis, setKpis] = useState(null);
  const [trend, setTrend] = useState(null);
  const [geo, setGeo] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedPeriod, setSelectedPeriod] = useState('');
  const [activeTab, setActiveTab] = useState('overview');

  // Hierarchy drill-down: which level is on screen and which node we descended
  // through to get here. `path` doubles as the breadcrumb.
  const [hierCtx, setHierCtx] = useState({ level: 1, parentId: null, path: [] });
  const [hierReport, setHierReport] = useState(null);
  const [hierLoading, setHierLoading] = useState(false);
  const [hierPage, setHierPage] = useState(1);
  const [hierSearch, setHierSearch] = useState('');

  // Headline numbers and the reference lists the filters need, nothing more —
  // the analysis views (matrix, per-level reports, ranking) are on Reports.
  const loadDashboard = async (period) => {
    setLoading(true);
    try {
      const params = period ? { period } : {};
      const [metaData, kpisData, trendData, geoData] = await Promise.all([
        channelAPI.getMeta(),
        channelAPI.getKPIs(params),
        channelAPI.getTrend(),
        channelAPI.getGeo({ limit: 12 }),
      ]);
      setMeta(metaData);
      setKpis(kpisData);
      setTrend(trendData);
      setGeo(geoData);
    } catch (err) {
      toast.error('Failed to load dashboard: ' + err.message);
    }
    setLoading(false);
  };

  useEffect(() => { loadDashboard(selectedPeriod || undefined); }, [selectedPeriod]);

  // The hierarchy walks one level at a time, straight from the registry.
  useEffect(() => {
    if (activeTab !== 'hierarchy') return undefined;
    let cancelled = false;
    setHierLoading(true);
    channelAPI.getLevelReport({
      level: hierCtx.level,
      page: hierPage,
      limit: 25,
      ...(selectedPeriod ? { period: selectedPeriod } : {}),
      ...(hierCtx.parentId ? { parent_id: hierCtx.parentId } : {}),
      ...(hierSearch ? { search: hierSearch } : {}),
    })
      .then((d) => { if (!cancelled) setHierReport(d); })
      .catch((e) => { if (!cancelled) toast.error('Failed to load hierarchy: ' + e.message); })
      .finally(() => { if (!cancelled) setHierLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, hierCtx, selectedPeriod, hierPage, hierSearch]);

  useEffect(() => { setHierPage(1); }, [hierCtx, selectedPeriod, hierSearch]);

  async function handleEntityClick(id) {
    try {
      return await channelAPI.getEntity(id);
    } catch (e) { return null; }
  }

  const periods = meta?.periods || [];

  // The period series: how the register has grown, level by level. This is the
  // one view on the dashboard that is about time rather than composition.
  const growthSeries = useMemo(
    () => (trend?.trend || []).map(t => {
      const retailers = Number(t.retailers) || 0;
      const subs = Number(t.sub_distributors) || 0;
      const dists = Number(t.distributors) || 0;
      return {
        label: String(t.period || '').slice(0, 7),
        Retailers: retailers,
        'Sub-Distributors': subs,
        Distributors: dists,
        'Chain total': retailers + subs + dists,
      };
    }),
    [trend]
  );

  const topAreas = useMemo(
    () => (geo?.areas || []).slice(0, 12).map(a => ({ name: a.area || '—', users: Number(a.entities) || 0 })),
    [geo]
  );

  const businessBars = useMemo(
    () => (kpis?.by_business_type || [])
      // Only retailers carry an Existing Business now, so the chart title
      // says retailers and any legacy upline values stay out of the bars.
      .filter(b => b.business_type && b.business_type !== 'Unspecified')
      .slice(0, 8)
      .map(b => ({ name: b.business_type, users: Number(b.entities) || 0 })),
    [kpis]
  );

  const airTimeDonut = useMemo(
    () => (kpis?.by_product || []).slice(0, 6).map((p, i) => ({
      name: p.product || 'Unspecified',
      value: Number(p.entities) || 0,
      fill: COLORS[i % COLORS.length],
    })),
    [kpis]
  );

  if (loading && !kpis) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-blue-500 animate-spin mx-auto mb-4" />
          <p className="text-gray-500">Loading Indirect Channel Dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 text-white shadow-lg shadow-emerald-600/20">
            <Activity size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">Indirect Channel Dashboard</h1>
            <p className="text-sm text-gray-500 mt-1">
              Live view of the register — users across Distributors, Sub-Distributors and Retailers.
              The deep-dive analysis lives on the Channel Reports page.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Filter size={16} className="text-gray-400" />
            <select
              value={selectedPeriod}
              onChange={(e) => { setSelectedPeriod(e.target.value); }}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">Latest Period</option>
              {periods.map(p => (
                <option key={p} value={p}>{p?.slice(0, 7)}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => loadDashboard(selectedPeriod || undefined)}
            className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50 transition"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Cards — entity counts */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <KPICard label="Channel Users" value={fmtNum(kpis?.total_entities)} icon={<Users size={20} />} color="purple"
          sub="directly imported" />
        <KPICard label="Distributors (L1)" value={fmtNum(kpis?.distributor_entities)} icon={<Building2 size={20} />} color="indigo"
          sub="in the chain" />
        <KPICard label="Sub-Distributors (L2)" value={fmtNum(kpis?.sub_distributor_entities)} icon={<Layers size={20} />} color="cyan"
          sub="in the chain" />
        <KPICard label="Retailers (L3)" value={fmtNum(kpis?.retail_entities)} icon={<Store size={20} />} color="green"
          sub="directly imported" />
        <KPICard label="Geographic Areas" value={fmtNum(kpis?.geo_areas)} icon={<Globe size={20} />} color="orange"
          sub="from imported data" />
        <KPICard label="Active Users" value={fmtNum(kpis?.active_entities)} icon={<TrendingUp size={20} />} color="green"
          sub="directly imported" />
        <KPICard label="Air Time Types" value={fmtNum((kpis?.by_product || []).length)} icon={<ArrowUpRight size={20} />} color="purple"
          sub={(kpis?.by_product || []).slice(0, 3).map(p => p.product).join(', ') || 'None recorded'} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/70 backdrop-blur p-1 rounded-xl border border-gray-200 shadow-sm w-fit">
        {[          { key: 'overview', label: 'Overview' },
          { key: 'hierarchy', label: 'Hierarchy' },
          { key: 'maps', label: 'Maps' },
        ].map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={'px-4 py-2 text-sm font-medium rounded-lg transition ' + (activeTab === tab.key ? 'bg-gradient-to-r from-emerald-500 to-green-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100')}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Overview Tab — time first, then composition */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-gray-200/80 shadow-sm p-5">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
              <div className="flex items-start gap-2.5">
                <span className="p-1.5 rounded-lg bg-blue-50 text-blue-600"><Activity size={16} /></span>
                <div>
                  <h3 className="text-sm font-semibold text-gray-800">Network Growth</h3>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Register size per level across the import periods — uplines a file named are counted with the chain
                  </p>
                </div>
              </div>
              {growthSeries.length === 1 && (
                <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-0.5">
                  One period on file — each new import extends this line
                </span>
              )}
            </div>
            {growthSeries.length === 0 ? (
              <ChartEmpty label="No import periods recorded yet" />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={growthSeries} margin={{ top: 8, right: 12, left: -14, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dashRetail" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.75} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0.08} />
                    </linearGradient>
                    <linearGradient id="dashSub" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.75} />
                      <stop offset="100%" stopColor="#06b6d4" stopOpacity={0.08} />
                    </linearGradient>
                    <linearGradient id="dashDist" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6366f1" stopOpacity={0.75} />
                      <stop offset="100%" stopColor="#6366f1" stopOpacity={0.08} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Retailers" stackId="chain" fill="url(#dashRetail)" radius={[0, 0, 0, 0]} maxBarSize={70} />
                  <Bar dataKey="Sub-Distributors" stackId="chain" fill="url(#dashSub)" maxBarSize={70} />
                  <Bar dataKey="Distributors" stackId="chain" fill="url(#dashDist)" radius={[8, 8, 0, 0]} maxBarSize={70} />
                  <Line type="monotone" dataKey="Chain total" stroke="#f59e0b" strokeWidth={2.5} dot={{ r: 5, fill: '#f59e0b' }} activeDot={{ r: 7 }} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-2xl border border-gray-200/80 shadow-sm p-5">
              <div className="flex items-start gap-2.5 mb-4">
                <span className="p-1.5 rounded-lg bg-cyan-50 text-cyan-600"><MapPin size={16} /></span>
                <div>
                  <h3 className="text-sm font-semibold text-gray-800">Top Areas by Users</h3>
                  <p className="text-[11px] text-gray-500 mt-0.5">Where the register is concentrated</p>
                </div>
              </div>
              {topAreas.length === 0 ? (
                <ChartEmpty label="No geographic data yet" />
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={topAreas} layout="vertical" margin={{ top: 4, right: 28, left: 8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="dashAreaBar" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#06b6d4" />
                        <stop offset="100%" stopColor="#3b82f6" />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <Tooltip formatter={(v) => fmtNum(v)} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                    <Bar dataKey="users" name="Users" fill="url(#dashAreaBar)" radius={[0, 8, 8, 0]} maxBarSize={22}>
                      <LabelList dataKey="users" position="right" style={{ fontSize: 11, fill: '#475569', fontWeight: 600 }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="bg-white rounded-2xl border border-gray-200/80 shadow-sm p-5">
              <div className="flex items-start gap-2.5 mb-4">
                <span className="p-1.5 rounded-lg bg-amber-50 text-amber-600"><BarChart3 size={16} /></span>
                <div>
                  <h3 className="text-sm font-semibold text-gray-800">Retailers by Existing Business</h3>
                  <p className="text-[11px] text-gray-500 mt-0.5">The business each retailer runs — distributors and sub-distributors carry none</p>
                </div>
              </div>
              {businessBars.length === 0 ? (
                <ChartEmpty label="Nothing recorded yet" />
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={businessBars} margin={{ top: 18, right: 12, left: -14, bottom: 0 }}>
                    <defs>
                      <linearGradient id="dashBizBar" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#f59e0b" />
                        <stop offset="100%" stopColor="#fbbf24" stopOpacity={0.6} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} interval={0} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                    <Tooltip formatter={(v) => fmtNum(v)} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                    <Bar dataKey="users" name="Users" fill="url(#dashBizBar)" radius={[8, 8, 0, 0]} maxBarSize={48}>
                      <LabelList dataKey="users" position="top" style={{ fontSize: 11, fill: '#475569', fontWeight: 600 }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-gray-200/80 shadow-sm p-5">
            <div className="flex items-start gap-2.5 mb-4">
              <span className="p-1.5 rounded-lg bg-purple-50 text-purple-600"><PieChartIcon size={16} /></span>
              <div>
                <h3 className="text-sm font-semibold text-gray-800">Air Time Type Mix</h3>
                <p className="text-[11px] text-gray-500 mt-0.5">Share of users by the air time they carry</p>
              </div>
            </div>
            {airTimeDonut.length === 0 ? (
              <ChartEmpty label="Nothing recorded yet" />
            ) : (
              <div className="flex flex-col sm:flex-row items-center gap-6">
                <ResponsiveContainer width="100%" height={260} className="sm:!w-1/2">
                  <PieChart>
                    <Pie data={airTimeDonut} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={70} outerRadius={100} paddingAngle={3} stroke="none">
                      {airTimeDonut.map((d, i) => (<Cell key={i} fill={d.fill} />))}
                    </Pie>
                    <Tooltip formatter={(v) => fmtNum(v)} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 w-full space-y-2">
                  {airTimeDonut.map((d) => (
                    <div key={d.name} className="flex items-center gap-3 text-sm">
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: d.fill }} />
                      <span className="text-gray-700 flex-1 truncate">{d.name}</span>
                      <span className="font-semibold text-gray-900 tabular-nums">{fmtNum(d.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Hierarchy Tab — Distributor → Sub-Distributor → Retailer, with details */}
      {activeTab === 'hierarchy' && (
        <HierarchyView
          ctx={hierCtx}
          setCtx={setHierCtx}
          report={hierReport}
          loading={hierLoading}
          page={hierPage}
          setPage={setHierPage}
          search={hierSearch}
          setSearch={setHierSearch}
          onOpenEntity={handleEntityClick}
          searchHint={selectedPeriod ? `period ${selectedPeriod.slice(0, 7)}` : 'current stock'}
        />
      )}

      {/* Maps Tab */}
      {activeTab === 'maps' && (
        <RetailerMaps areas={geo?.areas || []} />
      )}
    </div>
  );
}

const HIER_LEVELS = {
  1: { label: 'Distributors', singular: 'Distributor', icon: Building2, tone: 'indigo' },
  2: { label: 'Sub-Distributors', singular: 'Sub-Distributor', icon: Layers, tone: 'cyan' },
  3: { label: 'Retailers', singular: 'Retailer', icon: Store, tone: 'green' },
};

/**
 * Distributor → Sub-Distributor → Retailer, one level at a time.
 *
 * Every level is read from the registry, so a Distributor or Sub-Distributor
 * appears as soon as a file names it — no separate record of its own is needed.
 */
function HierarchyView({ ctx, setCtx, report, loading, page, setPage, search, setSearch, searchHint }) {
  const [input, setInput] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const spec = HIER_LEVELS[ctx.level];
  const Icon = spec.icon;
  const rows = report?.rows || [];
  const s = report?.summary || {};
  const pages = report?.pagination?.pages || 0;

  // Column preferences for the details table, per hierarchy level.
  const hierColDefs = useMemo(() => [
    { key: 'name', label: spec.singular, always: true },
    { key: 'identifier', label: 'Identifier Code' },
    { key: 'geo', label: 'Region / Domain' },
    ...(ctx.level === 3 ? [{ key: 'business', label: 'Business' }] : []),
    { key: 'product', label: 'Air Time' },
    { key: 'status', label: 'Status' },
    ...(ctx.level === 2 ? [{ key: 'owner', label: 'Distributor' }] : []),
    ...(ctx.level === 3 ? [{ key: 'parent', label: 'Sub Distributor' }, { key: 'owner', label: 'Distributor' }] : []),
    ...(ctx.level === 1 ? [
      { key: 'subdists', label: 'Sub-Dists' },
      { key: 'retailers', label: 'Retailers' },
    ] : []),
    ...(ctx.level === 2 ? [{ key: 'retailers', label: 'Retailers' }] : []),
    { key: 'imported', label: 'Imported by' },
    { key: 'open', label: 'Open', always: true },
  ], [ctx.level, spec.singular]);
  const hierKeys = useMemo(() => hierColDefs.map((c) => c.key), [hierColDefs]);
  const hierStorage = `channel_cols_hier_${ctx.level}`;
  const [hierCols, setHierCols] = useState(() => loadColumnPrefs(hierStorage, hierKeys));
  useEffect(() => {
    setHierCols(loadColumnPrefs(hierStorage, hierKeys));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hierStorage, hierKeys.join(',')]);
  const hshow = (k) => hierCols.has(k);

  async function openDetail(id) {
    setDetailLoading(true);
    try {
      setDetail(await channelAPI.getEntity(id));
    } catch (e) {
      toast.error('Could not load that record');
    }
    setDetailLoading(false);
  }

  // Descend when there is something below, otherwise show the record.
  function onRowClick(row) {
    if (row.level === 1) {
      setCtx({ level: 2, parentId: row.id, path: [{ id: row.id, name: row.user_name, level: 1 }] });
    } else if (row.level === 2) {
      setCtx({ level: 3, parentId: row.id, path: [...ctx.path, { id: row.id, name: row.user_name, level: 2 }] });
    } else {
      openDetail(row.id);
    }
  }

  function goTo(index) {
    if (index < 0) { setCtx({ level: 1, parentId: null, path: [] }); return; }
    const node = ctx.path[index];
    setCtx({ level: node.level + 1, parentId: node.id, path: ctx.path.slice(0, index + 1) });
  }

  return (
    <div className="space-y-5">
      {/* Level switch + breadcrumb */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {[1, 2, 3].map((lvl) => {
            const L = HIER_LEVELS[lvl];
            const LIcon = L.icon;
            const active = ctx.level === lvl;
            return (
              <button
                key={lvl}
                onClick={() => setCtx({ level: lvl, parentId: null, path: [] })}
                className={'flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition ' +
                  (active ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}
              >
                <LIcon size={14} />
                All {L.label}
              </button>
            );
          })}
          <div className="flex-1" />
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setSearch(input.trim()); } }}
              placeholder={`Search ${spec.label.toLowerCase()}…`}
              className="pl-9 pr-3 py-2 w-56 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <button onClick={() => setSearch(input.trim())} className="px-3 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200">
            Search
          </button>
          {search && (
            <button onClick={() => { setInput(''); setSearch(''); }} className="px-3 py-2 text-sm text-gray-500 hover:text-gray-800">
              Clear
            </button>
          )}
        </div>

        {/* Breadcrumb: the chain we descended through */}
        <div className="flex flex-wrap items-center gap-1 text-xs text-gray-500">
          <button onClick={() => goTo(-1)} className="hover:text-blue-700 font-medium">All Distributors</button>
          {ctx.path.map((n, i) => (
            <React.Fragment key={n.id}>
              <ChevronRight size={12} className="text-gray-300" />
              <button onClick={() => goTo(i)} className="hover:text-blue-700 font-medium truncate max-w-[200px]" title={n.name}>
                {n.name}
              </button>
            </React.Fragment>
          ))}
          <ChevronRight size={12} className="text-gray-300" />
          <span className="text-gray-800 font-medium">{spec.label}</span>
          <span className="text-gray-400">· {searchHint}</span>
        </div>
      </div>

      {/* Headline for the level on screen */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard label={spec.label} value={fmtNum(s.entities)} icon={<Icon size={20} />} color={spec.tone}
          sub={ctx.parentId ? 'Below the selected parent' : 'Registered in the registry'} />
        <KPICard label="Active / Canceled" value={fmtNum(s.active_entities) + ' / ' + fmtNum(s.canceled_entities)} icon={<Users size={20} />} color="green" />
        <KPICard label="Areas Covered" value={fmtNum(s.areas)} icon={<Globe size={20} />} color="orange" />
      </div>

      {/* Details table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">{spec.label} — details</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {ctx.level < 3 ? 'Click a row to open the level below it.' : 'Click a row for the full record.'}
              {' '}{fmtNum(report?.pagination?.total || 0)} record(s).
            </p>
          </div>
          <ColumnPicker
            columns={hierColDefs}
            visible={hierCols}
            setVisible={setHierCols}
            storageKey={hierStorage}
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-gray-500">
            No {spec.label.toLowerCase()} here yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{spec.singular}</th>
                  {hshow('identifier') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Identifier Code</th>}
                  {hshow('geo') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Region / Domain</th>}
                  {ctx.level === 3 && hshow('business') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Business</th>}
                  {hshow('product') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Air Time</th>}
                  {hshow('status') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Status</th>}
                  {ctx.level === 2 && hshow('owner') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Distributor</th>}
                  {ctx.level === 3 && hshow('parent') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Sub Distributor</th>}
                  {ctx.level === 3 && hshow('owner') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Distributor</th>}
                  {ctx.level === 1 && hshow('subdists') && (
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">Sub-Dists</th>
                  )}
                  {ctx.level === 1 && hshow('retailers') && (
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">Retailers</th>
                  )}
                  {ctx.level === 2 && hshow('retailers') && <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">Retailers</th>}
                  {hshow('imported') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Imported by</th>}
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">Open</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => onRowClick(r)}
                    className="border-b border-gray-50 hover:bg-blue-50/40 cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800 max-w-[220px] truncate" title={r.user_name}>{r.user_name}</p>
                      <p className="text-xs text-gray-500 font-mono">{r.mobile_number}</p>
                    </td>
                    {hshow('identifier') && <td className="px-4 py-3"><IdentifierTag code={r.identifier_code} /></td>}
                    {hshow('geo') && <td className="px-4 py-3 text-gray-600 max-w-[150px] truncate" title={r.geo_domain_raw || ''}>{r.geo_domain_raw || '—'}</td>}
                    {ctx.level === 3 && hshow('business') && (
                      <td className="px-4 py-3 text-gray-600 max-w-[150px] truncate" title={r.business_type || ''}>{r.business_type || '—'}</td>
                    )}
                    {hshow('product') && <td className="px-4 py-3 text-gray-600">{r.product || '—'}</td>}
                    {hshow('status') && (
                      <td className="px-4 py-3">
                        <span className={'inline-block px-2 py-0.5 rounded border text-[11px] font-medium capitalize ' + (STATUS_COLORS[r.status] || STATUS_COLORS.inactive)}>
                          {r.status || '—'}
                        </span>
                      </td>
                    )}
                    {ctx.level === 2 && hshow('owner') && (
                      <td className="px-4 py-3 text-gray-600 max-w-[180px] truncate" title={r.owner_name || ''}>{r.owner_name || '—'}</td>
                    )}
                    {ctx.level === 3 && hshow('parent') && (
                      <td className="px-4 py-3 text-gray-600 max-w-[180px] truncate" title={r.parent_name || ''}>{r.parent_name || '—'}</td>
                    )}
                    {ctx.level === 3 && hshow('owner') && (
                      <td className="px-4 py-3 text-gray-600 max-w-[180px] truncate" title={r.owner_name || ''}>{r.owner_name || '—'}</td>
                    )}
                    {ctx.level === 1 && hshow('subdists') && (
                      <td className="px-4 py-3 text-right text-gray-600" title="Distinct Sub-Distributors of the Retailers this Distributor owns">{fmtNum(r.subs_through ?? r.sub_distributors)}</td>
                    )}
                    {(ctx.level === 1 || ctx.level === 2) && hshow('retailers') && (
                      <td className="px-4 py-3 text-right text-gray-600">{fmtNum(r.retailers)}</td>
                    )}
                    {hshow('imported') && (
                      <td className="px-4 py-3 whitespace-nowrap">
                        <ImportStamp code={r.import_code} at={r.imported_at} />
                      </td>
                    )}
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); openDetail(r.id); }}
                        className="p-1.5 rounded text-gray-400 hover:text-blue-700 hover:bg-white"
                        title="View full record"
                      >
                        <ChevronRight size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
            <p className="text-xs text-gray-500">Page {page} of {fmtNum(pages)} · {fmtNum(report.pagination.total)} record(s)</p>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage(Math.max(page - 1, 1))} disabled={page <= 1}
                className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50">
                <ChevronLeft size={14} /> Prev
              </button>
              <button onClick={() => setPage(page + 1)} disabled={page >= pages}
                className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50">
                Next <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Full record for the clicked row */}
      {detail && (
        <EntityDetailCard data={detail} loading={detailLoading} onClose={() => setDetail(null)} />
      )}
    </div>
  );
}

/** The whole profile of one registry row, plus what sits under it. */
function EntityDetailCard({ data, onClose }) {
  const e = data.entity || {};
  const children = data.children || [];
  // Sub-Distributors can serve several Distributors — the registry files them
  // under one, but their retailers' owners tell the whole story.
  const distributors = data.distributors || [];
  const fields = [
    ['Mobile number', e.mobile_number],
    ['Category', e.category_label ? `${e.category_label} (L${e.level})` : null],
    ['Domain', e.domain_name],
    ['Status', e.status],
    // A Sub-Distributor has no territory of its own and only a Retailer
    // carries an Existing Business, so both are suppressed off their levels.
    ...(Number(e.level) === 2 ? [] : [['Region / Domain', e.geo_domain_raw]]),
    ...(Number(e.level) === 3 ? [['Existing business', e.business_type]] : []),
    ['Air time type', e.product],
    // Upline links. A sub's filed parent IS its distributor — the owner row
    // already shows it, so the parent row only appears on a retailer (whose
    // parent is its Sub-Distributor). Mobiles ride along now that the detail
    // endpoint returns them.
    ...(Number(e.level) === 3 && e.parent_name
      ? [['Sub-Distributor', e.parent_mobile ? `${e.parent_name} · ${e.parent_mobile}` : e.parent_name]]
      : []),
    ...(e.owner_name
      ? [['Distributor', e.owner_mobile ? `${e.owner_name} · ${e.owner_mobile}` : e.owner_name]]
      : []),
    ['Source', e.source],
    // A retailer's record is about the shop, not the reporting window, so the
    // seen dates are dropped at level 3.
    ...(Number(e.level) === 3 ? [] : [
      ['First seen', e.first_seen_period],
      ['Last seen', e.last_seen_period],
    ]),
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  return (
    <div className="bg-white rounded-xl border border-blue-200 shadow-sm overflow-hidden">
      <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-blue-900">{e.user_name}</h3>
          <p className="text-xs text-blue-700">{e.category_label}{e.geo_domain_raw ? ` · ${e.geo_domain_raw}` : ''}</p>
        </div>
        <button onClick={onClose} className="p-1 rounded text-blue-500 hover:text-blue-800 hover:bg-blue-100">
          <X size={16} />
        </button>
      </div>
      <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
        <div>
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Profile</p>
          <dl className="space-y-1">
            {fields.map(([k, v]) => (
              <div key={k} className="flex items-baseline gap-2 text-xs">
                <dt className="text-gray-500 w-32 shrink-0">{k}</dt>
                <dd className="text-gray-800 font-medium truncate capitalize">{v}</dd>
              </div>
            ))}
          </dl>
          {Number(e.level) === 2 && distributors.length > 1 && (
            <div className="mt-2 pt-2 border-t border-gray-100">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
                Works with {distributors.length} Distributors
              </p>
              {distributors.map((d) => (
                <div key={d.id} className="flex items-center gap-2 text-xs py-0.5">
                  <span className="text-gray-800 truncate flex-1" title={d.user_name}>{d.user_name}</span>
                  <span className="text-gray-500 font-mono">{d.mobile_number}</span>
                  <span className="text-[10px] text-gray-400 whitespace-nowrap">{d.retailers} rts</span>
                  {d.is_filed && <span className="text-[10px] px-1 rounded bg-blue-50 text-blue-600">filed</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Downstream ({children.length})
          </p>
          {children.length === 0 ? (
            <p className="text-xs text-gray-500">Nothing registered underneath this record.</p>
          ) : (
            <div className="max-h-40 overflow-y-auto space-y-2">
              {groupDownstream(children).map((grp) => (
                <div key={grp.level}>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
                    {grp.label} ({grp.items.length})
                  </p>
                  {grp.items.slice(0, 50).map((c) => (
                    <div key={c.id} className="flex items-center gap-2 text-xs px-2 py-1 bg-gray-50 rounded">
                      <CornerDownRight size={12} className="text-gray-400 shrink-0" />
                      <span className="text-gray-800 truncate flex-1">{c.user_name}</span>
                      <span className="text-gray-500">{c.mobile_number}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

/** The quiet placeholder a chart shows instead of an empty axis frame. */
function ChartEmpty({ label }) {
  return (
    <div className="flex items-center justify-center h-[240px]">
      <p className="text-sm text-gray-400">{label}</p>
    </div>
  );
}

function KPICard({ label, value, icon, color, sub }) {
  const colorMap = {
    blue: 'from-blue-500 to-blue-600',
    green: 'from-emerald-500 to-teal-600',
    red: 'from-red-500 to-rose-600',
    purple: 'from-purple-500 to-fuchsia-600',
    cyan: 'from-cyan-500 to-sky-600',
    orange: 'from-amber-500 to-orange-600',
    indigo: 'from-indigo-500 to-violet-600',
    gray: 'from-slate-400 to-slate-500',
  };
  const tone = colorMap[color] || colorMap.blue;
  return (
    <div className="group relative bg-white rounded-2xl border border-gray-200/80 p-4 shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 overflow-hidden">
      <div className={'absolute -right-6 -top-8 w-24 h-24 rounded-full bg-gradient-to-br ' + tone + ' opacity-[0.07]'} />
      <div className="flex items-center gap-3 mb-2">
        <div className={'p-2 rounded-xl bg-gradient-to-br text-white shadow-md ' + tone}>{icon}</div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 leading-tight">{label}</p>
      </div>
      <p className="text-2xl font-bold text-gray-900 tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-1 truncate" title={String(sub)}>{sub}</p>}
    </div>
  );
}

