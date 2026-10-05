import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { channelAPI } from '../services/api';
import { EditEntityModal, DeleteEntityModal } from '../components/channel/EntityModals';
import ManagerPhoto from '../components/channel/ManagerPhoto';
import { ImportStamp, IdentifierTag, STATUS_COLORS, groupDownstream } from '../components/channel/EntityBits';
import ColumnPicker, { loadColumnPrefs } from '../components/ColumnPicker';
import {
  Search, ChevronLeft, ChevronRight, RefreshCw, Filter, Loader2,
  Edit3, Trash2, ClipboardList, Camera, CheckCircle2, XCircle, ShieldAlert,
} from 'lucide-react';
import toast from 'react-hot-toast';

const fmtNum = (n) => (n || 0).toLocaleString();

/**
 * The master register of the indirect channel — every Distributor,
 * Sub-Distributor and Retailer the imports and single registrations have
 * written, with every column the record carries available in the table.
 *
 * The dashboard keeps its charts; this page is where the data itself is read,
 * filtered, edited and cleaned.
 */
export default function ChannelRegistry() {
  const { user, hasAnyPermission, isMasterAdmin } = useAuth();
  // Every registry grant comes in two strengths: the bare permission reaches
  // every record; the *_own variant is confined to the records this account
  // recorded (matched against channel_entities.created_by). The master admin
  // holds everything.
  const canViewAll = isMasterAdmin || hasAnyPermission('channel_entities.view');
  const canViewOwn = hasAnyPermission('channel_entities.view_own');
  const canEditAll = isMasterAdmin || hasAnyPermission('channel_entities.edit');
  const canEditOwn = hasAnyPermission('channel_entities.edit_own');
  const canDeleteAll = isMasterAdmin || hasAnyPermission('channel_entities.delete');
  const canDeleteOwn = hasAnyPermission('channel_entities.delete_own');
  const canView = canViewAll || canViewOwn;
  const canModify = canEditAll || canEditOwn || canDeleteAll || canDeleteOwn;
  // "Recorded by my account" — imports stamp the operator who ran them and
  // hand registrations their form-filler, so either the username or the email
  // can sit in created_by.
  const isOwnRecord = (e) => Boolean(e?.created_by) && (e.created_by === user?.username || e.created_by === user?.email);
  const canEditRow = (e) => canEditAll || (canEditOwn && isOwnRecord(e));
  const canDeleteRow = (e) => canDeleteAll || (canDeleteOwn && isOwnRecord(e));

  const [entities, setEntities] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedPeriod, setSelectedPeriod] = useState('');

  const [entitySearch, setEntitySearch] = useState('');
  const [entityPage, setEntityPage] = useState(1);
  const [entityDomain, setEntityDomain] = useState('');
  const [entityCategory, setEntityCategory] = useState('');
  const [entityGeo, setEntityGeo] = useState('');
  const [entityLevel, setEntityLevel] = useState('');
  const [entityStatus, setEntityStatus] = useState('');

  const [selectedEntity, setSelectedEntity] = useState(null);
  // Edit / Delete: the row feeds the shared modals (the same ones the Reports
  // tables use), and a save or delete reloads the list.
  const [editingEntity, setEditingEntity] = useState(null);
  const [deletingEntity, setDeletingEntity] = useState(null);

  const loadEntities = async () => {
    setLoading(true);
    try {
      const params = { page: entityPage, limit: 25 };
      if (entitySearch) params.search = entitySearch;
      if (entityDomain) params.domain = entityDomain;
      if (entityCategory) params.category = entityCategory;
      if (entityGeo) params.geo = entityGeo;
      if (entityLevel) params.level = entityLevel;
      if (entityStatus) params.status = entityStatus;
      if (selectedPeriod) params.period = selectedPeriod;
      const data = await channelAPI.getEntities(params);
      setEntities(data);
    } catch (err) {
      toast.error('Failed to load entities: ' + err.message);
    }
    setLoading(false);
  };

  // Reference lists (domains, categories, areas, periods) load once.
  useEffect(() => {
    if (!canView) return;
    channelAPI.getMeta().then(setMeta).catch(() => {});
  }, [canView]);

  useEffect(() => {
    if (!canView) return;
    loadEntities();
  }, [canView, entitySearch, entityPage, entityDomain, entityCategory, entityGeo, entityLevel, entityStatus, selectedPeriod]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  async function handleEntityClick(id) {
    try {
      const data = await channelAPI.getEntity(id);
      setSelectedEntity(data);
    } catch (e) { /* ignore */ }
  }

  function refreshRegistry() {
    loadEntities();
  }

  // The registry list carries only the table's columns, but the edit form needs
  // every field (trade name, woreda, sub-city, notes...) — and the delete
  // warning needs the downstream count. Pull the full record first, so a save
  // can never quietly blank the fields the list view does not show.
  async function openEditEntity(row) {
    try {
      const data = await channelAPI.getEntity(row.id);
      setEditingEntity(data.entity);
    } catch (e) {
      toast.error('Could not load the record for editing');
    }
  }

  async function openDeleteEntity(row) {
    try {
      const data = await channelAPI.getEntity(row.id);
      setDeletingEntity({ ...row, ...data.entity, direct_children: (data.children || []).length });
    } catch (e) {
      setDeletingEntity(row);
    }
  }

  const periods = meta?.periods || [];

  // No registry grant at all: the page explains itself instead of loading.
  if (!canView) {
    return (
      <div className="space-y-6">
        <div className="bg-white rounded-2xl border border-gray-200/80 shadow-sm p-10 text-center max-w-xl mx-auto mt-8">
          <div className="w-14 h-14 rounded-full bg-red-50 text-red-500 flex items-center justify-center mx-auto mb-4">
            <ShieldAlert size={26} />
          </div>
          <h2 className="text-lg font-bold text-gray-900">No access to the Entity Registry</h2>
          <p className="text-sm text-gray-500 mt-2">
            Your role does not carry a registry permission. Ask an administrator to grant
            {' '}<span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">channel_entities.view</span> (all records) or
            {' '}<span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">channel_entities.view_own</span> (only what your account recorded).
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-lg shadow-blue-600/20">
            <ClipboardList size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">Entity Registry</h1>
            <p className="text-sm text-gray-500 mt-1">
              The master register — every Distributor, Sub-Distributor and Retailer on file,
              with all recorded columns available.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Filter size={16} className="text-gray-400" />
            <select
              value={selectedPeriod}
              onChange={(e) => { setSelectedPeriod(e.target.value); setEntityPage(1); }}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">Latest Period</option>
              {periods.map(p => (
                <option key={p} value={p}>{p?.slice(0, 7)}</option>
              ))}
            </select>
          </div>
          <button
            onClick={refreshRegistry}
            className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50 transition"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      <RegistryTable
        entities={entities}
        loading={loading}
        entitySearch={entitySearch} setEntitySearch={(v) => { setEntitySearch(v); setEntityPage(1); }}
        entityPage={entityPage} setEntityPage={setEntityPage}
        entityDomain={entityDomain} setEntityDomain={(v) => { setEntityDomain(v); setEntityPage(1); }}
        entityCategory={entityCategory} setEntityCategory={(v) => { setEntityCategory(v); setEntityPage(1); }}
        entityGeo={entityGeo} setEntityGeo={(v) => { setEntityGeo(v); setEntityPage(1); }}
        entityLevel={entityLevel} setEntityLevel={(v) => { setEntityLevel(v); setEntityPage(1); }}
        entityStatus={entityStatus} setEntityStatus={(v) => { setEntityStatus(v); setEntityPage(1); }}
        meta={meta}
        onEntityClick={handleEntityClick}
        canEditRow={canEditRow}
        canDeleteRow={canDeleteRow}
        canModify={canModify}
        onEditEntity={openEditEntity}
        onDeleteEntity={openDeleteEntity}
      />

      {/* Full record for the clicked row */}
      {selectedEntity && <EntityDetailModal entity={selectedEntity} onClose={() => setSelectedEntity(null)} />}

      {/* Shared edit / delete modals — the same ones the Reports tables use. */}
      <EditEntityModal
        isOpen={Boolean(editingEntity)}
        entity={editingEntity}
        onClose={() => setEditingEntity(null)}
        onUpdated={refreshRegistry}
      />
      <DeleteEntityModal
        isOpen={Boolean(deletingEntity)}
        entity={deletingEntity}
        onClose={() => setDeletingEntity(null)}
        onDeleted={refreshRegistry}
      />
    </div>
  );
}

const LEVEL_LABELS = { 1: 'Distributor', 2: 'Sub-Distributor', 3: 'Retailer' };

function RegistryTable({
  entities, loading,
  entitySearch, setEntitySearch, entityPage, setEntityPage,
  entityDomain, setEntityDomain, entityCategory, setEntityCategory,
  entityGeo, setEntityGeo, entityLevel, setEntityLevel, entityStatus, setEntityStatus,
  meta, onEntityClick, canEditRow, canDeleteRow, canModify, onEditEntity, onDeleteEntity,
}) {
  // Areas are ranked by how many channel users sit in them, so the busiest
  // places surface first in the filter.
  const geoChoices = (meta?.geo_values || []).map(g => g.value).filter(Boolean);

  // Column preferences — every column the register carries, on or off at will.
  // A fresh storage key: the old dashboard registry key saved a short column
  // list, and saved prefs win over new defaults, so reusing it would hide the
  // newly offered columns for anyone who had picked columns before.
  const colDefs = useMemo(() => [
    { key: 'name', label: 'Name', always: true },
    { key: 'identifier', label: 'Identifier Code' },
    { key: 'mobile', label: 'Mobile' },
    { key: 'level', label: 'Level' },
    { key: 'category', label: 'Category' },
    { key: 'domain', label: 'Domain' },
    { key: 'status', label: 'Status' },
    { key: 'area', label: 'Area' },
    { key: 'woreda', label: 'Woreda' },
    { key: 'sub_city', label: 'Sub-City' },
    { key: 'house_no', label: 'House No' },
    { key: 'trade_name', label: 'Trade Name' },
    { key: 'business', label: 'Existing Business' },
    { key: 'product', label: 'Air Time Type' },
    { key: 'tin', label: 'TIN' },
    { key: 'tin_verified', label: 'TIN Verification' },
    { key: 'national_id', label: 'National ID' },
    { key: 'location', label: 'Street Address' },
    { key: 'parent', label: 'Sub-Distributor' },
    { key: 'owner', label: 'Distributor' },
    { key: 'gps', label: 'GPS Location' },
    { key: 'balance', label: 'Stock Balance' },
    { key: 'photo', label: 'Photo' },
    { key: 'source', label: 'Source / Recorded By' },
    { key: 'import_code', label: 'Import ID' },
    { key: 'imported_at', label: 'Imported On' },
    ...(canModify ? [{ key: 'actions', label: 'Actions', always: true }] : []),
  ], [canModify]);
  const allColKeys = useMemo(() => colDefs.map((c) => c.key), [colDefs]);
  const storageKey = 'channel_cols_registry_master_v2';
  const [visibleCols, setVisibleCols] = useState(() => loadColumnPrefs(storageKey, allColKeys));
  useEffect(() => {
    setVisibleCols(loadColumnPrefs(storageKey, allColKeys));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, allColKeys.join(',')]);
  const show = (k) => visibleCols.has(k);

  const textCell = 'px-4 py-3 text-gray-600 text-xs max-w-[150px] truncate';

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
          <div className="flex-1 min-w-[220px] relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input type="text" value={entitySearch}
              onChange={(e) => setEntitySearch(e.target.value)}
              placeholder="Search by name, mobile, sub-distributor, distributor..."
              className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none" />
          </div>
          <select value={entityDomain} onChange={(e) => setEntityDomain(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
            <option value="">All Domains</option>
            {meta?.domains?.map(d => <option key={d.code} value={d.code}>{d.name}</option>)}
          </select>
          <select value={entityCategory} onChange={(e) => setEntityCategory(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
            <option value="">All Categories</option>
            {meta?.categories?.filter(c => c.level >= 1 && c.level <= 3 && c.domain_code === 'IDC').map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
          <select value={entityLevel} onChange={(e) => setEntityLevel(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
            <option value="">All Levels</option>
            {[1, 2, 3].map(l => <option key={l} value={l}>{LEVEL_LABELS[l]} (L{l})</option>)}
          </select>
          <select value={entityStatus} onChange={(e) => setEntityStatus(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
            <option value="">All Statuses</option>
            {['active', 'inactive', 'canceled'].map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
          <select value={entityGeo} onChange={(e) => setEntityGeo(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm max-w-[220px]">
            <option value="">All Areas</option>
            {geoChoices.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          {(entitySearch || entityDomain || entityCategory || entityGeo || entityLevel || entityStatus) && (
            <button
              onClick={() => { setEntitySearch(''); setEntityDomain(''); setEntityCategory(''); setEntityGeo(''); setEntityLevel(''); setEntityStatus(''); setEntityPage(1); }}
              className="px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
            >
              Clear
            </button>
          )}
          <div className="sm:ml-auto">
            <ColumnPicker
              columns={colDefs}
              visible={visibleCols}
              setVisible={setVisibleCols}
              storageKey={storageKey}
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-800">
            Channel Entities {entities ? '(' + (entities.pagination?.total || 0) + ')' : ''}
          </p>
          {entities?.period && <p className="text-xs text-gray-500">Period: {entities.period?.slice(0, 7)}</p>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Name</th>
                {show('identifier') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Identifier Code</th>}
                {show('mobile') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Mobile</th>}
                {show('level') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Level</th>}
                {show('category') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Category</th>}
                {show('domain') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Domain</th>}
                {show('status') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Status</th>}
                {show('area') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Area</th>}
                {show('woreda') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Woreda</th>}
                {show('sub_city') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Sub-City</th>}
                {show('house_no') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">House No</th>}
                {show('trade_name') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Trade Name</th>}
                {show('business') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Existing Business</th>}
                {show('product') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Air Time Type</th>}
                {show('tin') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">TIN</th>}
                {show('tin_verified') && <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600">TIN Verification</th>}
                {show('national_id') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">National ID</th>}
                {show('location') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Street Address</th>}
                {show('parent') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Sub-Distributor</th>}
                {show('owner') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Distributor</th>}
                {show('gps') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">GPS Location</th>}
                {show('balance') && <th className="px-4 py-3 text-right text-xs font-semibold text-gray-600">Stock Balance</th>}
                {show('photo') && <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600">Photo</th>}
                {show('source') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Source / Recorded By</th>}
                {show('import_code') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Import ID</th>}
                {show('imported_at') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Imported On</th>}
                {canModify && show('actions') && (
                  <th className="px-4 py-3 text-center text-xs font-semibold text-gray-600">Actions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {(entities?.entities || []).map(e => (
                <tr key={e.id} className="border-b border-gray-50 hover:bg-blue-50/30 cursor-pointer transition" onClick={() => onEntityClick(e.id)}>
                  <td className="px-4 py-3 font-medium text-gray-800 max-w-[220px]" title={e.user_name}>
                    <div className="flex items-center gap-2 min-w-0">
                      {e.has_photo && (
                        <ManagerPhoto
                          tin={e.tin}
                          alt={e.user_name}
                          className="w-7 h-7 rounded-full object-cover border border-emerald-300 shrink-0"
                        />
                      )}
                      <span className="truncate">{e.user_name}</span>
                    </div>
                  </td>
                  {show('identifier') && <td className="px-4 py-3"><IdentifierTag code={e.identifier_code} /></td>}
                  {show('mobile') && <td className="px-4 py-3 text-gray-600 font-mono text-xs">{e.mobile_number}</td>}
                  {show('level') && (
                    <td className="px-4 py-3">
                      <span className="inline-block px-2 py-0.5 text-[11px] font-medium rounded-full border border-blue-100 bg-blue-50 text-blue-700">
                        L{e.level}
                      </span>
                    </td>
                  )}
                  {show('category') && <td className="px-4 py-3 text-gray-600">{e.category_label}</td>}
                  {show('domain') && <td className="px-4 py-3 text-gray-600">{e.domain_name}</td>}
                  {show('status') && (
                    <td className="px-4 py-3">
                      <span className={'inline-block px-2 py-0.5 text-xs font-medium rounded-full border ' + (STATUS_COLORS[e.status] || STATUS_COLORS.active)}>
                        {e.status}
                      </span>
                    </td>
                  )}
                  {show('area') && <td className={textCell} title={e.geo_domain_raw || ''}>{e.geo_domain_raw || '--'}</td>}
                  {show('woreda') && <td className={textCell} title={e.woreda || ''}>{e.woreda || '--'}</td>}
                  {show('sub_city') && <td className={textCell} title={e.sub_city || ''}>{e.sub_city || '--'}</td>}
                  {show('house_no') && <td className={textCell} title={e.house_no || ''}>{e.house_no || '--'}</td>}
                  {show('trade_name') && <td className={textCell} title={e.trade_name || ''}>{e.trade_name || '--'}</td>}
                  {show('business') && <td className={textCell} title={e.business_type || ''}>{e.business_type || '--'}</td>}
                  {show('product') && <td className={textCell} title={e.product || ''}>{e.product || '--'}</td>}
                  {show('tin') && <td className="px-4 py-3 text-gray-600 font-mono text-xs">{e.tin || '--'}</td>}
                  {show('tin_verified') && (
                    <td className="px-4 py-3 text-center" title={
                      e.tin_verified === 1 || e.tin_verified === true
                        ? 'TIN verified against the eTrade / Ministry of Revenue register'
                        : e.tin
                          ? 'TIN not verified against the eTrade / Ministry of Revenue register — verify it from the record'
                          : 'No TIN on this record — nothing to verify'
                    }>
                      {e.tin_verified === 1 || e.tin_verified === true ? (
                        <span className="inline-flex flex-col items-center leading-tight">
                          <CheckCircle2 size={16} className="text-emerald-600" />
                          <span className="text-[10px] font-medium text-emerald-700">Verified</span>
                        </span>
                      ) : e.tin ? (
                        <span className="inline-flex flex-col items-center leading-tight">
                          <XCircle size={16} className="text-red-500" />
                          <span className="text-[10px] font-medium text-red-600">Not verified</span>
                        </span>
                      ) : (
                        <span className="text-gray-300 text-xs">--</span>
                      )}
                    </td>
                  )}
                  {show('national_id') && <td className="px-4 py-3 text-gray-600 font-mono text-xs">{e.national_id || '--'}</td>}
                  {show('location') && <td className={textCell} title={e.location || ''}>{e.location || '--'}</td>}
                  {show('parent') && <td className={textCell} title={e.parent_name || ''}>{e.parent_name || '--'}</td>}
                  {show('owner') && <td className={textCell} title={e.owner_name || ''}>{e.owner_name || '--'}</td>}
                  {show('gps') && (
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      {e.latitude != null && e.longitude != null ? (
                        <a
                          href={`https://www.google.com/maps?q=${e.latitude},${e.longitude}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(ev) => ev.stopPropagation()}
                          className="font-mono text-blue-600 hover:text-blue-800 hover:underline"
                          title={`${e.user_name} — open in Google Maps`}
                        >
                          {Number(e.latitude).toFixed(6)}, {Number(e.longitude).toFixed(6)}
                        </a>
                      ) : (
                        <span className="text-gray-300" title={Number(e.level) === 3 ? 'No GPS captured — capture one in Single Registration' : 'Only retailers carry GPS'}>--</span>
                      )}
                    </td>
                  )}
                  {show('balance') && (
                    <td className="px-4 py-3 text-right tabular-nums">
                      {e.has_balance ? fmtNum(e.available_balance) : <span className="text-gray-300">--</span>}
                    </td>
                  )}
                  {show('photo') && (
                    <td className="px-4 py-3 text-center">
                      {e.has_photo
                        ? <ManagerPhoto tin={e.tin} alt={e.user_name} className="w-8 h-8 rounded-full object-cover border border-emerald-300 mx-auto" />
                        : <span className="text-gray-300 text-xs">--</span>}
                    </td>
                  )}
                  {show('source') && (
                    <td className="px-4 py-3" title={e.source === 'manual' ? `Recorded by ${e.created_by_name || e.created_by || 'an operator'}` : e.source || ''}>
                      <span className="block text-gray-600 text-xs">{e.source || '--'}</span>
                      {(e.created_by_name || e.created_by) && (
                        <span className="block text-[10px] text-gray-400 truncate max-w-[130px]">{e.created_by_name || e.created_by}</span>
                      )}
                    </td>
                  )}
                  {show('import_code') && (
                    <td className="px-4 py-3">
                      <ImportStamp code={e.import_code} />
                    </td>
                  )}
                  {show('imported_at') && <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{e.imported_at || '--'}</td>}
                  {canModify && show('actions') && (
                    <td className="px-4 py-3 whitespace-nowrap" onClick={(ev) => ev.stopPropagation()}>
                      <div className="flex items-center justify-center gap-1">
                        {canEditRow(e) && (
                          <button
                            onClick={() => onEditEntity(e)}
                            className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition"
                            title={`Edit ${e.user_name}`}
                          >
                            <Edit3 size={15} />
                          </button>
                        )}
                        {canDeleteRow(e) && (
                          <button
                            onClick={() => onDeleteEntity(e)}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
                            title={`Delete ${e.user_name}`}
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {(!entities?.entities || entities.entities.length === 0) && (
                <tr><td colSpan={colDefs.filter(c => show(c.key)).length} className="px-4 py-12 text-center text-gray-400">
                  {loading ? 'Loading…' : 'No channel users found'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && entities?.entities?.length > 0 && (
          <div className="px-5 py-2 border-t border-gray-100 flex items-center gap-2 text-xs text-gray-400">
            <Loader2 size={12} className="animate-spin" /> Refreshing…
          </div>
        )}
        {entities?.pagination && entities.pagination.pages > 1 && (
          <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
            <p className="text-xs text-gray-500">Page {entities.pagination.page} of {entities.pagination.pages} · {fmtNum(entities.pagination.total)} record(s)</p>
            <div className="flex gap-2">
              <button onClick={() => setEntityPage(p => Math.max(1, p - 1))} disabled={entityPage <= 1}
                className="px-3 py-1 border border-gray-300 rounded text-xs disabled:opacity-40 hover:bg-gray-50">
                <ChevronLeft size={14} />
              </button>
              <button onClick={() => setEntityPage(p => Math.min(entities.pagination.pages, p + 1))} disabled={entityPage >= entities.pagination.pages}
                className="px-3 py-1 border border-gray-300 rounded text-xs disabled:opacity-40 hover:bg-gray-50">
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The whole profile of one registry row, plus what sits under it. */
function EntityDetailModal({ entity, onClose }) {
  const { entity: e, children = [] } = entity;
  const [photoMeta, setPhotoMeta] = useState(null);
  // Sub-Distributors can serve several Distributors — the registry files them
  // under one, but their retailers' owners tell the whole story.
  const distributors = entity.distributors || [];

  // The manager photo lives against the record's TIN, fetched from eTrade's
  // Registration API during TIN verification. Look up who it shows while the
  // modal is open so the card can name the manager.
  useEffect(() => {
    setPhotoMeta(null);
    if (!e?.tin) return undefined;
    let cancelled = false;
    channelAPI.getPhotoMeta(e.tin)
      .then((meta) => { if (!cancelled && meta?.found) setPhotoMeta(meta); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [e?.id, e?.tin]);

  // Upline links shown the way the channel thinks: a retailer's Sub-
  // Distributor row names its parent; a sub-distributor's row IS the parent,
  // so its parent slot shows its Distributor instead — no duplicate label
  // carrying the same name on both rows.
  const uplineRows = Number(e.level) === 3
    ? [
      ['Sub-Distributor', e.parent_name ? (e.parent_mobile ? `${e.parent_name} · ${e.parent_mobile}` : e.parent_name) : '--'],
      ['Distributor', e.owner_name ? (e.owner_mobile ? `${e.owner_name} · ${e.owner_mobile}` : e.owner_name) : '--'],
    ]
    : Number(e.level) === 2
      ? [
        ['Distributor', e.owner_name ? (e.owner_mobile ? `${e.owner_name} · ${e.owner_mobile}` : e.owner_name) : '--'],
      ]
      : [];
  const infoGrid = [
    ['Status', e.status], ['Product', e.product],
    ...uplineRows,
    ['Geo', e.geo_domain_raw || '--'],
    // Who recorded this data: the importing operator's username rides on
    // every import, and hand registrations carry it too. The list view shows
    // it under the Source; the modal spells it out.
    ['Source', e.source ? (e.source === 'manual' && (e.created_by_name || e.created_by) ? `${e.source} — recorded by ${e.created_by_name || e.created_by}` : e.source) : '--'],
    ...(e.created_by_name || e.created_by ? [
      ['Recorded By', e.created_by_name || e.created_by],
    ] : []),
    ['TIN Verification', e.tin_verified === 1 || e.tin_verified === true
      ? 'Verified ✓'
      : e.tin
        ? 'Not verified ✗'
        : '--'],
    // Filing address captured from the eTrade workbook.
    ...(e.woreda || e.sub_city || e.house_no ? [[
      'Address',
      [e.sub_city, e.woreda, e.house_no ? `House: ${e.house_no}` : ''].filter(Boolean).join(', '),
    ]] : []),
    ...(e.location ? [['Street Address', e.location]] : []),
    ...(e.trade_name ? [['Trade Name', e.trade_name]] : []),
    // GPS position captured at registration (retailers only).
    ...(Number(e.level) === 3 && e.latitude != null && e.longitude != null ? [
      ['GPS (Lat, Lng)', `${Number(e.latitude).toFixed(6)}, ${Number(e.longitude).toFixed(6)}`],
      ...(e.addr_country || e.addr_city || e.addr_street ? [[
        'Resolved Address',
        [e.addr_street, e.addr_city, e.addr_country].filter(Boolean).join(', '),
      ]] : []),
    ] : []),
    // The seen dates stay off the modal — the register's master view reads
    // through the registry columns only.
    ['Import ID', e.import_code || 'registered by hand'],
    ['Imported On', e.imported_at || '--'],
    ['Import File', e.import_filename || '--'],
    ['First Import', e.first_import_code || '--'],
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{e.user_name}</h2>
            <p className="text-sm text-gray-500 flex items-center gap-2 flex-wrap">
              <span>{e.mobile_number} · {e.category_label} · {e.domain_name}</span>
              <IdentifierTag code={e.identifier_code} />
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gray-600">X</button>
        </div>
        <div className="p-5 space-y-5">
          {/* Company manager photo — attached to the record's TIN from the
              eTrade registration record during TIN verification. */}
          {e.tin && (
            <div className="bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 rounded-xl p-3.5 flex items-center gap-3.5">
              <ManagerPhoto
                tin={e.tin}
                alt={e.user_name}
                className="w-16 h-16 rounded-xl object-cover border-2 border-emerald-400 shrink-0"
              />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-emerald-800 uppercase tracking-wider flex items-center gap-1">
                  <Camera size={11} className="text-emerald-700" />
                  Company Manager Photo
                </p>
                <p className="text-sm font-bold text-gray-900 mt-0.5 truncate">
                  {photoMeta?.manager_name_eng || photoMeta?.manager_name || e.user_name}
                </p>
                <p className="text-[11px] text-gray-500 font-mono">
                  TIN {e.tin}
                  {photoMeta?.source === 'upload' ? ' · custom upload' : photoMeta ? ' · eTrade / MoR' : ''}
                </p>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {infoGrid.map(([label, val]) => (
              <div key={label}>
                <p className="text-xs text-gray-500">{label}</p>
                <p className="text-sm font-medium text-gray-800">{val || '--'}</p>
              </div>
            ))}
          </div>
          {Number(e.level) === 2 && distributors.length > 1 && (
            <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-3">
              <p className="text-[10px] font-bold text-indigo-800 uppercase tracking-wider mb-1.5">
                Works with {distributors.length} Distributors
              </p>
              <div className="space-y-1">
                {distributors.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 text-xs">
                    <span className="font-medium text-gray-800 truncate flex-1" title={d.user_name}>{d.user_name}</span>
                    <span className="text-gray-500 font-mono">{d.mobile_number}</span>
                    <span className="text-[10px] text-indigo-500 whitespace-nowrap">{d.retailers} retailer{d.retailers === 1 ? '' : 's'}</span>
                    {d.is_filed && <span className="text-[10px] px-1 rounded bg-white text-indigo-600 border border-indigo-200">filed</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {children.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-800 mb-2">Downstream Users ({children.length})</h4>
              <div className="bg-gray-50 rounded-lg p-3 max-h-48 overflow-y-auto">
                {groupDownstream(children).map((grp) => (
                  <div key={grp.level} className="mb-2 last:mb-0">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
                      {grp.label} ({grp.items.length})
                    </p>
                    {grp.items.map(c => (
                      <div key={c.id} className="flex items-center justify-between py-1 border-b border-gray-100 last:border-0">
                        <div>
                          <span className="text-xs font-medium text-gray-800">{c.user_name}</span>
                          <span className="text-[10px] text-gray-500 ml-2">{c.mobile_number}</span>
                        </div>
                        <span className={'text-[10px] px-1.5 py-0.5 rounded ' + (STATUS_COLORS[c.status] || '')}>{c.status}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
