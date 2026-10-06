import { useState, useEffect, useCallback } from 'react';
import {
  Activity, Server, Database, RefreshCw, CheckCircle2, XCircle, AlertTriangle,
  Clock, ShieldAlert, ArrowRightLeft, HardDrive,
} from 'lucide-react';
import { systemAPI } from '../services/api';

/**
 * System Health — Administration module for the master admin.
 *
 * Shows which database the app is currently serving from (primary/standby),
 * liveness of both MySQL instances, the failover marker state and the sync
 * daemon's last successful sync. Data from GET /api/system/health.
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

export default function SystemHealth() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

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
  const sync = data?.sync;
  const staleSync = sync?.lastSyncSecondsAgo != null && sync.lastSyncSecondsAgo > 360;

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

      {/* Active incident banner */}
      {data && failoverActive && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5" />
          <div className="text-sm text-amber-800">
            <span className="font-bold">Failover active — the app is running on the STANDBY database.</span>{' '}
            The primary is unreachable; once it is healthy again the system restores and switches back automatically.
            Writes are safe and are synced back during failback.
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
              </div>
            </div>
          </div>

          {/* Instance cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <StatusCard
              title="Primary (3306)"
              icon={Server}
              up={data.instances?.primary?.up}
              sub={
                <>
                  {data.instances?.primary?.address
                    && <div className="font-mono">{data.instances.primary.address.host}:{data.instances.primary.address.port}</div>}
                  {data.instances?.primary?.up === false && data.instances?.primary?.error
                    && <div className="text-red-600">{data.instances.primary.error}</div>}
                  {target === 'primary' && <div className="text-emerald-700 font-medium">serving the app now</div>}
                </>
              }
            />
            <StatusCard
              title="Standby (3307)"
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
                      {target === 'standby' && <div className="text-emerald-700 font-medium">serving the app now</div>}
                    </>
                  ) : (
                    <div>Not configured on this server</div>
                  )}
                </>
              }
            />
            <StatusCard
              title="Last sync (primary → standby)"
              icon={ArrowRightLeft}
              up={staleSync ? false : Boolean(sync?.lastSyncOk)}
              tone={staleSync ? 'amber' : undefined}
              sub={
                sync?.lastSyncOk ? (
                  <>
                    <div>{timeAgo(sync.lastSyncOk, sync.lastSyncSecondsAgo)}</div>
                    <div>
                      {sync.lastSyncDurationSeconds
                        && <>took {sync.lastSyncDurationSeconds}s · {(sync.lastSyncBytes / 1024).toFixed(0)} KB</>}
                    </div>
                    {sync.lastSyncError && <div className="text-red-600">{sync.lastSyncError}</div>}
                  </>
                ) : (
                  <div>No successful sync recorded yet</div>
                )
              }
            />
            <StatusCard
              title="Sync daemon"
              icon={Clock}
              up={sync?.daemonSecondsAgo != null && sync.daemonSecondsAgo < 600}
              sub={
                <>
                  <div>
                    {sync?.daemonUpdatedAt
                      ? `reporting (${timeAgo(sync.daemonUpdatedAt, sync.daemonSecondsAgo)})`
                      : 'no status file — check pm2'}
                  </div>
                  {sync?.failbackProbeCount > 0 && (
                    <div>
                      failback probe {sync.failbackProbeCount}/{sync.failbackProbeRequired}
                    </div>
                  )}
                  {sync?.lastFailback && (
                    <div>last failback {timeAgo(sync.lastFailback, null)}</div>
                  )}
                </>
              }
            />
          </div>

          {/* What this means */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 text-xs text-gray-600 leading-relaxed">
            <span className="font-semibold text-gray-800">How failover works here: </span>
            every 2 minutes the whole database is copied primary → standby (a full ~3 MB copy, self-healing).
            If the primary crashes, the next API request switches to the standby instantly — users notice nothing
            after that one request. When the primary is healthy again (2 probes), it is restored <em>from</em> the
            standby so no data written during the outage is lost, and the app switches back automatically.
            Status refreshes every 15 seconds while this page is open.
          </div>
        </>
      )}
    </div>
  );
}
