import { useState } from 'react';
import {
  BookOpen, LayoutDashboard, Building2, Target, DollarSign, Upload, FileBarChart,
  Bell, Lightbulb, Bot, Users, Shield, ClipboardList, Layers, Tag, AlertTriangle,
  CheckCircle2, ChevronRight, Info, Map, UserPlus, Network, Store,
} from 'lucide-react';

/* ────────────────────────────────────────────────────────────────────────────
 * User Guide — VAS section + IDC (Indirect Channel) section.
 * Pure documentation: no API calls, safe for every signed-in user.
 * ──────────────────────────────────────────────────────────────────────────── */

const Box = ({ tone = 'info', title, children }) => {
  const tones = {
    info: 'bg-blue-50 border-blue-200 text-blue-900',
    warn: 'bg-amber-50 border-amber-200 text-amber-900',
    ok: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  };
  const icon = tone === 'warn'
    ? <AlertTriangle size={16} className="text-amber-600 mt-0.5 shrink-0" />
    : tone === 'ok'
      ? <CheckCircle2 size={16} className="text-emerald-600 mt-0.5 shrink-0" />
      : <Info size={16} className="text-blue-600 mt-0.5 shrink-0" />;
  return (
    <div className={`border rounded-xl p-4 ${tones[tone]}`}>
      <div className="flex gap-2">
        {icon}
        <div className="text-sm leading-relaxed">
          {title && <p className="font-semibold mb-1">{title}</p>}
          {children}
        </div>
      </div>
    </div>
  );
};

const Steps = ({ items }) => (
  <ol className="space-y-2.5 my-3">
    {items.map((s, i) => (
      <li key={i} className="flex gap-3">
        <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
        <div className="text-sm text-gray-700 leading-relaxed">
          <span className="font-semibold text-gray-900">{s.title}</span>
          {s.text && <span> — {s.text}</span>}
        </div>
      </li>
    ))}
  </ol>
);

const Bullets = ({ items }) => (
  <ul className="space-y-1.5 my-2">
    {items.map((b, i) => (
      <li key={i} className="flex gap-2 text-sm text-gray-700 leading-relaxed">
        <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-2 shrink-0" />
        <span>{b}</span>
      </li>
    ))}
  </ul>
);

const Section = ({ id, icon: Icon, title, children }) => (
  <section id={id} className="scroll-mt-24 bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
    <div className="flex items-center gap-3 mb-4">
      <div className="w-9 h-9 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center">
        <Icon size={18} />
      </div>
      <h2 className="text-lg font-bold text-gray-900">{title}</h2>
    </div>
    <div className="space-y-3">{children}</div>
  </section>
);

/* ── VAS content ─────────────────────────────────────────────────────────── */

const vasTopics = [
  { id: 'vas-overview', label: 'Overview', icon: BookOpen },
  { id: 'vas-dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'vas-services', label: 'VAS Services', icon: Building2 },
  { id: 'vas-targets', label: 'Targets & Goals', icon: Target },
  { id: 'vas-revenue', label: 'Revenue Data', icon: DollarSign },
  { id: 'vas-import', label: 'Excel Import', icon: Upload },
  { id: 'vas-partners', label: 'Partner Revenue', icon: Users },
  { id: 'vas-reports', label: 'Reports & Alerts', icon: FileBarChart },
  { id: 'vas-actions', label: 'Actions & AI', icon: Bot },
  { id: 'vas-admin', label: 'Admin Tools', icon: Shield },
];

const vasContent = (
  <>
    <Section id="vas-overview" icon={BookOpen} title="What the VAS section does">
      <p className="text-sm text-gray-700 leading-relaxed">
        The VAS section tracks <strong>revenue from Value-Added Services</strong> per partner and per service,
        compares it against monthly targets, and turns the numbers into reports, alerts and actions. The typical
        rhythm is: services are defined once, targets are set per month, actual revenue arrives through the Excel
        Import (or manual entries), and the Dashboard / Reports show how the month is performing.
      </p>
      <Bullets items={[
        'Dashboard — the live month at a glance: revenue vs target per service.',
        'Excel Import — the main way monthly partner revenue enters the system.',
        'Reports & Alerts — performance digests and threshold warnings.',
        'Admin tools — Users, Roles, Audit Trail for section administrators.',
      ]} />
    </Section>

    <Section id="vas-dashboard" icon={LayoutDashboard} title="Dashboard">
      <p className="text-sm text-gray-700 leading-relaxed">
        The first page you land on. It summarises the selected month: total revenue, total target, achievement
        percentage, and a per-service breakdown showing which services are on track and which are behind.
      </p>
      <Bullets items={[
        'Use the date/month filter at the top to switch the period you are looking at.',
        'Click a service to drill into its partner-level numbers.',
        'Cards update automatically right after a successful import — no refresh needed.',
      ]} />
    </Section>

    <Section id="vas-services" icon={Building2} title="VAS Services">
      <p className="text-sm text-gray-700 leading-relaxed">
        The registry of billable services (e.g. <em>CRBT Rent</em>, <em>Mobile Terminating</em>, <em>Voice Premium</em>).
        Every revenue record and every target belongs to one of these services.
      </p>
      <Box tone="warn" title="Service names and codes matter — the import matches on them EXACTLY">
        When you import an Excel file, each <strong>sheet name</strong> is matched to a service using strict exact
        matching only: the sheet name must equal a service <strong>code</strong>, a service <strong>name</strong>, or
        contain a whole word that is itself a service code. Partial or fuzzy matches are never guessed.
        <br /><br />
        Example: a sheet named <strong>CRBT</strong> will <em>not</em> be posted under <em>CRBT Rent</em> or
        <em> CRBT Tone Sales</em> — it will be flagged as unmatched so you can decide. If your workbook sheet is
        named <strong>CRBT</strong>, create a service named exactly <strong>CRBT</strong> (or with code
        <strong> CRBT</strong>) first, then import.
      </Box>
      <Bullets items={[
        'Keep one service per product; use the code for stable machine-friendly matching.',
        'Names are what your team sees everywhere; codes are what the importer trusts.',
        'You can add or edit services any time — historical revenue stays attached to the service it was recorded under.',
      ]} />
    </Section>

    <Section id="vas-targets" icon={Target} title="Revenue Targets & Goal Cascading">
      <p className="text-sm text-gray-700 leading-relaxed">
        Targets are set per <strong>service per month</strong> and are what the achievement percentages are measured
        against. Goal Cascading lets you break a bigger target down into smaller owned pieces so responsibility is
        clear.
      </p>
      <Steps items={[
        { title: 'Add a target', text: 'pick the service, the month and the amount (Revenue Targets → Add New Target).' },
        { title: 'Allocate', text: 'split the target across owners using Target Allocation when needed.' },
        { title: 'Cascade', text: 'use Goal Cascading to create child goals under a parent target.' },
      ]} />
    </Section>

    <Section id="vas-revenue" icon={DollarSign} title="Revenue Data">
      <p className="text-sm text-gray-700 leading-relaxed">
        Manual revenue entry and correction. Use it for single adjustments that do not justify a full Excel import —
        for example a late partner correction or a discovered billing fix.
      </p>
      <Bullets items={[
        'Add Revenue Entry: choose the service, amount, date and optional notes.',
        'Edit or remove entries later — every change is written to the Audit Trail.',
        'Bulk monthly data should go through Excel Import instead of manual entry.',
      ]} />
    </Section>

    <Section id="vas-import" icon={Upload} title="Excel Import (monthly partner revenue)">
      <p className="text-sm text-gray-700 leading-relaxed">
        The main pipeline for partner revenue. One workbook, one sheet per VAS service.
      </p>
      <Steps items={[
        { title: 'Prepare the workbook', text: 'name each sheet exactly like the target VAS service (name or code). Sheets like "Premium SMS MT" or "Voice_Premium" match their services automatically.' },
        { title: 'Upload', text: 'Excel Import → choose the file (.xlsx / .xls / .csv, up to 10MB). A preview is generated — nothing is saved yet.' },
        { title: 'Review the preview', text: 'each sheet shows how many rows matched and to which service. Sheets that match no service are listed as unmatched with guidance — those rows are NOT imported.' },
        { title: 'Confirm', text: 'set the revenue month (optional override) and confirm. Valid rows are saved, the Dashboard caches refresh, and the batch appears in the import history.' },
      ]} />
      <Box tone="info" title="How sheet names are matched (strict — no guessing)">
        <Bullets items={[
          'Exact match: sheet name = service name or service code (punctuation/spacing normalised, case-insensitive).',
          'Exact word: any whole word of the sheet name that equals a service code — e.g. a sheet "Voice_Export" matches a service coded VOICE via the word "voice".',
          'Everything else: unmatched. The preview shows the full list of your services so you can fix the sheet name or create the missing service.',
        ]} />
      </Box>
      <Box tone="warn" title="Common pitfalls">
        <Bullets items={[
          'A sheet named after a service that does not exist (yet) will be rejected — create the service first.',
          'One workbook can carry several services; every sheet is handled independently.',
          'Partner Name and Total Revenue columns are detected automatically; keep one partner per row.',
          'Re-importing the same file twice creates duplicate revenue — check the import history first.',
        ]} />
      </Box>
    </Section>

    <Section id="vas-partners" icon={Users} title="Partner Revenue">
      <p className="text-sm text-gray-700 leading-relaxed">
        The record-level view of imported and manual revenue: partner, service, month and amount. Use it to audit
        what an import actually saved, correct a partner name, or remove a wrong record.
      </p>
      <Bullets items={[
        'Filter by month, service or partner to isolate what you need.',
        'Edits here are logged to the Audit Trail with your name.',
      ]} />
    </Section>

    <Section id="vas-reports" icon={FileBarChart} title="Reports & Alerts">
      <p className="text-sm text-gray-700 leading-relaxed">
        <strong>Performance Reports</strong> aggregate revenue vs targets by service and month — the standard pack
        for management reviews. <strong>Revenue Alerts</strong> raise threshold warnings (e.g. a service far behind
        its target) so problems surface before month-end.
      </p>
      <Bullets items={[
        'Reports respect the same month filter as the rest of the section.',
        'Alert rules are configurable; critical alerts also appear as notifications.',
      ]} />
    </Section>

    <Section id="vas-actions" icon={Bot} title="Action Notes & AI Assistant">
      <p className="text-sm text-gray-700 leading-relaxed">
        <strong>Action Notes</strong> track follow-ups ("call partner X about the August dip") with owners and
        status. The <strong>VAS AI Assistant</strong> answers questions about your data in plain language — try
        "which services missed their target last month?". <strong>AI Usage Report</strong> (admins) shows how much
        the team uses the assistant.
      </p>
    </Section>

    <Section id="vas-admin" icon={Shield} title="Admin tools">
      <Bullets items={[
        'Users — create accounts and assign them to the VAS section.',
        'Roles & Permissions — a role grants page-level permissions; users inherit them. Permissions are the gate for every sidebar item.',
        'Audit Trail — who changed what, when. All imports, edits and deletions land here.',
        'Categories — configuration for service groupings used by reports.',
      ]} />
    </Section>
  </>
);

/* ── IDC / Indirect Channel content ──────────────────────────────────────── */

const idcTopics = [
  { id: 'idc-overview', label: 'Overview', icon: BookOpen },
  { id: 'idc-dashboard', label: 'Channel Dashboard', icon: LayoutDashboard },
  { id: 'idc-registry', label: 'Entity Registry', icon: ClipboardList },
  { id: 'idc-batch', label: 'Batch Import', icon: Upload },
  { id: 'idc-single', label: 'Single Registration', icon: UserPlus },
  { id: 'idc-reports', label: 'Channel Reports & Maps', icon: Map },
  { id: 'idc-admin', label: 'Users, Roles & Audit', icon: Shield },
];

const idcContent = (
  <>
    <Section id="idc-overview" icon={Network} title="What the IDC section does">
      <p className="text-sm text-gray-700 leading-relaxed">
        The <strong>Indirect Channel (IDC)</strong> section is the register of the indirect-channel network and its
        trade: who the channel partners are, how they connect to each other, and the stock they hold. Entities are
        organised as a chain:
      </p>
      <div className="flex flex-wrap items-center gap-2 my-3 text-xs font-semibold">
        <span className="px-3 py-1.5 rounded-lg bg-indigo-100 text-indigo-800">Distributor (Level 1)</span>
        <ChevronRight size={14} className="text-gray-400" />
        <span className="px-3 py-1.5 rounded-lg bg-cyan-100 text-cyan-800">Sub-Distributor (Level 2)</span>
        <ChevronRight size={14} className="text-gray-400" />
        <span className="px-3 py-1.5 rounded-lg bg-emerald-100 text-emerald-800">Retailer (Level 3)</span>
      </div>
      <Bullets items={[
        'Every entity belongs to a domain — IDC, Yimulu or Enterprise — and reports group them accordingly.',
        'Each entity gets an identifier code an operator can quote, e.g. IDC-R-0001 for a retailer.',
        'A Sub-Distributor trades under a Distributor; a Retailer under a Sub-Distributor — the parent is chosen at registration.',
      ]} />
    </Section>

    <Section id="idc-dashboard" icon={LayoutDashboard} title="Channel Dashboard">
      <p className="text-sm text-gray-700 leading-relaxed">
        The landing page for the section: how many entities exist per level and domain, recent registrations, and
        quick links into the registry and imports. Start here to see the health of the network at a glance.
      </p>
    </Section>

    <Section id="idc-registry" icon={ClipboardList} title="Entity Registry">
      <p className="text-sm text-gray-700 leading-relaxed">
        The searchable register of every channel entity. What you can do inside depends on your permissions —
        viewing, editing and deleting are separate grants, and <em>own</em>-scoped variants let users manage only
        the entities they registered.
      </p>
      <Bullets items={[
        'Search and filter by level, domain, region or status.',
        'Open an entity to see its profile and its place in the chain (parent links).',
        'Edits and deletions are permission-gated and written to the Audit Trail.',
      ]} />
    </Section>

    <Section id="idc-batch" icon={Upload} title="Batch Import (Excel)">
      <p className="text-sm text-gray-700 leading-relaxed">
        Registers or updates many entities at once from one workbook. <strong>Each level has its own sheet layout,
        and the layout identifies the level</strong> — there is no Category column to fill in. Upload one, two or
        all three sheets together.
      </p>
      <Bullets items={[
        'Distributor sheet — Distributor Name, Mobile Number, Status, Region, Air Time Type.',
        'Sub-Distributor sheet — adds the parent Distributor Name / Region / Contact.',
        'Retailer sheet — adds Existing Business, Geographical Domain, Sub-Distributor link, and optional TIN / Location / National-Fayda ID.',
      ]} />
      <Steps items={[
        { title: 'Download the template', text: 'use the All Levels Template (or a single-level one) so the columns are right from the start.' },
        { title: 'Fill the sheets', text: 'column headings are matched loosely — common source spellings like "Distributer Region" still work.' },
        { title: 'Upload and review', text: 'the importer validates rows, flags duplicates and reconciles against the summary sheet before anything is saved.' },
        { title: 'Confirm', text: 'clean rows are registered; problem rows are listed with the reason so you can fix and re-upload just those.' },
      ]} />
      <Box tone="info" title="Stock balance data">
        The Batch Import page also carries the channel <strong>stock balance</strong> upload: the system validates
        it, flags duplicates, and reconciles it against the summary sheet the same way.
      </Box>
    </Section>

    <Section id="idc-single" icon={UserPlus} title="Single Registration">
      <p className="text-sm text-gray-700 leading-relaxed">
        Register one entity at a time through a form that mirrors the batch workbook columns for its level — useful
        for walk-in registrations and corrections without preparing a file.
      </p>
      <Bullets items={[
        'Pick the level first; the form shows exactly the fields that level needs.',
        'The parent (Distributor / Sub-Distributor) is picked from existing registered entities.',
        'Sub-Distributors have no territory or business of their own in the IDC model — the region they trade in identifies them.',
      ]} />
    </Section>

    <Section id="idc-reports" icon={Map} title="Channel Reports & Retailer Maps">
      <p className="text-sm text-gray-700 leading-relaxed">
        <strong>Channel Reports</strong> show the register spread across the IDC / Yimulu / Enterprise domains,
        level by level — the chain view makes coverage gaps obvious. The <strong>Retailer Maps</strong> plot the
        retailer network on the two geographical maps for a visual density check.
      </p>
      <Bullets items={[
        'Filter by domain, region or level to focus the report.',
        'Registration correctness shows up here first — a retailer linked to the wrong sub-distributor is visible in the chain view.',
      ]} />
    </Section>

    <Section id="idc-admin" icon={Shield} title="Users, Roles & Audit">
      <Bullets items={[
        'Users — channel-scope accounts (IDC Admin, channel staff).',
        'Roles — channel permissions are separate from VAS ones; the section admins manage their own.',
        'Audit Trail — every registration, edit and deletion in the channel register is recorded.',
      ]} />
    </Section>
  </>
);

/* ── Page shell ──────────────────────────────────────────────────────────── */

const TABS = [
  { key: 'vas', label: 'VAS Section', icon: DollarSign, topics: vasTopics, content: vasContent },
  { key: 'idc', label: 'IDC — Indirect Channel', icon: Store, topics: idcTopics, content: idcContent },
];

export default function UserGuide() {
  const [tab, setTab] = useState('vas');
  const active = TABS.find(t => t.key === tab);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center">
            <BookOpen size={20} />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">User Guide</h1>
        </div>
        <p className="text-sm text-gray-500 mb-6">
          How to use the VAS revenue-tracking section and the IDC (Indirect Channel) section.
        </p>

        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-6">
          {TABS.map(t => (
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

        <div className="flex flex-col lg:flex-row gap-6">
          {/* Topic nav */}
          <nav className="lg:w-60 shrink-0 lg:sticky lg:top-6 self-start">
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-2 flex flex-row flex-wrap lg:flex-col gap-1">
              {active.topics.map(t => (
                <a
                  key={t.id}
                  href={`#${t.id}`}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition"
                >
                  <t.icon size={15} className="text-gray-400 shrink-0" />
                  {t.label}
                </a>
              ))}
            </div>
          </nav>

          {/* Content */}
          <div className="flex-1 space-y-5 min-w-0">
            {active.content}
            <p className="text-xs text-gray-400 text-center pt-2">
              Tip: the sidebar link “User Guide” is available from every page. Last updated October 2026.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
