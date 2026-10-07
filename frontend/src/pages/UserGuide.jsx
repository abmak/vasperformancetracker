import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen, DollarSign, Store, Info, AlertTriangle, CheckCircle2, Loader2,
  Pencil, Save, X, RotateCcw,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { guideAPI } from '../services/api';
import toast from 'react-hot-toast';

/* ────────────────────────────────────────────────────────────────────────────
 * User Guide — content lives in the `guide_content` table (markdown per
 * section) and is editable in place by the super admin (master admin).
 * VAS users see only the VAS guide, IDC users only the channel guide; the
 * global admin (no section selected) gets both tabs.
 * ──────────────────────────────────────────────────────────────────────────── */

const SECTION_META = [
  { key: 'VAS', label: 'VAS Section', icon: DollarSign },
  { key: 'INDIRECT_CHANNEL', label: 'IDC — Indirect Channel', icon: Store },
];

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'topic';

/* ── Inline markdown: **bold**, *italic*, `code` ── */
function renderInline(text, keyBase) {
  const out = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0, m, k = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={`${keyBase}-b${k++}`}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={`${keyBase}-c${k++}`} className="px-1 py-0.5 rounded bg-gray-100 text-[0.85em] font-mono text-gray-800">{tok.slice(1, -1)}</code>);
    else out.push(<em key={`${keyBase}-i${k++}`}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const Callout = ({ tone, children }) => {
  const tones = {
    warn: 'bg-amber-50 border-amber-200 text-amber-900',
    ok: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    info: 'bg-blue-50 border-blue-200 text-blue-900',
  };
  const icon = tone === 'warn'
    ? <AlertTriangle size={16} className="text-amber-600 mt-0.5 shrink-0" />
    : tone === 'ok'
      ? <CheckCircle2 size={16} className="text-emerald-600 mt-0.5 shrink-0" />
      : <Info size={16} className="text-blue-600 mt-0.5 shrink-0" />;
  return (
    <div className={`border rounded-xl p-4 my-2 ${tones[tone]}`}>
      <div className="flex gap-2 text-sm leading-relaxed">{icon}<div className="space-y-2">{children}</div></div>
    </div>
  );
};

/* ── Block-level markdown → React (headings, lists, quotes, paragraphs) ── */
function MarkdownBlocks({ text, slugPrefix }) {
  const lines = (text || '').split(/\r?\n/);
  const nodes = [];
  let i = 0, k = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Headings inside a topic card (### sub-blocks; ## handled at topic split)
    let m = line.match(/^###\s+(.*)$/);
    if (m) {
      nodes.push(<p key={`h3-${slugPrefix}-${k++}`} className="font-bold text-gray-900 pt-1">{renderInline(m[1], `h3${k}`)}</p>);
      i++; continue;
    }

    // Blockquote → callout box (tone from a leading emoji)
    if (/^>/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const joined = quoteLines.join('\n').trim();
      if (joined) {
        const tone = joined.startsWith('⚠️') ? 'warn' : joined.startsWith('✅') ? 'ok' : 'info';
        const cleaned = joined.replace(/^[\u26A0\u2705\u2139\uFE0F]+\s*/gu, '').split(/\n{2,}/).map((para) =>
          para.split('\n').map((l) => l.replace(/^-\s+/, '')).filter(Boolean)
        );
        nodes.push(
          <Callout key={`q-${slugPrefix}-${k++}`} tone={tone}>
            {cleaned.map((para, pi) => (
              para.length === 1
                ? <p key={pi}>{renderInline(para[0], `q${k}-${pi}`)}</p>
                : <ul key={pi} className="list-disc pl-5 space-y-1">{para.map((li, li2) => <li key={li2}>{renderInline(li, `q${k}-${pi}-${li2}`)}</li>)}</ul>
            ))}
          </Callout>
        );
      }
      continue;
    }

    // Unordered list
    if (/^-\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^-\s+/, ''));
        i++;
      }
      nodes.push(
        <ul key={`ul-${slugPrefix}-${k++}`} className="space-y-1.5 my-2">
          {items.map((it, ii) => (
            <li key={ii} className="flex gap-2 text-sm text-gray-700 leading-relaxed">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-2 shrink-0" />
              <span>{renderInline(it, `ul${k}-${ii}`)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      nodes.push(
        <ol key={`ol-${slugPrefix}-${k++}`} className="space-y-2.5 my-3">
          {items.map((it, ii) => (
            <li key={ii} className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{ii + 1}</span>
              <div className="text-sm text-gray-700 leading-relaxed">{renderInline(it, `ol${k}-${ii}`)}</div>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // Paragraph (gather until blank line or a block starter)
    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^###{1,3}\s/.test(lines[i]) && !/^>/.test(lines[i]) &&
      !/^-\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]); i++;
    }
    if (para.length) {
      nodes.push(<p key={`p-${slugPrefix}-${k++}`} className="text-sm text-gray-700 leading-relaxed">{renderInline(para.join(' '), `p${k}`)}</p>);
    }
  }
  return nodes;
}

/* ── Split a markdown doc into topic cards on ## headings ── */
function splitTopics(md) {
  const lines = (md || '').split(/\r?\n/);
  const topics = [];
  let current = null;
  const used = new Set();
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      let slug = slugify(m[1]);
      while (used.has(slug)) slug = slug + '-x';
      used.add(slug);
      current = { title: m[1], slug, lines: [] };
      topics.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return topics.map((t) => ({ title: t.title, slug: t.slug, body: t.lines.join('\n').trim() }));
}

/* ── Page ── */
export default function UserGuide() {
  const { user, isMasterAdmin, hasPermission } = useAuth();
  // Editing the guide needs the guide.edit permission (configurable on the
  // Roles page); the master admin always passes.
  const canEdit = isMasterAdmin || hasPermission('guide.edit');
  const section = user?.section || null;

  // Section-aware: VAS users see the VAS guide only, IDC users the channel
  // guide only; the global admin (no section selected) gets both tabs.
  const tabs = useMemo(() => {
    if (section === 'VAS') return SECTION_META.filter((t) => t.key === 'VAS');
    if (section === 'INDIRECT_CHANNEL') return SECTION_META.filter((t) => t.key === 'INDIRECT_CHANNEL');
    return SECTION_META;
  }, [section]);

  const [tab, setTab] = useState(tabs[0]?.key);
  const [docs, setDocs] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const tabKeys = tabs.map((t) => t.key).join(',');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    Promise.all(tabKeys.split(',').map((s) => guideAPI.get(s)))
      .then((results) => {
        if (!alive) return;
        const next = {};
        for (const r of results) next[r.section] = r;
        setDocs(next);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setLoadError(e.message);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [tabKeys]);

  const activeTab = tabs.find((t) => t.key === tab) || tabs[0];
  const doc = docs[activeTab?.key];
  const topics = useMemo(() => (doc ? splitTopics(doc.content) : []), [doc]);

  function startEditing() {
    setDraft(doc?.content || '');
    setEditing(true);
  }

  async function saveEditing() {
    setSaving(true);
    try {
      const saved = await guideAPI.save(activeTab.key, draft);
      setDocs((prev) => ({ ...prev, [activeTab.key]: saved }));
      setEditing(false);
      toast.success('User Guide saved');
    } catch (e) {
      toast.error(e.message || 'Failed to save the guide');
    }
    setSaving(false);
  }

  const subtitle = tabs.length === 1
    ? (tabs[0].key === 'VAS'
      ? 'How to use the VAS revenue-tracking section.'
      : 'How to use the IDC (Indirect Channel) section.')
    : 'How to use the VAS revenue-tracking section and the IDC (Indirect Channel) section.';

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center">
              <BookOpen size={20} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">User Guide</h1>
              <p className="text-sm text-gray-500">{subtitle}</p>
            </div>
          </div>

          {/* Edit in place for holders of guide.edit */}
          {canEdit && !editing && doc && (
            <button
              onClick={startEditing}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-blue-200 bg-white text-blue-700 hover:bg-blue-50 transition"
            >
              <Pencil size={15} /> Edit Guide
            </button>
          )}
        </div>

        {/* Tabs — only shown when more than one section guide is available */}
        {tabs.length > 1 && !editing && (
          <div className="flex flex-wrap gap-2 mt-5">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border transition ${
                  tab === t.key
                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                    : 'bg-white text-gray-700 border-gray-200 hover:border-blue-300 hover:text-blue-700'
                }`}
              >
                <t.icon size={16} />
                {t.label}
              </button>
            ))}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center gap-3 py-20 text-gray-500">
            <Loader2 size={20} className="animate-spin" /> Loading guide…
          </div>
        )}

        {loadError && !loading && (
          <div className="mt-6 bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm">
            Could not load the guide: {loadError}
          </div>
        )}

        {/* Editor (super admin) */}
        {!loading && !loadError && editing && (
          <div className="mt-6">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <p className="text-sm text-gray-600">
                Editing the <strong>{activeTab.label}</strong> guide — markdown supports{' '}
                <code className="px-1 rounded bg-gray-100 text-xs">## headings</code>,{' '}
                <code className="px-1 rounded bg-gray-100 text-xs">- bullets</code>,{' '}
                <code className="px-1 rounded bg-gray-100 text-xs">1. steps</code>,{' '}
                <code className="px-1 rounded bg-gray-100 text-xs">&gt; callout boxes</code>,{' '}
                <code className="px-1 rounded bg-gray-100 text-xs">**bold**</code>,{' '}
                <code className="px-1 rounded bg-gray-100 text-xs">`code`</code>. Each{' '}
                <code className="px-1 rounded bg-gray-100 text-xs">##</code> heading becomes a topic card with its own sidebar link.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setEditing(false)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition"
                  disabled={saving}
                >
                  <X size={15} /> Cancel
                </button>
                <button
                  onClick={saveEditing}
                  disabled={saving || !draft.trim()}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-50"
                >
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  Save Guide
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="w-full h-[65vh] p-4 rounded-2xl border border-gray-300 font-mono text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                placeholder="Write the guide in markdown…"
              />
              <div className="h-[65vh] overflow-y-auto p-5 rounded-2xl border border-gray-200 bg-white space-y-5">
                {splitTopics(draft).map((t) => (
                  <section key={t.slug} className="bg-gray-50 rounded-xl border border-gray-100 p-4">
                    <h3 className="font-bold text-gray-900 mb-2 flex items-center gap-2"><BookOpen size={15} className="text-blue-600" />{t.title}</h3>
                    <MarkdownBlocks text={t.body} slugPrefix={`prev-${t.slug}`} />
                  </section>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Read view */}
        {!loading && !loadError && !editing && doc && (
          <div className="flex flex-col lg:flex-row gap-6 mt-6">
            {/* Topic nav */}
            <nav className="lg:w-60 shrink-0 lg:sticky lg:top-6 self-start">
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-2 flex flex-row flex-wrap lg:flex-col gap-1">
                {topics.map((t) => (
                  <a
                    key={t.slug}
                    href={`#${t.slug}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition"
                  >
                    <BookOpen size={15} className="text-gray-400 shrink-0" />
                    {t.title}
                  </a>
                ))}
              </div>
            </nav>

            {/* Content */}
            <div className="flex-1 space-y-5 min-w-0">
              {topics.map((t) => (
                <section key={t.slug} id={t.slug} className="scroll-mt-24 bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-9 h-9 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center">
                      <BookOpen size={18} />
                    </div>
                    <h2 className="text-lg font-bold text-gray-900">{t.title}</h2>
                  </div>
                  <div className="space-y-2">
                    <MarkdownBlocks text={t.body} slugPrefix={t.slug} />
                  </div>
                </section>
              ))}
              <p className="text-xs text-gray-400 text-center pt-2">
                {doc.updated_by && doc.updated_at
                  ? `Last updated by ${doc.updated_by} on ${new Date(doc.updated_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}.`
                  : 'Built-in guide content.'}
                {' '}The sidebar link “User Guide” is available from every page.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
