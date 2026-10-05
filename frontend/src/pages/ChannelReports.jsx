import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { channelAPI } from '../services/api';
import { EditEntityModal, DeleteEntityModal } from '../components/channel/EntityModals';
import ManagerPhoto from '../components/channel/ManagerPhoto';
import { buildVerifyChoices } from '../utils/verifyChoices';
import ColumnPicker, { loadColumnPrefs } from '../components/ColumnPicker';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList,
  ResponsiveContainer, PieChart, Pie, Cell, ComposedChart, Area, Line,
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
} from 'recharts';
import {
  FileBarChart, Loader2, Users, Globe, Layers,
  Building2, Store, Search, ChevronLeft, ChevronRight,
  RefreshCw, ShieldCheck, CheckCircle2, XCircle, AlertCircle, X, Sparkles,
  Edit3, Trash2, AlertTriangle, Phone, MapPin, Building,
  Hash, MapPinned, Navigation, BadgeCheck, CornerDownRight,
} from 'lucide-react';
import toast from 'react-hot-toast';

const fmtNum = (n) => (Number(n) || 0).toLocaleString();
const pct = (part, whole) => (whole ? ((Number(part) || 0) / whole) * 100 : 0);
const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

// The hierarchy levels the Reports page carries.
//
// The Distributor report deliberately has no tab here: the Distributor view is
// the Dashboard's Hierarchy tab, and having it in both places meant two screens
// showing the same Distributor list.
const LEVEL_REPORTS = {
  sub_distributor: {
    level: 2, label: 'Sub-Distributor Report', icon: Layers,
    title: 'Sub-Distributor Report',
    blurb: 'Sub-distributors with the Distributor each one belongs to.',
    parentColumn: 'Distributor',
  },
  retailer: {
    level: 3, label: 'Retailer Report', icon: Store,
    title: 'Retailer Report',
    blurb: 'Retailers with the Sub-Distributor and Distributor they report through.',
    parentColumn: 'Sub Distributor',
  },
};

const PAGE_SIZE = 50;
const LEVEL_NAMES = { 1: 'Distributors', 2: 'Sub-Distributors', 3: 'Retailers' };

// Colour identity per hierarchy level, reused by the Executive Summary blocks so
// Distributor / Sub-Distributor / Retailer read the same everywhere on the page.
const LEVEL_TONES = {
  1: { band: 'from-indigo-50/70 to-transparent', solid: 'from-indigo-500 to-purple-600', chip: 'bg-indigo-50 text-indigo-700' },
  2: { band: 'from-cyan-50/70 to-transparent', solid: 'from-cyan-500 to-blue-600', chip: 'bg-cyan-50 text-cyan-700' },
  3: { band: 'from-emerald-50/70 to-transparent', solid: 'from-emerald-500 to-green-600', chip: 'bg-emerald-50 text-emerald-700' },
};

export default function ChannelReports() {
  const [kpis, setKpis] = useState(null);
  const [matrix, setMatrix] = useState(null);
  const [topDist, setTopDist] = useState(null);
  const [geo, setGeo] = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeReport, setActiveReport] = useState('summary');

  // Level report state (shared by the three level tabs).
  const [levelReport, setLevelReport] = useState(null);
  const [levelLoading, setLevelLoading] = useState(false);
  const [levelPage, setLevelPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [levelSearch, setLevelSearch] = useState('');

  // Modals state
  const [singleVerifyEntity, setSingleVerifyEntity] = useState(null);
  const [batchVerifyOpen, setBatchVerifyOpen] = useState(false);
  const [editingEntity, setEditingEntity] = useState(null);
  const [deletingEntity, setDeletingEntity] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    const [kpisRes, matrixRes, topRes, geoRes, covRes] = await Promise.allSettled([
      channelAPI.getKPIs(),
      channelAPI.getMatrix(),
      channelAPI.getTopDistributors({ limit: 15 }),
      channelAPI.getGeo({ limit: 200 }),
      channelAPI.getRetailerCoverage(),
    ]);
    const failed = [
      ['KPIs', kpisRes], ['matrix', matrixRes],
      ['ranking', topRes], ['areas', geoRes], ['coverage', covRes],
    ].filter(([, r]) => r.status === 'rejected');
    if (kpisRes.status === 'fulfilled') setKpis(kpisRes.value);
    if (matrixRes.status === 'fulfilled') setMatrix(matrixRes.value);
    if (topRes.status === 'fulfilled') setTopDist(topRes.value);
    if (geoRes.status === 'fulfilled') setGeo(geoRes.value);
    if (covRes.status === 'fulfilled') setCoverage(covRes.value);
    if (failed.length > 0) {
      toast.error('Could not load: ' + failed.map(([name]) => name).join(', '));
    }
    setLoading(false);
  }

  const loadLevelReport = useCallback(() => {
    const spec = LEVEL_REPORTS[activeReport];
    if (!spec) return;
    setLevelLoading(true);
    channelAPI.getLevelReport({
      level: spec.level,
      page: levelPage,
      limit: PAGE_SIZE,
      ...(levelSearch ? { search: levelSearch } : {}),
    })
      .then((d) => setLevelReport(d))
      .catch((e) => {
        toast.error('Could not load the level report: ' + e.message);
      })
      .finally(() => setLevelLoading(false));
  }, [activeReport, levelPage, levelSearch]);

  useEffect(() => {
    loadLevelReport();
  }, [loadLevelReport]);

  useEffect(() => {
    setLevelPage(1);
  }, [activeReport]);
  useEffect(() => {
    setLevelPage(1);
  }, [levelSearch]);

  const areaCoverage = useMemo(() => {
    const areas = geo?.areas || [];
    const totalUsers = kpis?.total_entities || areas.reduce((a, x) => a + x.entities, 0) || 0;
    // Sorted here rather than trusted from the server: ties then sit next to
    // each other and the order is stable across reloads.
    return areas.map((a) => ({
      area: a.area,
      entities: a.entities,
      share: totalUsers ? (a.entities / totalUsers) * 100 : 0,
    })).sort((a, b) => b.entities - a.entities || a.area.localeCompare(b.area));
  }, [geo, kpis]);

  // Areas at the top often tie on user count. Name every one of them instead of
  // letting the server's balance tiebreak quietly crown a single winner.
  const topAreas = useMemo(() => {
    if (areaCoverage.length === 0) return [];
    const max = Math.max(...areaCoverage.map(a => a.entities));
    if (max <= 0) return [];
    return areaCoverage.filter(a => a.entities === max);
  }, [areaCoverage]);

  const rankedDistributors = useMemo(() => {
    const list = [...(topDist?.distributors || [])];
    list.sort((a, b) => (b.downstream_entities || 0) - (a.downstream_entities || 0));
    return list;
  }, [topDist]);

  const rankingBars = useMemo(
    () => rankedDistributors.slice(0, 10).map(d => ({
      name: d.user_name || 'Unnamed',
      users: Number(d.downstream_entities) || 0,
    })),
    [rankedDistributors]
  );

  // Registered vs active per level — a bar for every level with the active
  // share drawn over it as a line, so the shape of the chain and its health
  // read in one glance.
  const levelBars = useMemo(() => {
    const byLevel = kpis?.by_level || [];
    if (byLevel.length > 0) {
      return byLevel.map((r) => ({
        name: LEVEL_NAMES[Number(r.level)] || r.label || `L${r.level}`,
        registered: Number(r.entities) || 0,
        active: Number(r.active_entities) || 0,
      }));
    }
    return [
      { name: 'Distributors', registered: Number(kpis?.distributors) || 0, active: 0 },
      { name: 'Sub-Distributors', registered: Number(kpis?.sub_distributors) || 0, active: 0 },
      { name: 'Retailers', registered: Number(kpis?.retailers) || 0, active: 0 },
    ];
  }, [kpis]);

  // Per-level headline numbers, straight from the register's level breakdown
  // (the convenience counts stand in when by_level is absent).
  const levelStat = useCallback((lvl) => {
    const row = (kpis?.by_level || []).find((r) => Number(r.level) === lvl) || {};
    const fallback = { 1: kpis?.distributors, 2: kpis?.sub_distributors, 3: kpis?.retailers }[lvl];
    return {
      entities: Number(row.entities) || Number(fallback) || 0,
      active: Number(row.active_entities) || 0,
      inactive: Number(row.inactive_entities) || 0,
    };
  }, [kpis]);

  // Domain split for a single level, folded out of the category breakdown.
  const levelDomains = useCallback((lvl) => {
    const map = new Map();
    (kpis?.by_category || []).forEach((r) => {
      if (Number(r.level) !== lvl) return;
      const key = r.domain_name || r.domain_code || 'Unspecified';
      map.set(key, (map.get(key) || 0) + (Number(r.entities) || 0));
    });
    return [...map.entries()]
      .map(([label, entities]) => ({ label, entities }))
      .sort((a, b) => b.entities - a.entities);
  }, [kpis]);

  const statusDonut = useMemo(() => ([
    { name: 'Active', value: Number(kpis?.active_entities) || 0, fill: '#10b981' },
    { name: 'Canceled', value: Number(kpis?.canceled_entities) || 0, fill: '#ef4444' },
    { name: 'Inactive', value: Number(kpis?.inactive_entities) || 0, fill: '#94a3b8' },
  ].filter(s => s.value > 0)), [kpis]);

  // Domain coverage as a radar: one axis per domain, radius = users. Reads the
  // spread of the register across IDC / Yimulu / Enterprise instantly.
  const domainRadar = useMemo(
    () => (kpis?.by_domain || []).map(d => ({
      domain: (d.domain_name || d.domain_code || '—').replace(' (Indirect Channel)', ''),
      users: Number(d.entities) || 0,
    })),
    [kpis]
  );

  // How much of the register the map can actually place. Areas whose name is
  // not in the gazetteer are listed honestly rather than dropped.
  const plottedAreas = useMemo(
    () => areaCoverage.filter(a => ETHIOPIA_PLACES[normalisePlace(a.area)]).length,
    [areaCoverage]
  );

  const cov = coverage?.summary || {};
  const covAreaBars = useMemo(
    () => (coverage?.by_area || []).slice(0, 12).map(a => ({ name: a.area, retailers: a.retailers })),
    [coverage]
  );

  // Upstream coverage roll-up and the three level headlines, so every block of
  // the Executive Summary reads from the same authoritative numbers.
  const upline = coverage?.upline || {};
  const l1 = levelStat(1), l2 = levelStat(2), l3 = levelStat(3);

  if (loading && !kpis) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  const reports = [
    { key: 'summary', label: 'Executive Summary', icon: <FileBarChart size={16} /> },
    { key: 'coverage', label: 'Retailer Coverage', icon: <Globe size={16} /> },
    { key: 'sub_distributor', label: 'Sub-Distributor Report', icon: <Layers size={16} /> },
    { key: 'retailer', label: 'Retailer Report', icon: <Store size={16} /> },
    { key: 'geo', label: 'Geographic Map', icon: <MapPinned size={16} /> },
    { key: 'ranking', label: 'Distributor Ranking', icon: <Users size={16} /> },
  ];

  const levelSpec = LEVEL_REPORTS[activeReport];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-600/20">
            <FileBarChart size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">Channel Reports</h1>
            <p className="text-sm text-gray-500 mt-1">
              Who the Indirect Channel register holds — every imported user, with the Sub-Distributors and Retailers under them
            </p>
          </div>
        </div>
        <button
          onClick={() => { loadData(); loadLevelReport(); }}
          disabled={loading || levelLoading}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition shadow-sm disabled:opacity-60"
          title="Reload all reports from the server"
        >
          <RefreshCw size={14} className={loading || levelLoading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Report tabs */}
      <div className="flex gap-1 bg-white/70 backdrop-blur p-1 rounded-xl border border-gray-200 shadow-sm w-fit flex-wrap">
        {reports.map(r => (
          <button key={r.key} onClick={() => setActiveReport(r.key)}
            className={'flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition ' + (activeReport === r.key ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-sm' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100')}>
            {r.icon}
            {r.label}
          </button>
        ))}
      </div>

      {/* ── Executive Summary ─────────────────────────────────────────── */}
      {activeReport === 'summary' && kpis && (
        <div className="space-y-6">
          {/* Hero figures */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              icon={<Users size={18} />}
              label="Total Registered Users"
              value={fmtNum(kpis.total_entities)}
              sub="Directly imported across all levels"
              tone="from-blue-600 to-indigo-600"
            />
            <StatCard
              icon={<CheckCircle2 size={18} />}
              label="Active Users"
              value={fmtNum(kpis.active_entities)}
              sub={pct(kpis.active_entities, kpis.total_entities).toFixed(0) + '% of the network is active'}
              tone="from-emerald-500 to-teal-600"
            />
            <StatCard
              icon={<AlertTriangle size={18} />}
              label="Canceled / Inactive"
              value={fmtNum(kpis.canceled_entities) + ' / ' + fmtNum(kpis.inactive_entities)}
              sub="Records needing follow-up"
              tone="from-amber-500 to-orange-600"
            />
            <StatCard
              icon={<MapPin size={18} />}
              label="Areas Covered"
              value={fmtNum(kpis.geo_areas ?? kpis.distinct_geos)}
              sub="Distinct place names on the register"
              tone="from-fuchsia-500 to-purple-600"
            />
          </div>

          {/* ── Executive summary, level by level ────────────────────────────
              The register reads top-down: Distributors first, then the
              Sub-Distributors beneath them, then the Retailers. Each level gets
              its own block so the whole chain is legible at a glance. */}
          <div className="space-y-6">
            <div className="flex items-center gap-2">
              <span className="h-1 w-8 rounded-full bg-gradient-to-r from-blue-600 to-indigo-600" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-gray-700">The Chain, Level by Level</h2>
            </div>

            {/* Level 1 — Distributors */}
            <LevelSection
              badge="Level 1"
              title="Distributors"
              blurb="The top of the chain — every Distributor on the register and the network beneath them."
              icon={<Building2 size={18} />}
              tone={LEVEL_TONES[1]}
              actionLabel="Distributor Ranking"
              onAction={() => setActiveReport('ranking')}
              stats={[
                { icon: <Building2 size={14} />, label: 'Registered', value: fmtNum(l1.entities), sub: 'Distributors on the register' },
                { icon: <CheckCircle2 size={14} />, label: 'Active', value: fmtNum(l1.active), sub: pct(l1.active, l1.entities).toFixed(0) + '% of the level' },
                { icon: <AlertTriangle size={14} />, label: 'Inactive', value: fmtNum(l1.inactive), sub: 'Records needing follow-up' },
                { icon: <CornerDownRight size={14} />, label: 'Sub-Distributors', value: fmtNum(kpis.subs_under_distributors), sub: `${fmtNum(kpis.retailers_under_distributors)} retailers beneath` },
              ]}
            >
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <ChartCard title="Top Distributors by Downstream Users" note="How many Sub-Distributors and Retailers hang beneath each Distributor" icon={<Users size={16} />}>
                  {rankingBars.length === 0 ? (
                    <EmptyChart label="No Distributor has downstream users yet" />
                  ) : (
                    <ResponsiveContainer width="100%" height={Math.max(260, rankingBars.length * 30)}>
                      <BarChart data={rankingBars} layout="vertical" margin={{ left: 8, right: 24 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={170} />
                        <Tooltip formatter={(v) => fmtNum(v)} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                        <Bar dataKey="users" name="Downstream users" fill="#6366f1" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </ChartCard>
                <DimensionSplit title="Distributors by Domain" note="Where the Distributor base sits across domains" rows={levelDomains(1)} />
              </div>
            </LevelSection>

            {/* Level 2 — Sub-Distributors */}
            <LevelSection
              badge="Level 2"
              title="Sub-Distributors"
              blurb="The middle of the chain — the Sub-Distributors that sit between Distributors and the retailer base."
              icon={<Layers size={18} />}
              tone={LEVEL_TONES[2]}
              actionLabel="Sub-Distributor Report"
              onAction={() => setActiveReport('sub_distributor')}
              stats={[
                { icon: <Layers size={14} />, label: 'Registered', value: fmtNum(l2.entities), sub: 'Sub-Distributors on the register' },
                { icon: <CheckCircle2 size={14} />, label: 'Active', value: fmtNum(l2.active), sub: pct(l2.active, l2.entities).toFixed(0) + '% of the level' },
                { icon: <AlertTriangle size={14} />, label: 'Inactive', value: fmtNum(l2.inactive), sub: 'Records needing follow-up' },
                { icon: <CornerDownRight size={14} />, label: 'Retailers beneath', value: fmtNum(kpis.retailers_under_sub_distributors), sub: 'Reporting through a Sub-Distributor' },
              ]}
            >
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <DimensionSplit title="Sub-Distributors by Domain" note="Where the Sub-Distributor base sits across domains" rows={levelDomains(2)} />
                <CoverageMeter
                  title="Retailer Reach"
                  note="How many Sub-Distributors have at least one retailer reporting to them"
                  covered={upline.sub_distributors?.covered}
                  total={upline.sub_distributors?.total}
                  tail="retailer"
                />
              </div>
            </LevelSection>

            {/* Level 3 — Retailers */}
            <LevelSection
              badge="Level 3"
              title="Retailers"
              blurb="The bottom of the chain — the retailer base that actually sells, and where it reaches."
              icon={<Store size={18} />}
              tone={LEVEL_TONES[3]}
              actionLabel="Retailer Report"
              onAction={() => setActiveReport('retailer')}
              stats={[
                { icon: <Store size={14} />, label: 'Registered', value: fmtNum(l3.entities), sub: 'Retailers on the register' },
                { icon: <CheckCircle2 size={14} />, label: 'Active', value: fmtNum(l3.active), sub: pct(l3.active, l3.entities).toFixed(0) + '% of the level' },
                { icon: <AlertTriangle size={14} />, label: 'Inactive', value: fmtNum(l3.inactive), sub: 'Records needing follow-up' },
                { icon: <MapPinned size={14} />, label: 'Areas covered', value: fmtNum(cov.areas_with_retailers), sub: `of ${fmtNum(cov.total_areas)} areas on the register` },
              ]}
            >
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <ChartCard title="Retailers by Area" note="The areas carrying the most retailers" icon={<MapPinned size={16} />}>
                  {covAreaBars.length === 0 ? (
                    <EmptyChart label="No retailer is placed yet" />
                  ) : (
                    <ResponsiveContainer width="100%" height={Math.max(260, covAreaBars.length * 30)}>
                      <BarChart data={covAreaBars} layout="vertical" margin={{ left: 8, right: 24 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={150} />
                        <Tooltip formatter={(v) => fmtNum(v)} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                        <Bar dataKey="retailers" name="Retailers" fill="#10b981" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </ChartCard>
                <DimensionSplit title="Retailers by Domain" note="Where the retailer base sits across domains" rows={levelDomains(3)} />
              </div>
              {(coverage?.gaps || []).length > 0 && (
                <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-4">
                  <p className="text-xs font-semibold text-amber-900 mb-2">
                    {fmtNum(coverage.gaps.length)} area(s) have users but no retailer yet
                  </p>
                  <div className="flex flex-wrap gap-2 max-h-[120px] overflow-y-auto">
                    {coverage.gaps.slice(0, 18).map((g) => (
                      <span key={g.area} className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md bg-white border border-amber-200 text-amber-900">
                        <AlertTriangle size={11} /> {g.area} · {fmtNum(g.entities)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </LevelSection>
          </div>

          {/* Level composition + status mix */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <ChartCard
              className="lg:col-span-2"
              title="Network Composition"
              note="Members of the chain per level — uplines a file named are included — with the active share drawn over them"
              icon={<Building2 size={16} />}
            >
              {levelBars.every(l => l.registered === 0) ? (
                <EmptyChart label="No users registered yet" />
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={levelBars} margin={{ top: 16, right: 16, left: -12, bottom: 0 }}>
                    <defs>
                      <linearGradient id="reportLevelBar" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#6366f1" stopOpacity={0.95} />
                        <stop offset="100%" stopColor="#60a5fa" stopOpacity={0.55} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                    <Tooltip formatter={(v) => fmtNum(v)} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="registered" name="Registered" fill="url(#reportLevelBar)" radius={[8, 8, 0, 0]} maxBarSize={90}>
                      <LabelList dataKey="registered" position="top" style={{ fontSize: 11, fill: '#475569', fontWeight: 600 }} />
                    </Bar>
                    <Line type="monotone" dataKey="active" name="Active" stroke="#10b981" strokeWidth={3} dot={{ r: 5, fill: '#10b981' }} activeDot={{ r: 7 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            <ChartCard title="Status Mix" note="Every imported user by status" icon={<Sparkles size={16} />}>
              {statusDonut.length === 0 ? (
                <EmptyChart label="Nothing recorded yet" />
              ) : (
                <div className="relative">
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie data={statusDonut} dataKey="value" nameKey="name" innerRadius={64} outerRadius={94} paddingAngle={3} stroke="none">
                        {statusDonut.map((s, i) => (<Cell key={i} fill={s.fill} />))}
                      </Pie>
                      <Tooltip formatter={(v) => fmtNum(v)} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none" style={{ height: 240 }}>
                    <span className="text-2xl font-bold text-gray-900">{fmtNum(kpis.total_entities)}</span>
                    <span className="text-[11px] uppercase tracking-wider text-gray-400">users</span>
                  </div>
                </div>
              )}
              <div className="mt-3 space-y-1.5">
                {statusDonut.map(s => (
                  <div key={s.name} className="flex items-center gap-2 text-xs">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.fill }} />
                    <span className="text-gray-600 flex-1">{s.name}</span>
                    <span className="font-semibold text-gray-800">{fmtNum(s.value)}</span>
                    <span className="text-gray-400 w-12 text-right">{pct(s.value, kpis.total_entities).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </ChartCard>
          </div>

          {/* Domain spread + the level cards that jump into each report */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <ChartCard
              className="lg:col-span-2"
              title="Domain Spread"
              note="How the register is distributed across domains"
              icon={<Globe size={16} />}
            >
              {domainRadar.length === 0 ? (
                <EmptyChart label="No domains recorded yet" />
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <RadarChart data={domainRadar} outerRadius="72%">
                    <PolarGrid stroke="#e2e8f0" />
                    <PolarAngleAxis dataKey="domain" tick={{ fontSize: 12, fill: '#64748b' }} />
                    <PolarRadiusAxis tick={{ fontSize: 10, fill: '#cbd5e1' }} allowDecimals={false} />
                    <Radar name="Users" dataKey="users" stroke="#6366f1" fill="#6366f1" fillOpacity={0.35} />
                    <Tooltip formatter={(v) => fmtNum(v)} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                  </RadarChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            <div className="space-y-4">
              <LevelMiniStat label="Distributors (Level 1)" value={fmtNum(kpis.distributors)} tone="indigo" />
              <LevelMiniStat label="Sub-Distributors (Level 2)" value={fmtNum(kpis.sub_distributors)}
                onOpen={() => setActiveReport('sub_distributor')} />
              <LevelMiniStat label="Retailers (Level 3)" value={fmtNum(kpis.retailers)}
                onOpen={() => setActiveReport('retailer')} />
            </div>
          </div>

          {matrix && matrix.rows?.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-800">Domain & Category Breakdown</h3>
                  <p className="text-xs text-gray-500 mt-0.5">How users split across the register</p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600">Domain</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-600">Category</th>
                      <th className="px-4 py-2.5 text-center text-xs font-semibold text-gray-600">Level</th>
                      <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-600">Users</th>
                      <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-600">Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.rows.map((r, i) => (
                      <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="px-4 py-2.5 font-medium text-gray-800">{r.domain_name}</td>
                        <td className="px-4 py-2.5 text-gray-600">{r.category_name}</td>
                        <td className="px-4 py-2.5 text-center">
                          <span className="inline-block px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium">
                            L{r.level}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-semibold text-gray-900">{fmtNum(r.entities)}</td>
                        <td className="px-4 py-2.5 text-right text-emerald-600">{fmtNum(r.active_entities)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Retailer Coverage — how far the retailer base reaches ──────── */}
      {activeReport === 'coverage' && (
        coverage ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard icon={<Store size={18} />} label="Retailers" value={fmtNum(cov.retailers)}
                sub={cov.retailers ? `${fmtNum(cov.active_entities)} active · ${fmtNum(cov.inactive_entities)} inactive` : 'None on the register yet'}
                tone="from-emerald-500 to-green-600" />
              <StatCard icon={<CheckCircle2 size={18} />} label="Active Retailers" value={pct(cov.active_entities, cov.retailers).toFixed(0) + '%'}
                sub={`${fmtNum(cov.active_entities)} of ${fmtNum(cov.retailers)} trading`} tone="from-blue-600 to-indigo-600" />
              <StatCard icon={<MapPinned size={18} />} label="Areas Covered" value={`${fmtNum(cov.areas_with_retailers)} / ${fmtNum(cov.total_areas)}`}
                sub={pct(cov.areas_with_retailers, cov.total_areas).toFixed(0) + '% of the areas on the register'} tone="from-cyan-500 to-blue-600" />
              <StatCard icon={<Navigation size={18} />} label="Areas Without a Retailer" value={fmtNum((coverage.gaps || []).length)}
                sub="Users sit there, but no retailer yet" tone="from-amber-500 to-orange-600" />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <ChartCard
                className="lg:col-span-2"
                title="Retailer Coverage by Area"
                note="Retailers placed in each area — the top 12 by count"
                icon={<Globe size={16} />}
              >
                {covAreaBars.length === 0 ? (
                  <EmptyChart label="No retailer is placed yet" />
                ) : (
                  <ResponsiveContainer width="100%" height={Math.max(260, covAreaBars.length * 30)}>
                    <BarChart data={covAreaBars} layout="vertical" margin={{ left: 8, right: 24 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v) => fmtNum(v)} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                      <Bar dataKey="retailers" name="Retailers" fill="#10b981" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>

              <ChartCard
                title="Upline Coverage"
                note="Of every Distributor and Sub-Distributor on the register — how many have at least one retailer directly beneath them"
                icon={<Layers size={16} />}
              >
                <div className="space-y-5">
                  {[
                    ['Distributors', coverage.upline?.distributors, 'retailers selling directly for them'],
                    ['Sub-Distributors', coverage.upline?.sub_distributors, 'retailers reporting to them'],
                  ].map(([label, d, tail]) => {
                    const total = Number(d?.total) || 0;
                    const covered = Number(d?.covered) || 0;
                    const share = total ? (covered / total) * 100 : 0;
                    return (
                      <div key={label}>
                        <div className="flex items-center justify-between text-xs mb-1.5">
                          <span className="font-medium text-gray-600">{label}</span>
                          <span className="text-gray-500 tabular-nums">{fmtNum(covered)} / {fmtNum(total)} · {share.toFixed(0)}%</span>
                        </div>
                        <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                          <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-600 transition-all duration-700" style={{ width: `${share}%` }} />
                        </div>
                        <p className="text-[10px] text-gray-400 mt-1">
                          {fmtNum(covered)} of {fmtNum(total)} {label.toLowerCase()} have {tail} · {fmtNum(Math.max(0, total - covered))} have none
                        </p>
                      </div>
                    );
                  })}
                </div>
              </ChartCard>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <DimensionSplit
                title="Retailers by Domain"
                note="Which domains the retailer base actually sits in"
                rows={(coverage.by_domain || []).map(d => ({ label: d.domain_name || d.domain_code, entities: d.retailers }))}
              />

              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-800">Areas Still Without a Retailer</h3>
                  <p className="text-xs text-gray-500 mt-0.5">The register carries users here, but no retailer is placed yet</p>
                </div>
                {(coverage.gaps || []).length === 0 ? (
                  <p className="px-5 py-8 text-center text-sm text-gray-500">Every recorded area has at least one retailer.</p>
                ) : (
                  <div className="p-4 flex flex-wrap gap-2 max-h-[280px] overflow-y-auto">
                    {coverage.gaps.map(g => (
                      <span key={g.area} className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md bg-amber-50 border border-amber-200 text-amber-900">
                        <AlertTriangle size={11} /> {g.area} · {fmtNum(g.entities)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-800">Retailer Coverage by Area</h3>
                <p className="text-xs text-gray-500 mt-0.5">Every area that holds a retailer, and the share of the retailer base it carries</p>
              </div>
              <div className="max-h-[440px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr className="border-b border-gray-200">
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Area</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600">Retailers</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600">Active</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600">Share of retail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(coverage.by_area || []).map((a, i) => {
                      const share = cov.retailers ? (a.retailers / cov.retailers) * 100 : 0;
                      return (
                        <tr key={a.area + i} className="border-b border-gray-50 hover:bg-blue-50/40">
                          <td className="px-4 py-2.5 text-gray-800 max-w-[180px]">
                            <span className="flex items-center gap-1.5">
                              {ETHIOPIA_PLACES[normalisePlace(a.area)] && (
                                <MapPin size={12} className="text-blue-500 shrink-0" />
                              )}
                              <span className="truncate" title={a.area}>{a.area}</span>
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-medium text-gray-700">{fmtNum(a.retailers)}</td>
                          <td className="px-4 py-2.5 text-right text-emerald-600">{fmtNum(a.active_entities)}</td>
                          <td className="px-4 py-2.5 text-right">
                            <span className="flex items-center justify-end gap-2">
                              <span className="hidden sm:block w-16 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                                <span className="block h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-600" style={{ width: Math.max(4, share) + '%' }} />
                              </span>
                              <span className="text-gray-500 w-10 text-right">{share.toFixed(1)}%</span>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
          </div>
        ) : (
          <p className="py-16 text-center text-sm text-gray-400">Retailer coverage is not available yet.</p>
        )
      )}

      {/* ── Level reports: Distributor / Sub-Distributor / Retailer ───── */}
      {levelSpec && (
        <LevelReport
          spec={levelSpec}
          data={levelReport}
          loading={levelLoading}
          page={levelPage}
          setPage={setLevelPage}
          searchInput={searchInput}
          setSearchInput={setSearchInput}
          onSearch={() => { setLevelSearch(searchInput.trim()); setLevelPage(1); }}
          onClearSearch={() => { setSearchInput(''); setLevelSearch(''); setLevelPage(1); }}
          hasSearch={Boolean(levelSearch)}
          onVerifyEntity={(r) => setSingleVerifyEntity(r)}
          onOpenBatchVerify={() => setBatchVerifyOpen(true)}
          onEditEntity={(r) => setEditingEntity(r)}
          onDeleteEntity={(r) => setDeletingEntity(r)}
        />
      )}

      {/* ── Geographic Map — where the register actually sits ─────────── */}
      {activeReport === 'geo' && geo && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard icon={<MapPinned size={18} />} label="Covered Areas" value={fmtNum(geo.distinct_areas)}
              sub="Distinct place names" tone="from-cyan-500 to-blue-600" />
            <StatCard icon={<Navigation size={18} />} label="Placed on the map" value={pct(plottedAreas, areaCoverage.length).toFixed(0) + '%'}
              sub={`${fmtNum(plottedAreas)} of ${fmtNum(areaCoverage.length)} areas located`} tone="from-emerald-500 to-teal-600" />
            <StatCard icon={<Store size={18} />} label={topAreas.length > 1 ? `Top Areas · ${topAreas.length} tied` : 'Top Area'}
              value={topAreas.length === 0 ? '—' : topAreas.length === 1 ? topAreas[0].area : `${topAreas[0].area} +${topAreas.length - 1}`}
              sub={topAreas.length === 0 ? null : topAreas.length === 1
                ? `${fmtNum(topAreas[0].entities)} users · ${topAreas[0].share.toFixed(1)}% of network`
                : `Each with ${fmtNum(topAreas[0].entities)} users · ${topAreas[0].share.toFixed(1)}% of network`}
              tone="from-fuchsia-500 to-purple-600" />
            <StatCard icon={<Layers size={18} />} label="Top 5 Areas" value={(areaCoverage.slice(0, 5).reduce((a, x) => a + x.share, 0)).toFixed(1) + '%'}
              sub="Share of the whole network" tone="from-amber-500 to-orange-600" />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <GeoMap className="xl:col-span-2" areas={areaCoverage} />

            <div className="bg-white rounded-2xl border border-gray-200/80 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-800">Area Coverage</h3>
                <p className="text-xs text-gray-500 mt-0.5">Every recorded area and its share of the network</p>
              </div>
              <div className="max-h-[520px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr className="border-b border-gray-200">
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Area</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600">Users</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {areaCoverage.map((a, i) => (
                      <tr key={a.area + i} className="border-b border-gray-50 hover:bg-blue-50/40">
                        <td className="px-4 py-2.5 text-gray-800 max-w-[150px]">
                          <span className="flex items-center gap-1.5">
                            {ETHIOPIA_PLACES[normalisePlace(a.area)] && (
                              <MapPin size={12} className="text-blue-500 shrink-0" />
                            )}
                            <span className="truncate" title={a.area}>{a.area}</span>
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium text-gray-700">{fmtNum(a.entities)}</td>
                        <td className="px-4 py-2.5 text-right">
                          <span className="flex items-center justify-end gap-2">
                            <span className="hidden sm:block w-16 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                              <span className="block h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500" style={{ width: Math.max(4, a.share) + '%' }} />
                            </span>
                            <span className="text-gray-500 w-10 text-right">{a.share.toFixed(1)}%</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Distributor Ranking ───────────────────────────────────────── */}
      {activeReport === 'ranking' && topDist && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-800 mb-1">Top 3 Owners by Downstream Users</h3>
            <p className="text-xs text-gray-500 mb-4">How many Sub-Distributors and Retailers hang beneath each owner</p>
            {rankingBars.length === 0 ? (
              <p className="text-sm text-gray-400 py-10 text-center">No owner has downstream users yet.</p>
            ) : (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={rankingBars} layout="vertical" margin={{ left: 8, right: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={170} />
                  <Tooltip formatter={(v) => fmtNum(v)} />
                  <Bar dataKey="users" fill="#f59e0b" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-800">Ranking Table</h3>
              <p className="text-xs text-gray-500 mt-1">Ranked by how many users sit underneath each owner</p>
            </div>
            <div className="overflow-x-auto">
            {rankedDistributors.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-gray-500">No owner has any downstream user yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 w-12">#</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Owner</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Domain</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Category</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">Downstream Users</th>
                  </tr>
                </thead>
                <tbody>
                  {rankedDistributors.map((d, i) => (
                    <tr key={d.entity_id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-500">{i + 1}</td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-800">{d.user_name}</p>
                        <p className="text-xs text-gray-500">{d.mobile_number}</p>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{d.domain_name}</td>
                      <td className="px-4 py-3 text-gray-600">{d.category_label}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">{fmtNum(d.downstream_entities)}</td>
                    </tr>
                  ))}
                </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Single Entity Verify Modal ───────────────────────────────── */}
      <VerifySingleTinModal
        isOpen={Boolean(singleVerifyEntity)}
        entity={singleVerifyEntity}
        onClose={() => setSingleVerifyEntity(null)}
        onVerified={() => { loadLevelReport(); loadData(); }}
      />

      {/* ── Batch TIN Verify Modal ──────────────────────────────────── */}
      <BatchVerifyTinsModal
        isOpen={batchVerifyOpen}
        onClose={() => setBatchVerifyOpen(false)}
        onVerified={() => { loadLevelReport(); loadData(); }}
      />

      {/* ── Edit Entity Modal ────────────────────────────────────────── */}
      <EditEntityModal
        isOpen={Boolean(editingEntity)}
        entity={editingEntity}
        onClose={() => setEditingEntity(null)}
        onUpdated={() => { loadLevelReport(); loadData(); }}
      />

      {/* ── Delete Entity Modal ──────────────────────────────────────── */}
      <DeleteEntityModal
        isOpen={Boolean(deletingEntity)}
        entity={deletingEntity}
        onClose={() => setDeletingEntity(null)}
        onDeleted={() => { loadLevelReport(); loadData(); }}
      />
    </div>
  );
}

/** One level's report: headline, the two data dimensions, and the detail table. */
function LevelReport({
  spec, data, loading, page, setPage,
  searchInput, setSearchInput, onSearch, onClearSearch, hasSearch,
  onVerifyEntity, onOpenBatchVerify, onEditEntity, onDeleteEntity,
}) {
  // Editing and deleting registered records is a grant, not a given: a role
  // needs channel_entities.edit / channel_entities.delete (the master admin
  // holds every permission, so the buttons simply appear for them).
  const { hasAnyPermission } = useAuth();
  const canEdit = hasAnyPermission('channel_entities.edit');
  const canDelete = hasAnyPermission('channel_entities.delete');
  const canModify = canEdit || canDelete;
  const s = data?.summary || {};
  const Icon = spec.icon;

  // ── Column preferences ──
  // The level decides which columns exist; the operator decides which of them
  // to show. Choices persist per table in localStorage.
  const colDefs = useMemo(() => {
    const base = [
      { key: 'name', label: 'Name', always: true },
      { key: 'identifier', label: 'Identifier Code' },
      { key: 'tin', label: 'TIN' },
      { key: 'verify', label: 'Verify' },
      { key: 'geo', label: 'Region / Domain' },
      ...(spec.level === 3 ? [{ key: 'business', label: 'Business' }] : []),
      { key: 'product', label: 'Air Time' },
      { key: 'status', label: 'Status' },
      ...(spec.parentColumn ? [{ key: 'parent', label: spec.parentColumn }] : []),
      ...(spec.level === 3 ? [{ key: 'owner', label: 'Distributor' }] : []),
      { key: 'location', label: 'Street Address' },
      ...(spec.level === 1 ? [
        { key: 'subdists', label: 'Sub-Dists' },
        { key: 'retailers', label: 'Retailers' },
        { key: 'children', label: 'Direct' },
      ] : []),
      ...(spec.level === 2 ? [{ key: 'retailers', label: 'Retailers' }] : []),
      { key: 'imported', label: 'Imported by' },
      ...(canModify ? [{ key: 'actions', label: 'Actions', always: true }] : []),
    ];
    return base;
  }, [spec.level, spec.parentColumn, canModify]);
  const allColKeys = useMemo(() => colDefs.map((c) => c.key), [colDefs]);
  const storageKey = `channel_cols_${spec.level}`;
  const [visibleCols, setVisibleCols] = useState(() => loadColumnPrefs(storageKey, allColKeys));
  useEffect(() => {
    setVisibleCols(loadColumnPrefs(storageKey, allColKeys));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, allColKeys.join(',')]);
  const show = (k) => visibleCols.has(k);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={<Icon size={18} />}
          label={`${spec.title.replace(' Report', '')}s`}
          value={fmtNum(s.entities)}
          sub="Registered on this level"
          tone={spec.level === 3 ? 'from-emerald-500 to-green-600' : 'from-cyan-500 to-blue-600'} />
        <StatCard icon={<CheckCircle2 size={18} />} label="Active" value={fmtNum(s.active_entities)}
          sub={s.entities ? pct(s.active_entities, s.entities).toFixed(0) + '% of this level' : null}
          tone="from-blue-600 to-indigo-600" />
        <StatCard icon={<AlertTriangle size={18} />} label="Canceled / Inactive"
          value={fmtNum(s.canceled_entities) + ' / ' + fmtNum(s.inactive_entities)}
          sub="Status" tone="from-amber-500 to-orange-600" />
        <StatCard icon={<MapPin size={18} />} label="Areas Covered" value={fmtNum(s.areas)}
          sub="Distinct place names" tone="from-fuchsia-500 to-purple-600" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <DimensionSplit
          title="By Air Time Type"
          note="Product carried by this level."
          rows={data?.by_product}
        />
        {/* Only a Retailer carries an Existing Business, so the split is
            meaningless on the Sub-Distributor report and is not shown. */}
        {spec.level === 3 && (
          <DimensionSplit
            title="By Existing Business"
            note="The business these users run."
            rows={data?.by_business_type}
          />
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200/80 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">{spec.title.replace(' Report', '')} Details</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {fmtNum(data?.pagination?.total || 0)} record(s)
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <ColumnPicker
              columns={colDefs}
              visible={visibleCols}
              setVisible={setVisibleCols}
              storageKey={storageKey}
            />
            <button
              onClick={onOpenBatchVerify}
              className="flex items-center gap-1.5 px-3 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
              title="Batch verify all imported records with TINs against Ethiopian eTrade & MoR database"
            >
              <ShieldCheck size={15} />
              Batch Verify TINs
            </button>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text" value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSearch(); } }}
                placeholder="Name, mobile, TIN, area…"
                className="pl-9 pr-3 py-2 w-52 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <button onClick={onSearch} className="px-3 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200">
              Search
            </button>
            {hasSearch && (
              <button onClick={onClearSearch} className="px-3 py-2 text-sm text-gray-500 hover:text-gray-800">
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Every level reads as a table — the retailer report included. */}
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 size={24} className="text-blue-500 animate-spin" />
          </div>
        ) : (data?.rows || []).length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-gray-500">
            No {spec.title.replace(' Report', '').toLowerCase()} matches these filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 w-10">#</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{spec.title.replace(' Report', '')}</th>
                  {show('identifier') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Identifier Code</th>}
                  {show('tin') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">TIN</th>}
                  {show('verify') && <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600">Verify</th>}
                  {show('geo') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Region / Domain</th>}
                  {spec.level === 3 && show('business') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Business</th>}
                  {show('product') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Air Time</th>}
                  {show('status') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Status</th>}
                  {spec.parentColumn && show('parent') && (
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">{spec.parentColumn}</th>
                  )}
                  {spec.level === 3 && show('owner') && (
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Distributor</th>
                  )}
                  {show('location') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Street Address</th>}
                  {spec.level === 1 && show('subdists') && (
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">Sub-Dists</th>
                  )}
                  {spec.level === 1 && show('retailers') && (
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">Retailers</th>
                  )}
                  {spec.level === 1 && show('children') && (
                    <th className="px-4 py-3 text-right font-semibold text-gray-900">{fmtNum(s.entities)}</th>
                  )}
                  {spec.level === 2 && show('retailers') && (
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">Retailers</th>
                  )}
                  {show('imported') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Imported by</th>}
                  {canModify && show('actions') && (
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600 w-24">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {(data.rows || []).map((r, i) => (
                  <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-400">{(page - 1) * PAGE_SIZE + i + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        {/* Manager photo from the record's TIN — a neutral image
                            icon when there is none, so every row reads the same. */}
                        <ManagerPhoto
                          tin={r.has_photo ? r.tin : null}
                          alt={r.user_name}
                          className="w-9 h-9 rounded-full object-cover border border-gray-200 shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-gray-800 max-w-[200px] truncate" title={r.user_name}>{r.user_name}</p>
                          <p className="text-xs text-gray-500 font-mono">{r.mobile_number}</p>
                          {r.trade_name && r.trade_name !== r.user_name && (
                            <p className="text-[11px] text-emerald-700 truncate max-w-[200px]" title={`eTrade Company Name: ${r.trade_name}`}>
                              🏢 {r.trade_name}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    {show('identifier') && (
                      <td className="px-4 py-3">
                        <IdentifierChip code={r.identifier_code} />
                      </td>
                    )}
                    {show('tin') && (
                      <td className="px-4 py-3">
                        {r.tin ? (
                          <span className="font-mono text-xs text-gray-800 font-semibold">{r.tin}</span>
                        ) : (
                          <span className="text-gray-300 text-xs">—</span>
                        )}
                      </td>
                    )}
                    {show('verify') && <td className="px-4 py-3 text-center">
                      {/* Verification reads as a word, not a guess from icons:
                          Verified when the record carries an eTrade match,
                          Non Verified otherwise — one click to verify or re-verify. */}
                      {/* Icons only: a green check means verified, a red X means
                          not yet — and the X itself is the button that verifies. */}
                      {(r.trade_name || r.photo_keywords) ? (
                        <span className="inline-flex items-center justify-center gap-1">
                          <CheckCircle2 size={18} className="text-emerald-500" title="Verified" />
                          <button
                            onClick={() => onVerifyEntity(r)}
                            className="text-gray-400 hover:text-blue-600 p-0.5 rounded transition"
                            title="Re-verify TIN and sync profile"
                          >
                            <RefreshCw size={13} />
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => onVerifyEntity(r)}
                          className="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg transition"
                          title="Not verified — click to verify TIN against eTrade / Ministry of Revenue"
                        >
                          <XCircle size={18} />
                        </button>
                      )}
                    </td>}
                    {show('geo') && (
                      <td className="px-4 py-3 text-gray-600 max-w-[150px] truncate" title={r.geo_domain_raw || ''}>
                        {r.geo_domain_raw || '—'}
                      </td>
                    )}
                    {spec.level === 3 && show('business') && (
                      <td className="px-4 py-3 text-gray-600 max-w-[150px] truncate" title={r.business_type || ''}>{r.business_type || '—'}</td>
                    )}
                    {show('product') && <td className="px-4 py-3 text-gray-600">{r.product || '—'}</td>}
                    {show('status') && (
                      <td className="px-4 py-3">
                        <StatusPill status={r.status} />
                      </td>
                    )}
                    {spec.parentColumn && show('parent') && (
                      <td className="px-4 py-3 text-gray-600 max-w-[180px] truncate" title={r.parent_name || ''}>
                        {r.parent_name || '—'}
                      </td>
                    )}
                    {spec.level === 3 && show('owner') && (
                      <td className="px-4 py-3 text-gray-600 max-w-[180px] truncate" title={r.owner_name || ''}>
                        {r.owner_name || '—'}
                      </td>
                    )}
                    {show('location') && <td className="px-4 py-3 text-gray-600 max-w-[200px]">
                      <span className="block truncate font-medium text-gray-700" title={r.location || ''}>
                        {r.location || '—'}
                      </span>
                      {(r.sub_city || r.woreda || r.house_no) && (
                        <span className="text-[10px] text-gray-400 block truncate" title={[r.sub_city, r.woreda, r.house_no ? `H.No ${r.house_no}` : ''].filter(Boolean).join(' · ')}>
                          {[r.sub_city, r.woreda, r.house_no ? `H.No ${r.house_no}` : ''].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </td>}
                    {spec.level === 1 && show('subdists') && (
                      <td className="px-4 py-3 text-right text-gray-600" title="Distinct Sub-Distributors of the Retailers this Distributor owns">{fmtNum(r.subs_through ?? r.sub_distributors)}</td>
                    )}
                    {(spec.level === 1 || spec.level === 2) && show('retailers') && (
                      <td className="px-4 py-3 text-right text-gray-600">{fmtNum(r.retailers)}</td>
                    )}
                    {spec.level === 1 && show('children') && (
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">{fmtNum(r.direct_children)}</td>
                    )}
                    {show('imported') && (
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span title={r.imported_at ? `Imported ${r.imported_at}` : undefined}>
                          {r.import_code
                            ? <span className="block font-mono text-xs font-medium text-blue-700">{r.import_code}</span>
                            : <span className="text-xs text-gray-300">registered by hand</span>}
                          {r.import_code && r.imported_at && (
                            <span className="block text-[10px] text-gray-400">{r.imported_at}</span>
                          )}
                        </span>
                      </td>
                    )}
                    {canModify && show('actions') && (
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {canEdit && (
                            <button
                              onClick={() => onEditEntity(r)}
                              className="p-1.5 text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-lg transition"
                              title="Edit record"
                            >
                              <Edit3 size={15} />
                            </button>
                          )}
                          {canDelete && (
                            <button
                              onClick={() => onDeleteEntity(r)}
                              className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg transition"
                              title="Delete record"
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {(data?.pagination?.pages || 0) > 1 && (
          <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
            <p className="text-xs text-gray-500">
              Page {data.pagination.page} of {fmtNum(data.pagination.pages)} · {fmtNum(data.pagination.total)} record(s)
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(Math.max(page - 1, 1))}
                disabled={page <= 1}
                className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <button
                onClick={() => setPage(page + 1)}
                disabled={page >= data.pagination.pages}
                className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Modal for verifying an individual retailer's TIN — shows what the official
 *  record carries and lets the operator tick exactly which registered fields
 *  (business name, phone, location, geo domain, photo) to replace. */
function VerifySingleTinModal({ isOpen, onClose, entity, onVerified }) {
  const [loading, setLoading] = useState(false);
  const [verifyRes, setVerifyRes] = useState(null);
  const [choices, setChoices] = useState([]);
  const [sel, setSel] = useState({});
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setVerifyRes(null);
      setChoices([]);
      setSel({});
      setApplying(false);
      setDone(false);
    }
  }, [isOpen, entity]);

  if (!isOpen || !entity) return null;

  // Step 1 — fetch the official record (no registered data changes yet).
  async function handleVerify() {
    setLoading(true);
    try {
      const res = await channelAPI.verifyEntityTin(entity.id, {
        fields: [],
        tin: entity.tin,
      });
      if (res && res.found) {
        const list = buildVerifyChoices(entity, null, res.data ? { ...res.data, photo: res.photo } : {});
        setVerifyRes(res);
        setChoices(list);
        setSel(Object.fromEntries(list.map((c) => [c.field, false])));
        toast.success(`TIN Verified: ${res.data?.trade_name || entity.tin}`);
      } else {
        setVerifyRes(null);
        setChoices([]);
        toast.error(res?.message || 'TIN not found in eTrade / Ministry of Revenue database');
      }
    } catch (err) {
      toast.error('Verification failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  // Step 2 — replace only the ticked fields on the registered record.
  async function handleApply() {
    const fields = choices.filter((c) => sel[c.field]).map((c) => c.field);
    if (!fields.length) {
      toast.error('Select at least one field to replace');
      return;
    }
    setApplying(true);
    try {
      await channelAPI.verifyEntityTin(entity.id, { fields, tin: entity.tin });
      toast.success(`Replaced ${fields.length} field${fields.length === 1 ? '' : 's'} from the official record`);
      setDone(true);
      if (onVerified) onVerified();
    } catch (err) {
      toast.error(err.message || 'Could not replace the selected fields');
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-gray-100">
        <div className="flex items-center justify-between pb-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900">Verify TIN with eTrade / MoR</h3>
              <p className="text-xs text-gray-500">Ministry of Revenue & Trade Database</p>
            </div>
          </div>
          <button onClick={onClose} disabled={loading} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="py-4 space-y-4">
          <div className="bg-gray-50 p-3.5 rounded-xl border border-gray-200 text-sm space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-gray-500">Entity Name:</span>
              <span className="font-semibold text-gray-800">{entity.user_name}</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-gray-500">Mobile Number:</span>
              <span className="font-mono text-gray-800">{entity.mobile_number}</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-gray-500">TIN Number:</span>
              <span className="font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded">{entity.tin}</span>
            </div>
          </div>

          {!verifyRes ? (
            <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-3.5 text-xs">
              <p className="font-semibold text-amber-900">What verification checks</p>
              <p className="text-amber-800 mt-1 leading-relaxed">
                The official eTrade / MoR record for this TIN is fetched and compared
                with what is registered. You then choose exactly which fields to
                replace — nothing changes until you confirm.
              </p>
            </div>
          ) : done ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-xs space-y-2">
              <div className="flex items-center gap-1.5 text-emerald-800 font-bold">
                <CheckCircle2 size={16} className="text-emerald-600" />
                <span>Registered data replaced</span>
              </div>
              <p className="text-emerald-900 text-[11px]">
                The ticked fields now carry the official values. The table refreshes when you close this dialog.
              </p>
            </div>
          ) : (
            <div className="bg-amber-50/80 border border-amber-300 rounded-xl p-3.5">
              <p className="text-xs font-bold text-amber-900 flex items-center gap-1.5">
                <AlertTriangle size={13} />
                Replace registered data with the official record?
              </p>
              <p className="text-[11px] text-amber-800 mt-1">
                Official record: <span className="font-semibold">{verifyRes.data?.trade_name || '—'}</span>
              </p>
              <div className="mt-2.5 space-y-1.5">
                {choices.map((c) => (
                  <label key={c.field} className="flex items-start gap-2.5 bg-white/70 border border-amber-200 rounded-lg px-2.5 py-2 cursor-pointer hover:bg-white transition">
                    <input
                      type="checkbox"
                      checked={Boolean(sel[c.field])}
                      onChange={(e) => setSel((prev) => ({ ...prev, [c.field]: e.target.checked }))}
                      disabled={applying}
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
                {choices.length === 0 && (
                  <p className="text-[11px] text-emerald-800 font-medium bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-2">
                    ✓ The registered data already matches the official record — nothing to replace.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
          {!verifyRes || done ? (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition"
            >
              {done ? 'Done' : 'Close'}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={applying}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition"
              >
                Cancel
              </button>
              {choices.length > 0 && (
                <button
                  type="button"
                  onClick={handleApply}
                  disabled={applying || !Object.values(sel).some(Boolean)}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-60 rounded-lg shadow-sm transition"
                >
                  {applying ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                  {applying ? 'Replacing...' : 'Replace Selected'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Modal for batch verifying records with TINs — pick which records to check
 *  (all, or a search-filtered subset) and tick exactly which registered fields
 *  the run may replace. Verification itself never changes data; replacement
 *  only happens for the consented fields. */
const BATCH_FIELD_OPTIONS = [
  { key: 'business_name', label: 'Business Name' },
  { key: 'phone', label: 'Phone Number' },
  { key: 'location', label: 'Street Address (Sub-City, Woreda, House No)' },
  { key: 'geo_domain', label: 'Geographical Domain' },
  { key: 'photo', label: 'Manager Photo (replaces custom uploads)' },
];

function BatchVerifyTinsModal({ isOpen, onClose, onVerified }) {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  // Record picker: the list is always visible, every listed record starts
  // selected, and the filter narrows what "select all shown" covers.
  const [cands, setCands] = useState(null);
  const [candSearch, setCandSearch] = useState('');
  const [picked, setPicked] = useState(new Set());
  // Field consent
  const [fields, setFields] = useState({});
  const [candsError, setCandsError] = useState(null);

  const loadCandidates = useCallback(() => {
    setCands(null);
    setCandsError(null);
    channelAPI.batchVerifyCandidates({ limit: 200 })
      .then((d) => {
        const list = d.candidates || [];
        setCands(list);
        // Only TIN-bearing records start selected — the rest can't be verified.
        setPicked(new Set(list.filter((c) => Number(c.has_tin) === 1).map((c) => c.id)));
      })
      .catch((err) => {
        setCands([]);
        setCandsError(err.message || 'Could not load the record list');
      });
  }, []);

  useEffect(() => {
    if (isOpen) {
      setResults(null);
      setCandSearch('');
      setPicked(new Set());
      setFields({});
      loadCandidates();
    }
  }, [isOpen, loadCandidates]);

  if (!isOpen) return null;

  const shownCands = (cands || []).filter((c) => {
    if (!candSearch.trim()) return true;
    const q = candSearch.toLowerCase();
    return c.user_name?.toLowerCase().includes(q)
      || String(c.mobile_number || '').includes(q)
      || String(c.tin || '').includes(q);
  });
  // Only TIN-bearing records are selectable — the rest are listed disabled so
  // an import without TINs is visible instead of a mysteriously empty list.
  const pickable = shownCands.filter((c) => Number(c.has_tin) === 1);
  const allShownPicked = pickable.length > 0 && pickable.every((c) => picked.has(c.id));
  const anyField = Object.values(fields).some(Boolean);
  const noTinCount = (cands || []).filter((c) => Number(c.has_tin) !== 1).length;
  const tinCount = (cands || []).length - noTinCount;

  /** Tick / untick every selectable record the filter currently shows. */
  function toggleShown() {
    setPicked((prev) => {
      const next = new Set(prev);
      if (allShownPicked) pickable.forEach((c) => next.delete(c.id));
      else pickable.forEach((c) => next.add(c.id));
      return next;
    });
  }

  function toggleOne(id, checked) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleBatchVerify() {
    setLoading(true);
    try {
      const payload = {
        fetch_photos: true,
        fields: Object.keys(fields).filter((k) => fields[k]),
        entity_ids: [...picked],
      };
      const res = await channelAPI.batchVerifyTins(payload);
      setResults(res);
      const photoNote = res.photos ? `, ${res.photos} photo${res.photos === 1 ? '' : 's'}` : '';
      const changeNote = res.changed ? `, ${res.changed} record${res.changed === 1 ? '' : 's'} updated` : '';
      toast.success(`Batch verification complete: ${res.verified || 0} verified${changeNote}${photoNote}`);
      if (onVerified) onVerified();
    } catch (err) {
      toast.error('Batch verification failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-gray-100">
        <div className="flex items-center justify-between pb-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900">Batch TIN Verification</h3>
              <p className="text-xs text-gray-500">Query Ministry of Revenue & eTrade for all registered TINs</p>
            </div>
          </div>
          <button onClick={onClose} disabled={loading} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="py-4 space-y-4">
          {!results ? (
            <>
              <div className="bg-blue-50/70 border border-blue-200 rounded-xl p-3.5 text-xs text-blue-900 space-y-1">
                <p className="font-semibold">Batch Verification Process</p>
                <p className="text-blue-800 leading-relaxed">
                  Registered records with TIN numbers are checked against the Ethiopian eTrade & MoR API.
                  Choose which records to check, then tick exactly which registered fields the run may replace —
                  nothing changes until you tick it here.
                </p>
              </div>

              {/* ── Record picker ── */}
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="bg-gray-50 px-3.5 py-2.5 flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2.5 cursor-pointer select-none shrink-0">
                    <input
                      type="checkbox"
                      checked={allShownPicked}
                      onChange={toggleShown}
                      disabled={loading || !cands?.length}
                      className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                    />
                    <span className="text-xs font-semibold text-gray-800">
                      Select all shown
                      <span className="ml-1.5 text-[11px] font-medium text-gray-500">
                        {cands ? `· ${picked.size} of ${cands.length} selected` : '· loading…'}
                      </span>
                    </span>
                  </label>
                  <input
                    type="text"
                    value={candSearch}
                    onChange={(e) => setCandSearch(e.target.value)}
                    placeholder="Filter by name, phone, TIN…"
                    className="w-44 px-2 py-1 border border-gray-300 rounded-lg text-[11px] focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="max-h-44 overflow-y-auto divide-y divide-gray-50">
                  {(cands || []).length > 0 && shownCands.map((c) => {
                    const hasTin = Number(c.has_tin) === 1;
                    return (
                      <label
                        key={c.id}
                        className={'flex items-center gap-2.5 px-3.5 py-1.5 hover:bg-gray-50 ' + (hasTin ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed')}
                        title={hasTin ? undefined : 'This record has no TIN registered — add one on its record first'}
                      >
                        <input
                          type="checkbox"
                          checked={picked.has(c.id)}
                          onChange={(e) => toggleOne(c.id, e.target.checked)}
                          disabled={loading || !hasTin}
                          className="h-3.5 w-3.5 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                        />
                        <span className={'text-[11px] font-medium text-gray-800 truncate flex-1' + (hasTin ? '' : ' text-gray-400')}>{c.user_name}</span>
                        {hasTin
                          ? <span className="text-[10px] text-gray-400 font-mono">{c.tin}</span>
                          : <span className="text-[10px] italic text-gray-400">no TIN</span>}
                        {Number(c.has_photo) === 1 && <span title="Photo on file" className="text-[10px]">📷</span>}
                      </label>
                    );
                  })}
                  {cands && shownCands.length === 0 && (
                    <p className="px-3.5 py-3 text-[11px] text-gray-400 text-center">No records match that filter.</p>
                  )}
                  {cands && (cands || []).length > 0 && tinCount === 0 && (
                    <div className="px-3.5 py-3 bg-amber-50 border-t border-amber-200">
                      <p className="text-[11px] text-amber-800 font-medium">None of the listed records carries a TIN.</p>
                      <p className="text-[10px] text-amber-700 mt-0.5">
                        TINs are imported with the file (Retailer TIN column) or verified per record. Re-import with a TIN column, or verify TINs individually first.
                      </p>
                    </div>
                  )}
                  {!cands && !candsError && (
                    <p className="px-3.5 py-3 text-[11px] text-gray-400 text-center">Loading records…</p>
                  )}
                  {candsError && (
                    <div className="px-3.5 py-3 text-center">
                      <p className="text-[11px] text-red-600 font-medium">{candsError}</p>
                      <button
                        type="button"
                        onClick={loadCandidates}
                        className="mt-1.5 text-[11px] font-semibold text-blue-600 hover:text-blue-800"
                      >
                        Try again
                      </button>
                    </div>
                  )}
                </div>
                <p className="px-3.5 py-1.5 text-[10px] text-gray-500 bg-gray-50 border-t border-gray-100">
                  {(cands || []).length === 0
                    ? 'No registered records found.'
                    : noTinCount === 0
                      ? `${picked.size} record${picked.size === 1 ? '' : 's'} will be checked${(cands || []).length >= 200 ? ' · showing the 200 most recent — filter to find older ones' : ''}`
                      : `${tinCount} of ${(cands || []).length} records carry a TIN${noTinCount ? ` · ${noTinCount} without one can't be verified` : ''}${picked.size ? ` · ${picked.size} selected` : ''}`}
                </p>
              </div>

              {/* ── Field consent ── */}
              <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-3.5">
                <p className="text-xs font-semibold text-amber-900">Replace registered data with the official values</p>
                <p className="text-[11px] text-amber-800 mt-0.5 leading-relaxed">
                  Only the fields you tick are overwritten. Leave everything unticked to just verify without changing data.
                </p>
                <div className="mt-2.5 space-y-1.5">
                  {BATCH_FIELD_OPTIONS.map((f) => (
                    <label key={f.key} className="flex items-center gap-2.5 bg-white/70 border border-amber-200 rounded-lg px-2.5 py-1.5 cursor-pointer hover:bg-white transition">
                      <input
                        type="checkbox"
                        checked={Boolean(fields[f.key])}
                        onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.checked }))}
                        disabled={loading}
                        className="h-3.5 w-3.5 text-amber-600 rounded border-gray-300 focus:ring-amber-500"
                      />
                      <span className="text-[11px] font-medium text-gray-800">{f.label}</span>
                    </label>
                  ))}
                </div>
                {fields.phone && (
                  <p className="text-[10px] text-amber-700 mt-2">
                    Note: a phone replace is skipped for any record whose official number is already registered to another user.
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-xs space-y-3">
              <div className="flex items-center gap-1.5 text-gray-900 font-bold text-sm">
                <CheckCircle2 size={18} className="text-emerald-600" />
                <span>Batch Verification Results</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center pt-2">
                <div className="bg-white p-2.5 rounded-lg border border-gray-200">
                  <span className="block text-[11px] text-gray-500">Total Checked</span>
                  <span className="text-base font-bold text-gray-900">{fmtNum(results.total)}</span>
                </div>
                <div className="bg-emerald-50 p-2.5 rounded-lg border border-emerald-200">
                  <span className="block text-[11px] text-emerald-700">Verified</span>
                  <span className="text-base font-bold text-emerald-800">{fmtNum(results.verified)}</span>
                </div>
                <div className="bg-blue-50 p-2.5 rounded-lg border border-blue-200">
                  <span className="block text-[11px] text-blue-700">Records Updated</span>
                  <span className="text-base font-bold text-blue-800">{fmtNum(results.changed || 0)}</span>
                </div>
                <div className="bg-red-50 p-2.5 rounded-lg border border-red-200">
                  <span className="block text-[11px] text-red-600">Failed / Not Found</span>
                  <span className="text-base font-bold text-red-700">{fmtNum(results.failed)}</span>
                </div>
              </div>
              {Boolean(results.photos) && (
                <p className="text-emerald-700 text-center text-xs mt-1 font-medium">
                  📷 {results.photos} manager photo{results.photos === 1 ? '' : 's'} fetched from eTrade
                </p>
              )}
              {results.message && (
                <p className="text-gray-500 text-center text-xs mt-1">{results.message}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
          {!results ? (
            <>
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
                onClick={handleBatchVerify}
                disabled={loading || picked.size === 0}
                title={!anyField ? 'Verify only — no registered data will be replaced' : 'Verify and replace the ticked fields'}
                className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg shadow-sm transition"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                {loading ? 'Verifying Records...' : anyField ? 'Verify & Replace Selected' : 'Verify Only'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition"
            >
              Done & Refresh
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const tone = status === 'active'
    ? 'bg-emerald-50 text-emerald-700'
    : status === 'canceled'
      ? 'bg-red-50 text-red-700'
      : 'bg-gray-100 text-gray-600';
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium capitalize ${tone}`}>{status || '—'}</span>;
}

/**
 * A categorical split as a label / users / share table.
 */
function DimensionSplit({ title, note, rows, labelKey = 'label' }) {
  const list = rows || [];
  const total = list.reduce((a, r) => a + Number(r.entities || 0), 0);
  const nameOf = (r) => r[labelKey] ?? r.label ?? r.product ?? r.business_type ?? '—';
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
        {note && <p className="text-xs text-gray-500 mt-0.5">{note}</p>}
      </div>
      {list.length === 0 ? (
        <p className="px-5 py-6 text-center text-xs text-gray-500">Nothing recorded.</p>
      ) : (
        <div className="max-h-[300px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr className="border-b border-gray-200">
                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Value</th>
                <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600">Users</th>
                <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600">Share</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => {
                const share = total ? (Number(r.entities || 0) / total) * 100 : 0;
                return (
                  <tr key={nameOf(r) + i} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-800 max-w-[220px] truncate" title={nameOf(r)}>{nameOf(r)}</td>
                    <td className="px-4 py-2 text-right text-gray-600">{fmtNum(r.entities)}</td>
                    <td className="px-4 py-2 text-right text-gray-500">{share.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryItem({ label, value, sub }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="text-xl font-bold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

/** A compact figure tile used inside a level block of the Executive Summary. */
function MiniStat({ icon, label, value, sub }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50/70 p-4">
      <div className="flex items-center gap-1.5 text-gray-500">
        {icon}
        <p className="text-[11px] font-semibold uppercase tracking-wider">{label}</p>
      </div>
      <p className="text-xl font-bold text-gray-900 mt-2 tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

/** A coverage bar — "how many of these have at least one of those". */
function CoverageMeter({ title, note, covered, total, tail }) {
  const c = Number(covered) || 0;
  const t = Number(total) || 0;
  const share = t ? (c / t) * 100 : 0;
  return (
    <div className="bg-white rounded-2xl border border-gray-200/80 shadow-sm p-5">
      <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
      {note && <p className="text-[11px] text-gray-500 mt-0.5 mb-3">{note}</p>}
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className="font-medium text-gray-600">{fmtNum(c)} of {fmtNum(t)}</span>
        <span className="text-gray-500 tabular-nums">{share.toFixed(0)}% covered</span>
      </div>
      <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-600 transition-all duration-700" style={{ width: `${share}%` }} />
      </div>
      <p className="text-[11px] text-gray-400 mt-2">{fmtNum(Math.max(0, t - c))} have no {tail} yet</p>
    </div>
  );
}

/**
 * One level's block in the Executive Summary — a titled header with the level's
 * own figures and charts, so the chain reads Distributor → Sub-Distributor →
 * Retailer. `tone` comes from LEVEL_TONES.
 */
function LevelSection({ badge, title, blurb, icon, tone, stats, actionLabel, onAction, children }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200/80 shadow-sm overflow-hidden">
      <div className={'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-5 py-4 border-b border-gray-100 bg-gradient-to-r ' + tone.band}>
        <div className="flex items-center gap-3">
          <span className={'inline-flex items-center justify-center w-9 h-9 rounded-xl text-white bg-gradient-to-br shadow-sm shrink-0 ' + tone.solid}>
            {icon}
          </span>
          <div>
            <div className="flex items-center gap-2">
              <span className={'text-[10px] font-bold px-1.5 py-0.5 rounded ' + tone.chip}>{badge}</span>
              <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
            </div>
            <p className="text-[11px] text-gray-500 mt-0.5">{blurb}</p>
          </div>
        </div>
        {onAction && (
          <button
            onClick={onAction}
            className="self-start sm:self-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-sm transition"
          >
            {actionLabel} <ChevronRight size={14} />
          </button>
        )}
      </div>
      <div className="p-5 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map((s, i) => <MiniStat key={i} {...s} />)}
        </div>
        {children}
      </div>
    </section>
  );
}

/** A headline figure as a gradient tile — the top row of the executive summary. */
function StatCard({ icon, label, value, sub, tone = 'from-blue-600 to-indigo-600' }) {
  return (
    <div className="relative overflow-hidden bg-white rounded-2xl border border-gray-200/80 p-5 shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200">
      <div className={'absolute -right-8 -top-8 w-28 h-28 rounded-full bg-gradient-to-br ' + tone + ' opacity-[0.08]'} />
      <div className={'inline-flex p-2.5 rounded-xl bg-gradient-to-br text-white shadow-md ' + tone}>
        {icon}
      </div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mt-3">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

/** The frame every chart on this page sits in. */
function ChartCard({ title, note, icon, children, className = '' }) {
  return (
    <div className={'bg-white rounded-2xl border border-gray-200/80 shadow-sm p-5 ' + className}>
      <div className="flex items-start gap-2.5 mb-4">
        {icon && (
          <span className="p-1.5 rounded-lg bg-blue-50 text-blue-600 shrink-0">{icon}</span>
        )}
        <div>
          <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
          {note && <p className="text-[11px] text-gray-500 mt-0.5">{note}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

function EmptyChart({ label }) {
  return (
    <div className="flex items-center justify-center h-[240px] text-sm text-gray-400">
      {label}
    </div>
  );
}

/**
 * The identifier code an operator quotes: IDC-R-0001.
 *
 * Falls back to a quiet dash for a record written before codes existed, so a
 * row never renders an empty chip.
 */
function IdentifierChip({ code, size = 'sm' }) {
  if (!code) return <span className="text-gray-300 text-xs">—</span>;
  return (
    <span
      className={
        'inline-flex items-center gap-1 font-mono font-semibold rounded-md border border-indigo-100 bg-indigo-50 text-indigo-700 ' +
        (size === 'lg' ? 'px-2 py-1 text-xs' : 'px-1.5 py-0.5 text-[11px]')
      }
      title="Identifier Code"
    >
      <Hash size={size === 'lg' ? 12 : 10} className="text-indigo-400" />
      {code}
    </span>
  );
}

function LevelMiniStat({ label, value, onOpen, tone = 'blue' }) {
  const bar = { blue: 'from-blue-500 to-indigo-500', indigo: 'from-indigo-500 to-purple-500' }[tone] || 'from-blue-500 to-indigo-500';
  const Tag = onOpen ? 'button' : 'div';
  return (
    <Tag
      onClick={onOpen}
      className={
        'w-full text-left px-4 py-3.5 rounded-2xl border border-gray-200/80 bg-white shadow-sm transition ' +
        (onOpen ? 'hover:shadow-md hover:border-blue-300 cursor-pointer' : '')
      }
    >
      <div className={'h-1 w-10 rounded-full bg-gradient-to-r mb-2.5 ' + bar} />
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">{value}</p>
      {onOpen && <p className="text-[11px] text-blue-600 mt-1 font-medium">Open report →</p>}
    </Tag>
  );
}

/* ───────────────────────────── Geographic map ─────────────────────────────
 *
 * The register stores where a user sits as a free-text place name ("Hargele",
 * "Hawassa", "SR"), so a map has to resolve those names itself. The gazetteer
 * below carries the towns, cities and Ethio Telecom region codes that appear on
 * the workbooks; anything it does not know is listed as *not plotted* rather
 * than being dropped or, worse, pinned somewhere invented.
 *
 * The drawing is plain SVG on an equirectangular projection — no tile server,
 * no mapping library, nothing that needs a network round trip to render.
 */

const MAP_BBOX = { lonMin: 32.6, lonMax: 48.2, latMin: 3.2, latMax: 15.2 };
const MAP_W = 1000;
const MAP_H = 780;

// [longitude, latitude] of every place the source files are likely to name.
const ETHIOPIA_PLACES = {
  addisababa: [38.7578, 9.0192, 'Addis Ababa'],
  addis: [38.7578, 9.0192, 'Addis Ababa'],
  finfine: [38.7578, 9.0192, 'Addis Ababa'],
  adama: [39.2694, 8.54, 'Adama'],
  nazret: [39.2694, 8.54, 'Adama'],
  hawassa: [38.4761, 7.0621, 'Hawassa'],
  awassa: [38.4761, 7.0621, 'Hawassa'],
  bahirdar: [37.3908, 11.5936, 'Bahir Dar'],
  gondar: [37.4667, 12.6, 'Gondar'],
  gonder: [37.4667, 12.6, 'Gondar'],
  mekelle: [39.4767, 13.4967, 'Mekelle'],
  makelle: [39.4767, 13.4967, 'Mekelle'],
  diredawa: [41.8661, 9.6, 'Dire Dawa'],
  dire: [41.8661, 9.6, 'Dire Dawa'],
  jimma: [36.8333, 7.6667, 'Jimma'],
  dessie: [39.6333, 11.1333, 'Dessie'],
  desie: [39.6333, 11.1333, 'Dessie'],
  harar: [42.1167, 9.3167, 'Harar'],
  jijiga: [42.8, 9.35, 'Jijiga'],
  jigjiga: [42.8, 9.35, 'Jijiga'],
  shashamane: [38.2, 7.2, 'Shashamane'],
  shashemene: [38.2, 7.2, 'Shashamane'],
  arbaminch: [37.55, 6.0333, 'Arba Minch'],
  sodo: [37.75, 6.86, 'Sodo'],
  wolayita: [37.75, 6.86, 'Sodo'],
  hosaena: [37.85, 7.55, 'Hosaena'],
  hosana: [37.85, 7.55, 'Hosaena'],
  dilla: [38.3167, 6.4167, 'Dilla'],
  dila: [38.3167, 6.4167, 'Dilla'],
  yirgalem: [38.4167, 6.75, 'Yirgalem'],
  wolkite: [37.7833, 8.2833, 'Wolkite'],
  welkite: [37.7833, 8.2833, 'Wolkite'],
  butajira: [38.3667, 8.1167, 'Butajira'],
  batu: [38.7167, 7.9333, 'Batu / Ziway'],
  ziway: [38.7167, 7.9333, 'Batu / Ziway'],
  meki: [38.8167, 8.15, 'Meki'],
  bishoftu: [38.9833, 8.75, 'Bishoftu'],
  debrezeit: [38.9833, 8.75, 'Bishoftu'],
  ambo: [37.85, 8.9833, 'Ambo'],
  nekemte: [36.5333, 9.0833, 'Nekemte'],
  gimbi: [35.8333, 9.1667, 'Gimbi'],
  assosa: [34.5333, 10.0667, 'Assosa'],
  asosa: [34.5333, 10.0667, 'Assosa'],
  metu: [35.5833, 8.3, 'Metu'],
  bonga: [36.2333, 7.2833, 'Bonga'],
  mizanteferi: [35.5833, 6.9833, 'Mizan Teferi'],
  tepi: [35.4167, 7.2, 'Tepi'],
  gambella: [34.5833, 8.25, 'Gambella'],
  debremarkos: [37.7333, 10.35, 'Debre Markos'],
  debrebirhan: [39.5333, 9.6833, 'Debre Birhan'],
  debretabor: [38.0167, 11.85, 'Debre Tabor'],
  woldiya: [39.6, 11.8333, 'Woldiya'],
  lalibela: [39.05, 12.0333, 'Lalibela'],
  sekota: [39.05, 12.6333, 'Sekota'],
  kombolcha: [39.75, 11.0833, 'Kombolcha'],
  kemise: [39.8667, 10.7167, 'Kemise'],
  semera: [40.9833, 11.7833, 'Semera'],
  asaita: [41.4333, 11.5667, 'Asaita'],
  afdem: [40.0, 9.9333, 'Afdem'],
  gewane: [40.6333, 10.1667, 'Gewane'],
  bati: [40.0167, 11.1833, 'Bati'],
  dodola: [39.1833, 6.9833, 'Dodola'],
  goba: [39.9833, 7.0167, 'Goba'],
  robe: [39.6333, 7.1333, 'Robe'],
  adaba: [39.3833, 7.0, 'Adaba'],
  negele: [39.3, 7.3333, 'Negele'],
  negeleborana: [39.5833, 5.3333, 'Negele Borana'],
  yabelo: [38.0833, 4.9, 'Yabelo'],
  moyale: [39.05, 3.5333, 'Moyale'],
  shakiso: [38.9167, 5.75, 'Shakiso'],
  kibremengist: [38.9833, 5.8833, 'Kibre Mengist'],
  wendo: [38.6167, 6.6, 'Wendo'],
  alettawendo: [38.4167, 6.6, 'Aleta Wendo'],
  boditi: [37.8667, 6.9667, 'Boditi'],
  areka: [37.6667, 7.0667, 'Areka'],
  durame: [37.9167, 7.2333, 'Durame'],
  yirgacheffe: [38.2, 6.1667, 'Yirgacheffe'],
  gedeb: [38.2333, 6.0, 'Gedeb'],
  wenago: [38.2667, 6.3, 'Wenago'],
  kebribeyah: [43.05, 9.08, 'Kebribeyah'],
  kebribeyaha: [43.05, 9.08, 'Kebribeyah'],
  hargele: [43.0, 5.0, 'Hargele'],
  gombura: [37.75, 7.6, 'Gombura'],
  gombora: [37.75, 7.6, 'Gombura'],
  jajura: [37.85, 7.35, 'Jajura'],
  humera: [36.6, 14.3, 'Humera'],
  metema: [36.5, 12.95, 'Metema'],
  shire: [38.2833, 14.1, 'Shire'],
  aksum: [38.7167, 14.1333, 'Aksum'],
  adigrat: [39.4667, 14.2833, 'Adigrat'],
  adwa: [38.9, 14.1667, 'Adwa'],
  maychew: [39.5333, 12.7833, 'Maychew'],
  korem: [39.5167, 12.5, 'Korem'],
  alamata: [39.55, 12.4167, 'Alamata'],
  wukro: [39.6, 13.7833, 'Wukro'],
  sawla: [36.9, 6.3, 'Sawla'],
  konso: [37.4, 5.35, 'Konso'],
  jinka: [36.65, 5.65, 'Jinka'],
  asella: [39.1333, 7.95, 'Asella'],
  holeta: [38.5, 9.05, 'Holeta'],
  weliso: [37.9667, 8.5333, 'Weliso'],
  bichena: [38.1667, 10.45, 'Bichena'],
  dembidolo: [34.8, 8.5333, 'Dembi Dolo'],
  gore: [35.5333, 8.15, 'Gore'],
  bedele: [36.35, 8.45, 'Bedele'],
  agaro: [36.65, 7.85, 'Agaro'],
  // Ethio Telecom region codes name a whole region rather than a town; they are
  // pinned at the region's capital and labelled as such.
  eer: [41.95, 9.75, 'East Ethiopia Region'],
  eastethiopia: [41.95, 9.75, 'East Ethiopia Region'],
  sr: [38.34, 7.18, 'Sidama Region'],
  sidama: [38.34, 7.18, 'Sidama Region'],
  sswr: [36.1, 7.4, 'South West Region'],
  southwest: [36.1, 7.4, 'South West Region'],
  cwr: [37.75, 6.86, 'Central West Region'],
  wer: [37.39, 11.59, 'West Ethiopia Region'],
};

/** "ADDIS ABABA" / "Hargele" / "Kebri Beyah" → the gazetteer's key. */
function normalisePlace(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]/g, '');
}

/** The national outline, as [lon, lat] pairs. */
const ETHIOPIA_OUTLINE = [
  [37.90607, 14.95943], [38.51295, 14.50547], [39.0994, 14.74064], [39.34061, 14.53155],
  [40.02625, 14.51959], [40.8966, 14.11864], [41.1552, 13.77333], [41.59856, 13.45209],
  [42.00975, 12.86582], [42.35156, 12.54223], [42, 12.1], [41.66176, 11.6312],
  [41.73959, 11.35511], [41.75557, 11.05091], [42.31414, 11.0342], [42.55493, 11.10511],
  [42.776852, 10.926879], [42.55876, 10.57258], [42.92812, 10.02194], [43.29699, 9.54048],
  [43.67875, 9.18358], [46.94834, 7.99688], [47.78942, 8.003], [44.9636, 5.00162],
  [43.66087, 4.95755], [42.76967, 4.25259], [42.12861, 4.23413], [41.855083, 3.918912],
  [41.1718, 3.91909], [40.76848, 4.25702], [39.85494, 3.83879], [39.559384, 3.42206],
  [38.89251, 3.50074], [38.67114, 3.61607], [38.43697, 3.58851], [38.120915, 3.598605],
  [36.855093, 4.447864], [36.159079, 4.447864], [35.817448, 4.776966], [35.817448, 5.338232],
  [35.298007, 5.506], [34.70702, 6.59422], [34.25032, 6.82607], [34.0751, 7.22595],
  [33.56829, 7.71334], [32.95418, 7.78497], [33.2948, 8.35458], [33.8255, 8.37916],
  [33.97498, 8.68456], [33.96162, 9.58358], [34.25745, 10.63009], [34.73115, 10.91017],
  [34.83163, 11.31896], [35.26049, 12.08286], [35.86363, 12.57828], [36.27022, 13.56333],
  [36.42951, 14.42211], [37.59377, 14.2131], [37.90607, 14.95943],
];

/** Longitude/latitude → a point inside the drawing. */
function projectToMap(lon, lat) {
  const x = ((lon - MAP_BBOX.lonMin) / (MAP_BBOX.lonMax - MAP_BBOX.lonMin)) * MAP_W;
  const y = MAP_H - ((lat - MAP_BBOX.latMin) / (MAP_BBOX.latMax - MAP_BBOX.latMin)) * MAP_H;
  return { x, y };
}

/**
 * Pin colour tiers. Size already scales with users; colour repeats that story
 * so a crowded map still reads — and the pins don't all wear the same blue.
 * A pin takes the first tier whose floor its share of the biggest area meets.
 */
const PIN_TIERS = [
  { min: 0.5,  gradient: 'ethPinHot',  stroke: '#f43f5e', label: 'Hotspot' },
  { min: 0.25, gradient: 'ethPinWarm', stroke: '#f59e0b', label: 'Large' },
  { min: 0.1,  gradient: 'ethPinMid',  stroke: '#3b82f6', label: 'Medium' },
  { min: 0,    gradient: 'ethPinLow',  stroke: '#10b981', label: 'Small' },
];

function pinTier(users, maxUsers) {
  return PIN_TIERS.find(t => users / maxUsers >= t.min);
}

/**
 * The register on a map of Ethiopia.
 *
 * Every area is pinned where the source file says it is, the pin grows with the
 * number of users there and wears the colour of its size tier, and pins that
 * land on the same town are fanned out so none hides another. A summary strip
 * carries the areas the gazetteer could not place instead of silently losing
 * them.
 */
function GeoMap({ areas, className = '' }) {
  const [hovered, setHovered] = useState(null);

  const maxUsers = Math.max(1, ...areas.map(a => Number(a.entities) || 0));

  // Group by exact coordinate, then fan duplicates out around the point.
  const pins = useMemo(() => {
    const groups = new Map();
    for (const a of areas) {
      const hit = ETHIOPIA_PLACES[normalisePlace(a.area)];
      if (!hit) continue;
      const key = `${hit[0].toFixed(2)}|${hit[1].toFixed(2)}`;
      if (!groups.has(key)) groups.set(key, { point: hit, items: [] });
      groups.get(key).items.push(a);
    }
    const out = [];
    for (const { point, items } of groups.values()) {
      const base = projectToMap(point[0], point[1]);
      items.forEach((a, i) => {
        const angle = (i / items.length) * Math.PI * 2;
        const spread = i === 0 && items.length === 1 ? 0 : 26;
        out.push({
          key: a.area,
          label: point[2],
          area: a.area,
          users: Number(a.entities) || 0,
          share: Number(a.share) || 0,
          x: base.x + (items.length > 1 ? Math.cos(angle) * spread : 0),
          y: base.y + (items.length > 1 ? Math.sin(angle) * spread : 0),
          r: 7 + 16 * Math.sqrt((Number(a.entities) || 0) / maxUsers),
          tier: pinTier(Number(a.entities) || 0, maxUsers),
        });
      });
    }
    return out.sort((a, b) => b.users - a.users);
  }, [areas, maxUsers]);

  const unplaced = areas.filter(a => !ETHIOPIA_PLACES[normalisePlace(a.area)]);
  const outlinePath = useMemo(
    () => ETHIOPIA_OUTLINE
      .map(([lon, lat], i) => {
        const { x, y } = projectToMap(lon, lat);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ') + ' Z',
    []
  );

  return (
    <div className={'bg-white rounded-2xl border border-gray-200/80 shadow-sm overflow-hidden ' + className}>
      <div className="px-5 py-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-start gap-2.5">
          <span className="p-1.5 rounded-lg bg-blue-50 text-blue-600"><MapPinned size={16} /></span>
          <div>
            <h3 className="text-sm font-semibold text-gray-800">Distribution Map</h3>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Where the users sit, pin size &amp; colour by user count — {fmtNum(pins.length)} area(s) placed
            </p>
            <p className="text-[10px] text-gray-400 mt-0.5">
              Positions are gazetteer coordinates for the place names the file carries, not surveyed shop locations
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-gray-500 flex-wrap">
          <span className="flex items-center gap-1.5">
            <span className="flex -space-x-0.5">
              {PIN_TIERS.map(t => (
                <span key={t.gradient} className="w-2.5 h-2.5 rounded-full border border-white" style={{ backgroundColor: t.stroke }} />
              ))}
            </span>
            {fmtNum(pins.reduce((a, p) => a + p.users, 0))} users shown
          </span>
          <span className="flex items-center gap-2">
            {PIN_TIERS.map(t => (
              <span key={t.gradient} className="flex items-center gap-1" title={`≥ ${(t.min * 100).toFixed(0)}% of the largest area's users`}>
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: t.stroke }} /> {t.label}
              </span>
            ))}
          </span>
        </div>
      </div>

      <div className="relative bg-gradient-to-b from-sky-50 via-white to-emerald-50/60">
        <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="w-full h-auto block" role="img" aria-label="Channel users across Ethiopia">
          <defs>
            <linearGradient id="ethLand" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#e0f2fe" />
              <stop offset="100%" stopColor="#dcfce7" />
            </linearGradient>
            <linearGradient id="ethPinHot" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fb7185" />
              <stop offset="100%" stopColor="#e11d48" />
            </linearGradient>
            <linearGradient id="ethPinWarm" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fbbf24" />
              <stop offset="100%" stopColor="#f97316" />
            </linearGradient>
            <linearGradient id="ethPinMid" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#60a5fa" />
              <stop offset="100%" stopColor="#6366f1" />
            </linearGradient>
            <linearGradient id="ethPinLow" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="100%" stopColor="#0d9488" />
            </linearGradient>
            {/* A neutral shadow: the old navy one was tuned for blue pins only. */}
            <filter id="ethPinShadow" x="-60%" y="-60%" width="220%" height="220%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#1e293b" floodOpacity="0.3" />
            </filter>
          </defs>

          {/* graticule */}
          {Array.from({ length: 9 }, (_, i) => 34 + i * 2).map(lon => {
            const { x } = projectToMap(lon, MAP_BBOX.latMin);
            return <line key={'v' + lon} x1={x} y1={0} x2={x} y2={MAP_H} stroke="#e2e8f0" strokeWidth={1} strokeDasharray="4 8" />;
          })}
          {Array.from({ length: 7 }, (_, i) => 4 + i * 2).map(lat => {
            const { y } = projectToMap(MAP_BBOX.lonMin, lat);
            return <line key={'h' + lat} x1={0} y1={y} x2={MAP_W} y2={y} stroke="#e2e8f0" strokeWidth={1} strokeDasharray="4 8" />;
          })}

          <path d={outlinePath} fill="url(#ethLand)" stroke="#60a5fa" strokeWidth={3} strokeLinejoin="round" />

          {pins.map((p, i) => (
            <g
              key={p.key}
              onMouseEnter={() => setHovered(p)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: 'pointer' }}
            >
              {/* A ring that keeps expanding outward, staggered pin by pin with a
                  negative delay so every pin is already mid-pulse on first paint.
                  The map reads as live rather than as a still. */}
              <circle
                className="map-pin-pulse"
                cx={p.x}
                cy={p.y}
                r={p.r + 6}
                fill="none"
                stroke={p.tier.stroke}
                strokeWidth={2}
                style={{ animationDelay: `-${((i % 6) * 0.4).toFixed(2)}s` }}
              />
              <circle cx={p.x} cy={p.y} r={p.r + 9} fill={p.tier.stroke} opacity={0.14} />
              <circle cx={p.x} cy={p.y} r={p.r} fill={`url(#${p.tier.gradient})`} stroke="#fff" strokeWidth={3} filter="url(#ethPinShadow)" />
              <text
                x={p.x}
                y={p.y + 4}
                textAnchor="middle"
                fontSize={p.r > 15 ? 14 : 11}
                fontWeight={700}
                fill="#fff"
                style={{ pointerEvents: 'none' }}
              >
                {p.users}
              </text>
              <text
                x={p.x}
                y={p.y - p.r - 8}
                textAnchor="middle"
                fontSize={13}
                fontWeight={600}
                fill="#334155"
                style={{ pointerEvents: 'none' }}
              >
                {p.label}
              </text>
            </g>
          ))}
        </svg>

        {hovered && (
          <div className="absolute top-4 left-4 bg-white/95 backdrop-blur rounded-xl border border-gray-200 shadow-lg px-4 py-3 pointer-events-none">
            <p className="text-sm font-semibold text-gray-900">{hovered.label}</p>
            <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: hovered.tier.stroke }} />
              {fmtNum(hovered.users)} user(s) · {hovered.share.toFixed(1)}% of the network
            </p>
            {hovered.area !== hovered.label && (
              <p className="text-[11px] text-gray-400 mt-0.5">as recorded: “{hovered.area}”</p>
            )}
          </div>
        )}
      </div>

      {unplaced.length > 0 && (
        <div className="px-5 py-3 border-t border-gray-100 bg-amber-50/60">
          <p className="text-[11px] font-semibold text-amber-900 flex items-center gap-1.5">
            <AlertCircle size={12} /> Not plotted — no coordinates known for these names
          </p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {unplaced.map(a => (
              <span key={a.area} className="text-[11px] px-2 py-0.5 rounded-md bg-white border border-amber-200 text-amber-900">
                {a.area} · {fmtNum(a.entities)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
