import { Hash } from 'lucide-react';

/**
 * Small registry visuals shared by every channel view that lists entities —
 * the standalone Entity Registry page and the dashboard's Hierarchy tab.
 * They live here so the two can never drift apart.
 */

export const STATUS_COLORS = {
  active: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  canceled: 'bg-red-100 text-red-700 border-red-200',
  inactive: 'bg-gray-100 text-gray-700 border-gray-200',
};

/**
 * The identifier code an operator quotes — IDC-R-0001.
 *
 * Every Distributor, Sub-Distributor and Retailer is given one on import, so it
 * is the stable way to refer to a record that does not depend on its row id.
 */
export function IdentifierTag({ code }) {
  if (!code) return <span className="text-xs text-gray-300">—</span>;
  return (
    <span
      className="inline-flex items-center gap-1 font-mono font-semibold text-[11px] px-1.5 py-0.5 rounded-md border border-indigo-100 bg-indigo-50 text-indigo-700"
      title="Identifier Code"
    >
      <Hash size={10} className="text-indigo-400" />
      {code}
    </span>
  );
}

/**
 * The import a record came from: its short id and the moment the file landed.
 *
 * Every import gets one unique id (IMP-YYYYMMDD-NN) which is stamped on each
 * user it writes, so a row can always be traced back to the run that brought it
 * in — and deleting that run removes exactly those users.
 */
export function ImportStamp({ code, at }) {
  if (!code) return <span className="text-xs text-gray-300">registered by hand</span>;
  return (
    <span title={at ? `Imported ${at}` : undefined}>
      <span className="block font-mono text-xs font-medium text-blue-700">{code}</span>
      {at && <span className="block text-[10px] text-gray-400">{at}</span>}
    </span>
  );
}

/**
 * Downstream children grouped the way the channel thinks: Distributors first,
 * then Sub-Distributors, then Retailers. Every list that renders children —
 * the hierarchy card and the registry detail modal — goes through this so the
 * ordering and headings can never drift apart.
 */
export const DOWNSTREAM_GROUPS = [
  { level: 1, label: 'Distributors' },
  { level: 2, label: 'Sub-Distributors' },
  { level: 3, label: 'Retailers' },
];

export function groupDownstream(children) {
  const buckets = { 1: [], 2: [], 3: [] };
  (children || []).forEach((c) => {
    const l = Number(c.level);
    if (buckets[l]) buckets[l].push(c);
  });
  return DOWNSTREAM_GROUPS
    .filter((g) => buckets[g.level].length > 0)
    .map((g) => ({ ...g, items: buckets[g.level] }));
}
