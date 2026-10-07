/* Default User Guide content, stored as markdown.
 *
 * These seeds are inserted into the `guide_content` table the first time the
 * guide API is used (one row per section). From then on the super admin edits
 * the rows freely; deleting a row restores the default on next boot's re-seed.
 *
 * Markdown subset the frontend renders:
 *   ## Heading            — topic card (drives the side navigation)
 *   ### Sub-heading       — bold sub-block inside a card
 *   - bullet / 1. numbered lists
 *   > blockquote          — info box (tone from leading emoji: ⚠️ warn, ✅ ok)
 *   **bold**, *italic*, `code`
 */

const VAS_GUIDE = `## Overview
The VAS section tracks **revenue from Value-Added Services** per partner and per service, compares it against monthly targets, and turns the numbers into reports, alerts and actions. The typical rhythm is: services are defined once, targets are set per month, actual revenue arrives through the Excel Import (or manual entries), and the Dashboard / Reports show how the month is performing.

- **Dashboard** — the live month at a glance: revenue vs target per service.
- **Excel Import** — the main way monthly partner revenue enters the system.
- **Reports & Alerts** — performance digests and threshold warnings.
- **Admin tools** — Users, Roles, Audit Trail for section administrators.

## Dashboard
The first page you land on. It summarises the selected month: total revenue, total target, achievement percentage, and a per-service breakdown showing which services are on track and which are behind.

- Use the date/month filter at the top to switch the period you are looking at.
- Click a service to drill into its partner-level numbers.
- Cards update automatically right after a successful import — no refresh needed.

## VAS Services
The registry of billable services (e.g. *CRBT Rent*, *Mobile Terminating*, *Voice Premium*). Every revenue record and every target belongs to one of these services.

> ⚠️ **Service names and codes matter — the import matches on them EXACTLY.** When you import an Excel file, each **sheet name** is matched to a service using strict exact matching only: the sheet name must equal a service **code**, a service **name**, or contain a whole word that is itself a service code. Partial or fuzzy matches are never guessed.
>
> Example: a sheet named **CRBT** will *not* be posted under *CRBT Rent* or *CRBT Tone Sales* — it will be flagged as unmatched so you can decide. If your workbook sheet is named **CRBT**, create a service named exactly **CRBT** (or with code **CRBT**) first, then import.

- Keep one service per product; use the code for stable machine-friendly matching.
- Names are what your team sees everywhere; codes are what the importer trusts.
- You can add or edit services any time — historical revenue stays attached to the service it was recorded under.

## Revenue Targets & Goal Cascading
Targets are set per **service per month** and are what the achievement percentages are measured against. Goal Cascading lets you break a bigger target down into smaller owned pieces so responsibility is clear.

1. **Add a target** — pick the service, the month and the amount (Revenue Targets → Add New Target).
2. **Allocate** — split the target across owners using Target Allocation when needed.
3. **Cascade** — use Goal Cascading to create child goals under a parent target.

## Revenue Data
Manual revenue entry and correction. Use it for single adjustments that do not justify a full Excel import — for example a late partner correction or a discovered billing fix.

- Add Revenue Entry: choose the service, amount, date and optional notes.
- Edit or remove entries later — every change is written to the Audit Trail.
- Bulk monthly data should go through Excel Import instead of manual entry.

## Excel Import (monthly partner revenue)
The main pipeline for partner revenue. One workbook, one sheet per VAS service.

1. **Prepare the workbook** — name each sheet exactly like the target VAS service (name or code). Sheets like \`Premium SMS MT\` or \`Voice_Premium\` match their services automatically.
2. **Upload** — Excel Import → choose the file (.xlsx / .xls / .csv, up to 10MB). A preview is generated — nothing is saved yet.
3. **Review the preview** — each sheet shows how many rows matched and to which service. Sheets that match no service are listed as unmatched with guidance — those rows are NOT imported.
4. **Confirm** — set the revenue month (optional override) and confirm. Valid rows are saved, the Dashboard caches refresh, and the batch appears in the import history.

> ℹ️ **How sheet names are matched (strict — no guessing).**
>
> - Exact match: sheet name = service name or service code (punctuation/spacing normalised, case-insensitive).
> - Exact word: any whole word of the sheet name that equals a service code — e.g. a sheet \`Voice_Export\` matches a service coded VOICE via the word "voice".
> - Everything else: unmatched. The preview shows the full list of your services so you can fix the sheet name or create the missing service.

> ⚠️ **Common pitfalls.**
>
> - A sheet named after a service that does not exist (yet) will be rejected — create the service first.
> - One workbook can carry several services; every sheet is handled independently.
> - Partner Name and Total Revenue columns are detected automatically; keep one partner per row.
> - Re-importing the same file twice creates duplicate revenue — check the import history first.

## Partner Revenue
The record-level view of imported and manual revenue: partner, service, month and amount. Use it to audit what an import actually saved, correct a partner name, or remove a wrong record.

- Filter by month, service or partner to isolate what you need.
- Edits here are logged to the Audit Trail with your name.

## Reports & Alerts
**Performance Reports** aggregate revenue vs targets by service and month — the standard pack for management reviews. **Revenue Alerts** raise threshold warnings (e.g. a service far behind its target) so problems surface before month-end.

- Reports respect the same month filter as the rest of the section.
- Alert rules are configurable; critical alerts also appear as notifications.

## Action Notes & AI Assistant
**Action Notes** track follow-ups ("call partner X about the August dip") with owners and status. The **VAS AI Assistant** answers questions about your data in plain language — try "which services missed their target last month?". **AI Usage Report** (admins) shows how much the team uses the assistant.

## Admin tools
- **Users** — create accounts and assign them to the VAS section.
- **Roles & Permissions** — a role grants page-level permissions; users inherit them. Permissions are the gate for every sidebar item.
- **Audit Trail** — who changed what, when. All imports, edits and deletions land here.
- **Categories** — configuration for service groupings used by reports.
`;

const IDC_GUIDE = `## Overview
The **Indirect Channel (IDC)** section is the register of the indirect-channel network and its trade: who the channel partners are, how they connect to each other, and the stock they hold. Entities are organised as a chain:

- Every entity belongs to a domain — IDC, Yimulu or Enterprise — and reports group them accordingly.
- Each entity gets an identifier code an operator can quote, e.g. \`IDC-R-0001\` for a retailer.
- A Sub-Distributor trades under a Distributor; a Retailer under a Sub-Distributor — the parent is chosen at registration.

## Channel Dashboard
The landing page for the section: how many entities exist per level and domain, recent registrations, and quick links into the registry and imports. Start here to see the health of the network at a glance.

## Entity Registry
The searchable register of every channel entity. What you can do inside depends on your permissions — viewing, editing and deleting are separate grants, and *own*-scoped variants let users manage only the entities they registered.

- Search and filter by level, domain, region or status.
- Open an entity to see its profile and its place in the chain (parent links).
- Edits and deletions are permission-gated and written to the Audit Trail.

## Batch Import (Excel)
Registers or updates many entities at once from one workbook. **Each level has its own sheet layout, and the layout identifies the level** — there is no Category column to fill in. Upload one, two or all three sheets together.

- **Distributor sheet** — Distributor Name, Mobile Number, Status, Region, Air Time Type.
- **Sub-Distributor sheet** — adds the parent Distributor Name / Region / Contact.
- **Retailer sheet** — adds Existing Business, Geographical Domain, Sub-Distributor link, and optional TIN / Location / National-Fayda ID.

1. **Download the template** — use the All Levels Template (or a single-level one) so the columns are right from the start.
2. **Fill the sheets** — column headings are matched loosely — common source spellings like "Distributer Region" still work.
3. **Upload and review** — the importer validates rows, flags duplicates and reconciles against the summary sheet before anything is saved.
4. **Confirm** — clean rows are registered; problem rows are listed with the reason so you can fix and re-upload just those.

> ℹ️ **Stock balance data.** The Batch Import page also carries the channel **stock balance** upload: the system validates it, flags duplicates, and reconciles it against the summary sheet the same way.

## Single Registration
Register one entity at a time through a form that mirrors the batch workbook columns for its level — useful for walk-in registrations and corrections without preparing a file.

- Pick the level first; the form shows exactly the fields that level needs.
- The parent (Distributor / Sub-Distributor) is picked from existing registered entities.
- Sub-Distributors have no territory or business of their own in the IDC model — the region they trade in identifies them.

## Channel Reports & Retailer Maps
**Channel Reports** show the register spread across the IDC / Yimulu / Enterprise domains, level by level — the chain view makes coverage gaps obvious. The **Retailer Maps** plot the retailer network on the two geographical maps for a visual density check.

- Filter by domain, region or level to focus the report.
- Registration correctness shows up here first — a retailer linked to the wrong sub-distributor is visible in the chain view.

## Users, Roles & Audit
- **Users** — channel-scope accounts (IDC Admin, channel staff).
- **Roles** — channel permissions are separate from VAS ones; the section admins manage their own.
- **Audit Trail** — every registration, edit and deletion in the channel register is recorded.
`;

function defaultGuide(section) {
  if (section === 'INDIRECT_CHANNEL') return IDC_GUIDE;
  return VAS_GUIDE;
}

module.exports = { defaultGuide, GUIDE_SECTIONS: ['VAS', 'INDIRECT_CHANNEL'] };
