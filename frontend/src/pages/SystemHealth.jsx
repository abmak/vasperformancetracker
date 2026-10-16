import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  Activity, Server, Database, RefreshCw, CheckCircle2, XCircle, AlertTriangle,
  Clock, ShieldAlert, ArrowRightLeft, HardDrive, Gauge, Lock, Archive, Timer,
  History, MemoryStick, HardDriveDownload, Info, Pause, Play,
  ListChecks,
} from 'lucide-react';
import { systemAPI } from '../services/api';

/**
 * System Health — Administration module for the master admin.
 *
 * Shows which database the app is currently serving from (primary/standby),
 * liveness of both PostgreSQL instances, streaming replication state (a standby
 * is read-only until it is promoted) and the three tiered pg_dump backups
 * (10-minute, hourly, nightly) — one card per tier.
 * Data from GET /api/system/health.
 */

function timeAgo(iso, secondsAgo) {
  if (iso && secondsAgo == null) secondsAgo = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (secondsAgo == null || Number.isNaN(secondsAgo)) return '—';
  if (secondsAgo < 5) return 'just now';
  if (secondsAgo < 90) return `${secondsAgo}s ago`;
  const m = Math.round(secondsAgo / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

function MetricBar({ label, icon: Icon, usedPct, detail, tone }) {
  const colors = {
    emerald: { bar: 'bg-emerald-500', text: 'text-emerald-700' },
    amber: { bar: 'bg-amber-500', text: 'text-amber-700' },
    red: { bar: 'bg-red-500', text: 'text-red-700' },
    gray: { bar: 'bg-gray-300', text: 'text-gray-500' },
  }[tone || 'gray'];
  return (
    <div className="rounded-xl border shadow-sm p-4 bg-white">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <Icon className="w-4 h-4 text-gray-500" />
          {label}
        </div>
        <span className={`text-sm font-bold ${colors.text}`}>{usedPct == null ? '—' : `${usedPct}%`}</span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-gray-100 overflow-hidden">
        <div
          className={`h-full rounded-full ${colors.bar} transition-all duration-500`}
          style={{ width: `${Math.min(100, usedPct == null ? 0 : usedPct)}%` }}
        />
      </div>
      <div className="mt-1.5 text-xs text-gray-500">{detail}</div>
    </div>
  );
}

function StatusCard({ title, icon: Icon, up, sub, tone }) {
  const color = tone || (up === true ? 'emerald' : up === false ? 'red' : 'gray');
  const map = {
    emerald: { ring: 'border-emerald-200 bg-emerald-50', dot: 'text-emerald-600', chip: 'bg-emerald-100 text-emerald-700' },
    red: { ring: 'border-red-200 bg-red-50', dot: 'text-red-600', chip: 'bg-red-100 text-red-700' },
    gray: { ring: 'border-gray-200 bg-gray-50', dot: 'text-gray-400', chip: 'bg-gray-100 text-gray-600' },
    amber: { ring: 'border-amber-200 bg-amber-50', dot: 'text-amber-600', chip: 'bg-amber-100 text-amber-700' },
  }[color];
  return (
    <div className={`rounded-xl border shadow-sm p-4 ${map.ring}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <Icon className="w-4 h-4 text-gray-500" />
          {title}
        </div>
        {up === true && <CheckCircle2 className={`w-5 h-5 ${map.dot}`} />}
        {up === false && <XCircle className={`w-5 h-5 ${map.dot}`} />}
        {up == null && <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${map.chip}`}>N/A</span>}
      </div>
      <div className="mt-2 text-xs text-gray-600">{sub}</div>
    </div>
  );
}

/**
 * Accent per backup tier: the three cadences are visually distinct, while a
 * broken tier still turns red and an unknown one stays neutral — so the colour
 * never claims more than the light does.
 */
const TIER_COLORS = {
  tenMin: { border: 'border-sky-200', bg: 'bg-sky-50', icon: 'text-sky-600', chip: 'bg-sky-100 text-sky-700' },
  hourly: { border: 'border-violet-200', bg: 'bg-violet-50', icon: 'text-violet-600', chip: 'bg-violet-100 text-violet-700' },
  nightly: { border: 'border-emerald-200', bg: 'bg-emerald-50', icon: 'text-emerald-600', chip: 'bg-emerald-100 text-emerald-700' },
  red: { border: 'border-red-200', bg: 'bg-red-50', icon: 'text-red-600', chip: 'bg-red-100 text-red-700' },
  gray: { border: 'border-gray-200', bg: 'bg-gray-50', icon: 'text-gray-400', chip: 'bg-gray-100 text-gray-500' },
};

// One card per cadence, mirroring the retention in scripts/db/pg-backup.sh.
const BACKUP_TIER_CARDS = [
  { key: 'tenMin', title: '10-minute backup', icon: Timer, accent: 'tenMin', retention: 'last hour (6)' },
  { key: 'hourly', title: 'Hourly backup', icon: Clock, accent: 'hourly', retention: 'last day (24)' },
  { key: 'nightly', title: 'Nightly backup', icon: Archive, accent: 'nightly', retention: 'last 14 days' },
];

/**
 * BackupTierCard — one backup tier, on its own card.
 *
 * Split out from StatusCard so each tier carries its own colour: a fresh
 * 10-minute dump must never make a nightly tier that stopped days ago look fine.
 */
function BackupTierCard({ title, icon: Icon, accent = 'tenMin', up, retention, newest, count, emptyText }) {
  const palette = TIER_COLORS[up === true ? accent : up === false ? 'red' : 'gray'] || TIER_COLORS.gray;
  return (
    <div className={`rounded-xl border shadow-sm p-4 ${palette.border} ${palette.bg}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <Icon className={`w-4 h-4 ${palette.icon}`} />
          {title}
        </div>
        {up === true && <CheckCircle2 className="w-5 h-5 text-emerald-600" />}
        {up === false && <XCircle className="w-5 h-5 text-red-600" />}
        {up == null && <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${palette.chip}`}>N/A</span>}
      </div>
      <div className="mt-2 text-xs text-gray-600 space-y-0.5">
        {emptyText ? (
          <div>{emptyText}</div>
        ) : (
          <>
            <div>
              {newest
                ? <>newest {timeAgo(newest.mtime, newest.ageHours != null ? Math.round(newest.ageHours * 3600) : null)} · {(newest.sizeBytes / 1024).toFixed(0)} KB</>
                : 'none yet'}
            </div>
            <div>{count} file(s) kept{retention ? ` · ${retention}` : ''}</div>
          </>
        )}
      </div>
    </div>
  );
}

export default function SystemHealth() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [syncBusy, setSyncBusy] = useState(false);
  const [intervalDraft, setIntervalDraft] = useState('');
  // The 15-second auto-refresh must not type over the operator's edit.
  const [intervalDirty, setIntervalDirty] = useState(false);
  const [intervalBusy, setIntervalBusy] = useState(false);
  // Failover connection attempt timeout (seconds)
  const [timeoutDraft, setTimeoutDraft] = useState('');
  const [timeoutDirty, setTimeoutDirty] = useState(false);
  const [timeoutBusy, setTimeoutBusy] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const d = await systemAPI.getHealth();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const controlSync = useCallback(async (action) => {
    if (action === 'pause' && !window.confirm(
      'Pause replication to the standby?\n\n- The standby keeps receiving WAL but stops applying it\n- It falls further behind while paused\n- If the primary fails while paused, a promotion loses everything written since\n\nResume anytime from this page.'
    )) return;
    setSyncBusy(true);
    try {
      const r = await systemAPI.controlSync(action);
      if (r.warning) toast(r.warning, { icon: '⏸️', duration: 6000 });
      else toast.success('Standby replication ' + (action === 'pause' ? 'paused' : 'resumed'));
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSyncBusy(false);
    }
  }, [load]);

  const saveInterval = useCallback(async () => {
    const minutes = Number(intervalDraft);
    if (!Number.isInteger(minutes)) {
      toast.error('Enter a whole number of minutes');
      return;
    }
    setIntervalBusy(true);
    try {
      const r = await systemAPI.setStandbyInterval(minutes);
      toast.success(`Standby copy cadence saved: every ${r.minutes} min — the daemon picks it up within ${r.pickupSeconds}s`);
      setIntervalDirty(false);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setIntervalBusy(false);
    }
  }, [intervalDraft, load]);

  const saveTimeout = useCallback(async () => {
    const seconds = Number(timeoutDraft);
    if (!Number.isInteger(seconds)) {
      toast.error('Enter a whole number of seconds');
      return;
    }
    setTimeoutBusy(true);
    try {
      const r = await systemAPI.setConnectionTimeout(seconds);
      toast.success(`Failover timeout saved: a connection attempt is given ${r.seconds}s before the app fails over`);
      setTimeoutDirty(false);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setTimeoutBusy(false);
    }
  }, [timeoutDraft, load]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  const target = data?.dbTarget;
  const failoverActive = data?.failover?.active;
  // PostgreSQL replaced the MySQL db-sync daemon: replication state now arrives
  // in `data.replication` (the legacy `data.sync` block is no longer shown).
  const replication = data?.replication;
  const replicationPaused = replication?.replayPaused === true;
  const replicationTone = !replication?.configured ? 'gray'
    : replication.error ? 'red'
      : replication.streaming && !replicationPaused ? 'emerald' : 'amber';
  const server = data?.server;
  const tls = data?.tls;
  const backup = data?.backup;
  const timeline = data?.timeline || [];
  // Dev machine: no standby configured → replication/backup cards are
  // production-only and must show neutral, not alarming, states.
  const devMode = Boolean(data && !data.failover?.standbyConfigured);

  const diskTone = !server?.disk ? null
    : server.disk.usedPct >= 85 ? 'red' : server.disk.usedPct >= 70 ? 'amber' : 'emerald';
  const memTone = !server?.memory ? null
    : server.memory.usedPct >= 90 ? 'red' : server.memory.usedPct >= 75 ? 'amber' : 'emerald';
  const tlsTone = !tls ? 'gray'
    : tls.daysLeft <= 1 ? 'red' : tls.daysLeft <= 2.5 ? 'amber' : 'emerald';
  const cpu = data?.cpu;
  const cpuTone = !cpu || cpu.usagePct == null ? 'gray'
    : cpu.usagePct >= 85 ? 'red' : cpu.usagePct >= 60 ? 'amber' : 'emerald';
  const processes = data?.processes || null;
  const replicationReady = Boolean(replication?.configured) && !devMode;
  // The retained MySQL standby's whole-database copy cadence (configurable), as
  // opposed to the PostgreSQL standby, which streams and has no interval.
  const standbySync = data?.standbySync;
  const copyMinutes = standbySync?.effectiveMinutes ?? standbySync?.minutes ?? 10;
  const copySource = standbySync?.source === 'config'
    ? `saved by ${standbySync.updatedBy || 'a master admin'}${standbySync.updatedAt ? ' · ' + new Date(standbySync.updatedAt).toLocaleString() : ''}`
    : standbySync?.source === 'env'
      ? 'from DB_SYNC_INTERVAL_MS on the server'
      : 'built-in default — nobody has set one yet';

  useEffect(() => {
    if (!standbySync || intervalDirty) return;
    setIntervalDraft(String(standbySync.minutes));
  }, [standbySync, intervalDirty]);

  // How long one connection attempt may take before failover fires. Lives on
  // the failover layer (it is what decides when the primary counts as dead).
  const connTimeout = data?.failover?.connectionTimeout;
  const timeoutSeconds = connTimeout?.seconds ?? 10;
  const timeoutIsSaved = connTimeout?.source === 'config';
  const timeoutSource = timeoutIsSaved
    ? `saved by ${connTimeout.updatedBy || 'a master admin'}${connTimeout.updatedAt ? ' · ' + new Date(connTimeout.updatedAt).toLocaleString() : ''}`
    : connTimeout?.source === 'env'
      ? 'from DB_CONNECT_TIMEOUT_MS on the server'
      : 'built-in default — nobody has set one yet';

  useEffect(() => {
    if (!connTimeout || timeoutDirty) return;
    setTimeoutDraft(String(connTimeout.seconds));
  }, [connTimeout, timeoutDirty]);

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <Activity className="w-6 h-6 text-emerald-600" />
            System Health
          </h1>
          <p className="text-sm text-gray-500">Database failover status and backend liveness</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 mr-1">
            <input
              type="checkbox"
              className="accent-emerald-600"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto (15s)
          </label>
          <button
            onClick={load}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-2">
          <ShieldAlert className="w-5 h-5 text-red-600 mt-0.5" />
          <div className="text-sm text-red-700">
            Could not load health data: {error}
            <div className="text-xs text-red-500 mt-1">
              You need a GLOBAL-scope (master admin) role to view this page.
            </div>
          </div>
        </div>
      )}

      {/* Dev environment notice */}
      {data && devMode && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 flex items-start gap-2">
          <Info className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
          <div className="text-xs text-blue-800">
            <span className="font-semibold">Development environment.</span> The standby database, streaming
            replication, TLS certificate and tiered backups live on the production VPS — the cards below reflect
            this machine only. Open the production app (https://196.189.155.179:5000) for the full picture.
          </div>
        </div>
      )}

      {/* Active incident banner */}
      {data && failoverActive && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5" />
          <div className="text-sm text-amber-800">
            <span className="font-bold">Failover active — the app is running on the STANDBY database.</span>{' '}
            {data.failover?.standbyPromoted ? (
              <>
                The standby was <span className="font-semibold">promoted</span> and now accepts writes, so it owns
                data the old primary never saw. Failback stays blocked until the primary is rebuilt as a fresh
                replica of it (see the database runbook) — that is why the switch back is not automatic here.
              </>
            ) : (
              <>
                The primary is unreachable. Writes go to the failover target, and the primary has to be rebuilt
                from it before traffic can move back.
              </>
            )}
            {data.failover?.failbackAllowed === false && (
              <div className="mt-1 font-semibold text-amber-900">
                Failback blocked: the promoted standby holds newer data than the old primary.
              </div>
            )}
          </div>
        </div>
      )}

      {data && (
        <>
          {/* Currently serving from */}
          <div className={`rounded-xl border shadow-sm p-5 ${failoverActive ? 'border-amber-300 bg-gradient-to-r from-amber-50 to-white' : 'border-gray-200 bg-gradient-to-r from-emerald-50 to-white'}`}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl ${failoverActive ? 'bg-amber-100' : 'bg-emerald-100'}`}>
                  <Database className={`w-6 h-6 ${failoverActive ? 'text-amber-600' : 'text-emerald-600'}`} />
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-gray-500 font-semibold">App is currently using</div>
                  <div className="text-2xl font-bold text-gray-900">
                    {target === 'primary' ? 'Primary Database' : target === 'standby' ? 'Standby Database (failover)' : 'Unknown'}
                  </div>
                </div>
              </div>
              <div className="text-right text-xs text-gray-500">
                <div>
                  Failover layer:{' '}
                  <span className={`font-semibold ${data.failover?.enabled ? 'text-emerald-700' : 'text-gray-500'}`}>
                    {data.failover?.enabled ? 'Enabled' : 'Not configured'}
                  </span>
                </div>
                <div className="mt-0.5">
                  API server: <span className="font-semibold text-gray-700">running</span>
                  {data.app?.databaseReachable === false && (
                    <span className="font-semibold text-red-600"> · DB unreachable</span>
                  )}
                </div>
                <div className="mt-0.5">
                  Failover after:{' '}
                  <span className="font-semibold text-gray-700">{timeoutSeconds}s</span> without a connection
                </div>
              </div>
            </div>
          </div>

          {/* Instance cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            <StatusCard
              title={`Primary (${data.instances?.primary?.address?.port || 5432})`}
              icon={Server}
              up={data.instances?.primary?.up}
              sub={
                <>
                  {data.instances?.primary?.address
                    && <div className="font-mono">{data.instances.primary.address.host}:{data.instances.primary.address.port}</div>}
                  {data.instances?.primary?.up === false && data.instances?.primary?.error
                    && <div className="text-red-600">{data.instances.primary.error}</div>}
                  {data.instances?.primary?.inRecovery === true && (
                    <div className="text-amber-700 font-medium">running as a read-only replica</div>
                  )}
                  {target === 'primary' && <div className="text-emerald-700 font-medium">serving the app now</div>}
                </>
              }
            />
            <StatusCard
              title={`Standby (${data.instances?.standby?.address?.port || 5433})`}
              icon={HardDrive}
              up={data.failover?.standbyConfigured ? data.instances?.standby?.up : null}
              sub={
                <>
                  {data.failover?.standbyConfigured ? (
                    <>
                      {data.instances?.standby?.address
                        && <div className="font-mono">{data.instances.standby.address.host}:{data.instances.standby.address.port}</div>}
                      {data.instances?.standby?.up === false && data.instances?.standby?.error
                        && <div className="text-red-600">{data.instances.standby.error}</div>}
                      {data.instances?.standby?.inRecovery === true && (
                        <div>read-only replica — promotion makes it writable</div>
                      )}
                      {data.instances?.standby?.inRecovery === false && (
                        <div className="text-amber-700 font-medium">promoted — accepts writes</div>
                      )}
                      {target === 'standby' && <div className="text-emerald-700 font-medium">serving the app now</div>}
                    </>
                  ) : (
                    <div>Not configured on this server</div>
                  )}
                </>
              }
            />
            <StatusCard
              title="Replication (primary → standby)"
              icon={ArrowRightLeft}
              up={devMode || !replication?.configured ? null
                : replication.streaming && !replicationPaused}
              tone={devMode ? 'gray' : replicationTone}
              sub={
                devMode || !replication?.configured ? (
                  <div>Streaming replication runs on the production VPS</div>
                ) : replication.error ? (
                  <div className="text-red-600">{replication.error}</div>
                ) : (
                  <>
                    <div>
                      {replication.state
                        ? `${replication.state}${replication.syncState ? ' · ' + replication.syncState : ''}`
                        : 'no replica connected'}
                    </div>
                    <div>
                      lag {replication.lagBytes == null
                        ? '—'
                        : `${(replication.lagBytes / 1024).toFixed(0)} KB`}
                      {replication.lagSeconds != null && <> · {replication.lagSeconds}s behind</>}
                    </div>
                    {replication.lastReplayAt && (
                      <div>last replayed {timeAgo(replication.lastReplayAt, null)}</div>
                    )}
                  </>
                )
              }
            />
          </div>

          {/* Server resources + TLS */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <MetricBar
              label="Disk usage"
              icon={HardDriveDownload}
              usedPct={server?.disk?.usedPct}
              tone={diskTone}
              detail={server?.disk
                ? `${server.disk.freeGb} GB free of ${server.disk.totalGb} GB`
                : 'not available on this server'}
            />
            <MetricBar
              label="Memory usage"
              icon={MemoryStick}
              usedPct={server?.memory?.usedPct}
              tone={memTone}
              detail={server?.memory
                ? `${server.memory.freeMb} MB free of ${server.memory.totalMb} MB`
                : 'not available'}
            />
            <MetricBar
              label="CPU usage"
              icon={Gauge}
              usedPct={cpu?.usagePct}
              tone={cpuTone}
              detail={cpu
                ? `${cpu.coreCount} cores · load ${cpu.loadAvg ? cpu.loadAvg.join(' / ') : '—'}${cpu.cores ? ' · per-core ' + cpu.cores.join('%/') + '%' : ''}`
                : 'not available'}
            />
            <StatusCard
              title="TLS certificate"
              icon={Lock}
              up={tls ? tls.daysLeft > 2.5 : null}
              tone={tlsTone}
              sub={tls ? (
                <>
                  <div>expires in <span className="font-bold">{tls.daysLeft} days</span></div>
                  <div>{new Date(tls.expiresAt).toLocaleString()}</div>
                  {tls.daysLeft <= 2.5 && (
                    <div className="text-red-600 font-medium">
                      renew soon — the external renewal machine must drop the challenge file
                    </div>
                  )}
                </>
              ) : (
                <div>certificate probe unavailable</div>
              )}
            />
          </div>

          {/* Backup tiers — one card per cadence, each with its own colour so a
              stale tier is visible without reading the numbers. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {backup?.tiers ? (
              BACKUP_TIER_CARDS.map(({ key, title, icon, accent, retention }) => (
                <BackupTierCard
                  key={key}
                  title={title}
                  icon={icon}
                  accent={accent}
                  up={devMode ? null : (backup.tiers[key]?.ok ?? null)}
                  retention={retention}
                  newest={backup.tiers[key]?.newest || null}
                  count={backup.tiers[key]?.count ?? 0}
                />
              ))
            ) : (
              // No tier breakdown: either this machine has no backup folder at
              // all (dev) or the retained MySQL dumps are still the only ones.
              <BackupTierCard
                title="Backups"
                icon={Archive}
                accent="nightly"
                up={devMode || !backup || backup.ok == null ? null : backup.ok}
                newest={backup?.newest || null}
                count={backup?.backupCount ?? 0}
                emptyText={devMode
                  ? 'Tiered backups are stored on the production VPS (~/backups)'
                  : !backup ? 'backup folder not readable' : null}
              />
            )}
          </div>

          {backup?.backupCount != null && (
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-gray-500">
              <span>{backup.backupCount} backup file(s) kept in ~/backups</span>
              {backup.problem && <span className="text-red-600 font-medium">· {backup.problem}</span>}
            </div>
          )}

          {/* Sync controller + failover timing + copy cadence + pm2 services */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                  <ArrowRightLeft className="w-4 h-4 text-gray-500" />
                  Streaming replication controller
                </div>
                {replicationReady ? (
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${replicationPaused ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                    {replicationPaused ? 'REPLAY PAUSED' : 'STREAMING'}
                  </span>
                ) : (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">N/A</span>
                )}
              </div>
              <p className="mt-2 text-xs text-gray-500">
                The standby streams the primary's write-ahead log continuously. Pausing replay keeps receiving WAL
                but stops applying it, so the standby falls behind — and a promotion taken while paused would lose
                everything written since.
              </p>
              {replicationReady && (
                <button
                  onClick={() => controlSync(replicationPaused ? 'resume' : 'pause')}
                  disabled={syncBusy}
                  className={`mt-3 inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold rounded-lg text-white disabled:opacity-50 ${
                    replicationPaused
                      ? 'bg-emerald-600 hover:bg-emerald-700'
                      : 'bg-red-600 hover:bg-red-700'
                  }`}
                >
                  {replicationPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                  {replicationPaused ? 'Resume replication' : 'Pause replication'}
                </button>
              )}
              {!replicationReady && (
                <div className="mt-2 text-xs text-blue-700">Streaming replication runs on the production VPS only.</div>
              )}
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                  <Clock className="w-4 h-4 text-gray-500" />
                  Failover timeout
                </div>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-100 text-sky-700">
                  {timeoutSeconds}s
                </span>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                How long a single connection attempt may take before the app treats that database as
                unreachable and fails over to the other one. Lower means a faster switch and a greater
                chance of moving on a brief blip; the minimum is 1 second, because 0 would wait forever
                and hang requests instead of failing over. Applies to the next connection attempt, with
                no restart.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  min={connTimeout?.minSeconds ?? 1}
                  max={connTimeout?.maxSeconds ?? 120}
                  value={timeoutDraft}
                  onChange={(e) => { setTimeoutDraft(e.target.value); setTimeoutDirty(true); }}
                  className="w-24 px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 focus:border-emerald-500 focus:outline-none"
                />
                <span className="text-xs text-gray-500">
                  seconds ({connTimeout?.minSeconds ?? 1}–{connTimeout?.maxSeconds ?? 120})
                </span>
                <button
                  onClick={saveTimeout}
                  disabled={timeoutBusy || !timeoutDirty}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {timeoutBusy && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  Save
                </button>
                {timeoutDirty && <span className="text-xs text-amber-700">unsaved</span>}
              </div>
              <div className="mt-2 text-xs text-gray-400">
                currently: {timeoutSeconds}s · {timeoutSource}
              </div>
              <div className="mt-1 text-xs text-gray-400">
                The liveness probes on this page keep their own 4-second limit, so a long timeout here can
                never make the panel hang.
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                  <Timer className="w-4 h-4 text-gray-500" />
                  Standby copy cadence
                </div>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-100 text-sky-700">
                  every {copyMinutes} min
                </span>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                How often the retained MySQL standby is re-copied wholesale as the rollback path. The
                PostgreSQL standby the app serves from streams WAL continuously and has no interval — this
                setting does not slow that down. A new value is picked up within about a minute, with no
                daemon restart.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  min={standbySync?.minMinutes ?? 1}
                  max={standbySync?.maxMinutes ?? 1440}
                  value={intervalDraft}
                  onChange={(e) => { setIntervalDraft(e.target.value); setIntervalDirty(true); }}
                  className="w-24 px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 focus:border-emerald-500 focus:outline-none"
                />
                <span className="text-xs text-gray-500">
                  minutes ({standbySync?.minMinutes ?? 1}–{standbySync?.maxMinutes ?? 1440})
                </span>
                <button
                  onClick={saveInterval}
                  disabled={intervalBusy || !intervalDirty}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {intervalBusy && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  Save
                </button>
                {intervalDirty && <span className="text-xs text-amber-700">unsaved</span>}
              </div>
              <div className="mt-2 text-xs text-gray-400">
                currently: {copyMinutes} min · {copySource}
                {standbySync && standbySync.effectiveMinutes !== standbySync.minutes && !intervalDirty && (
                  <span className="text-amber-700"> · daemon still on {standbySync.effectiveMinutes} min until its next poll</span>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 mb-2">
                <ListChecks className="w-4 h-4 text-gray-500" />
                Services (pm2)
              </div>
              {processes ? (
                <div className="space-y-1">
                  {processes.map((p) => (
                    <div key={p.name} className="flex items-center justify-between text-xs py-1 border-b border-gray-50 last:border-0">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${p.status === 'online' ? 'bg-emerald-500' : p.status === 'stopped' ? 'bg-gray-400' : 'bg-red-500'}`} />
                        <span className="font-medium text-gray-700">{p.name}</span>
                      </div>
                      <div className="flex items-center gap-3 text-gray-500">
                        <span>{p.memMb} MB</span>
                        <span title="restart count">↺ {p.restarts}</span>
                        <span className={`font-semibold w-14 text-right ${p.status === 'online' ? 'text-emerald-600' : 'text-gray-500'}`}>{p.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-gray-400">pm2 process list unavailable on this machine.</div>
              )}
            </div>
          </div>

          {/* Incident timeline */}
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 mb-3">
              <History className="w-4 h-4 text-gray-500" />
              Incident &amp; replication timeline (latest 20)
            </div>
            {timeline.length === 0 ? (
              <div className="text-xs text-gray-400 py-2">
                {devMode
                  ? 'No events on this machine — incident logging runs with the standby setup on production.'
                  : 'No events recorded yet — failover and replication changes appear here.'}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                {timeline.map((e, i) => {
                  const sev = e.severity || (String(e.type).includes('FAILOVER') || String(e.type).includes('DOWN') ? 'critical' : 'info');
                  const sevColor = sev === 'critical' ? 'bg-red-500'
                    : sev === 'warning' ? 'bg-amber-500' : 'bg-emerald-500';
                  return (
                    <div key={i} className="flex items-start gap-2.5 text-xs py-1 border-b border-gray-50 last:border-0">
                      <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${sevColor}`} />
                      <div className="min-w-0">
                        <span className="font-mono text-[10px] text-gray-400 mr-1.5">
                          {new Date(e.at).toLocaleTimeString()}
                        </span>
                        <span className="text-gray-700">{e.message}</span>
                        <span className="ml-1.5 text-[10px] text-gray-400">({e.source === 'db' ? 'app' : 'daemon'})</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* What this means */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 text-xs text-gray-600 leading-relaxed">
            <span className="font-semibold text-gray-800">How failover works here: </span>
            the standby streams the primary's write-ahead log continuously, so it is only ever a moment
            behind — there is no copy interval to wait out. If a connection attempt to the primary does not
            complete within{' '}
            <span className="font-semibold text-gray-700">{timeoutSeconds} seconds</span>
            {' '}(the failover timeout above, {timeoutIsSaved ? 'your saved value' : 'the built-in default'}),
            the app treats it as unreachable and the next API request moves to the standby: the replica is promoted first (a read-only replica rejects writes),
            then serves, so a user loses at most that one request. Once the primary is healthy again it is
            restored <em>from</em> the standby, so nothing written during the outage is lost, and the app
            switches back automatically. If the standby had to be promoted, it owns data the old primary never
            saw — failback then stays blocked until the primary is rebuilt (see the database runbook).
            Failover/failback events notify master admins automatically and appear in the timeline above.
            {' '}Separately, the retained MySQL standby is still copied whole every{' '}
            <span className="font-semibold text-gray-700">{copyMinutes} minutes</span>
            {' '}({standbySync?.source === 'config' ? 'your saved cadence' : 'the built-in default'}) as the
            rollback path. Status refreshes every 15 seconds while this page is open.
          </div>
        </>
      )}
    </div>
  );
}
