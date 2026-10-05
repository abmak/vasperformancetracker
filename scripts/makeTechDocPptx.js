#!/usr/bin/env node
// makeTechDocPptx.js
// Builds "Technical-Documentation.pptx" — a clear, brief technical deck for the
// VAS Performance Tracker (Ethio Telecom Indirect Channel).
//
// Run from the repo root:  node scripts/makeTechDocPptx.js
// No new dependencies: pptxgenjs comes from backend/node_modules.
//
// NOTE: scripts/diagrams/*.svg use <foreignObject> and cannot render inside
// PowerPoint, so all diagrams here are drawn with native shapes/tables instead.

const path = require('path');
const PptxGenJS = require('../backend/node_modules/pptxgenjs');

const OUT = path.join(__dirname, '..', 'Technical-Documentation.pptx');

// ------------------------------------------------------------------ tokens
const C = {
  brand: '78BE20', brandDark: '55801A',
  ink: '1F2A37', mut: '6B7280', line: 'D9DEE6',
  pale: 'F1F6E8', paleBlue: 'EEF3FB', white: 'FFFFFF',
  dark: '17202A', box: 'F7F9F4', boxLine: 'C9D6B8',
  acc: '2563EB', rowAlt: 'F6F8F2',
};
const FONT = 'Segoe UI';
const W = 13.333, H = 7.5, MX = 0.6;

const pptx = new PptxGenJS();
pptx.defineLayout({ name: 'WIDE', width: W, height: H });
pptx.layout = 'WIDE';
pptx.author = 'VAS Performance Tracker';
pptx.company = 'Ethio Telecom';
pptx.subject = 'Technical Documentation';
pptx.title = 'VAS Performance Tracker — Technical Documentation';

let pageNo = 0;
function newSlide() { pageNo++; return pptx.addSlide(); }

function chrome(s, title, kicker) {
  s.background = { color: C.white };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.1, fill: { color: C.brand } });
  if (kicker) s.addText(kicker.toUpperCase(), { x: MX, y: 0.28, w: W - 2 * MX, h: 0.3, fontSize: 11, bold: true, color: C.brandDark, fontFace: FONT, charSpacing: 2 });
  s.addText(title, { x: MX, y: 0.55, w: W - 2 * MX, h: 0.7, fontSize: 27, bold: true, color: C.ink, fontFace: FONT });
  s.addShape(pptx.ShapeType.line, { x: MX, y: 1.34, w: W - 2 * MX, h: 0, line: { color: C.line, width: 1 } });
  s.addText('VAS Performance Tracker — Technical Documentation', { x: MX, y: H - 0.42, w: 7, h: 0.3, fontSize: 9, color: C.mut, fontFace: FONT });
  s.addText(String(pageNo), { x: W - 1.2, y: H - 0.42, w: 0.6, h: 0.3, fontSize: 10, color: C.mut, align: 'right', fontFace: FONT });
}

// items: string | { t, sub?, b? }
function bullets(s, items, o = {}) {
  const runs = items.map(it => {
    const x = typeof it === 'string' ? { t: it } : it;
    return {
      text: x.t,
      options: {
        bullet: x.sub ? { code: '2013', indent: 10 } : { code: '25AA', indent: 12 },
        indentLevel: x.sub ? 1 : 0,
        color: x.c || (x.sub ? C.mut : C.ink),
        bold: !!x.b,
        fontSize: x.sub ? 12.5 : (o.size || 14.5),
        breakLine: true,
        paraSpaceAfter: x.sub ? 4 : 9,
      },
    };
  });
  s.addText(runs, { x: o.x ?? MX, y: o.y ?? 1.62, w: o.w ?? (W - 2 * MX), h: o.h ?? (H - 2.1), fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.12 });
}

function box(s, { x, y, w, h, title, lines, fill = C.box, lineColor = C.boxLine, titleColor = C.ink, titleSize = 12.5, lineSize = 10.5, lineColorText = C.ink }) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: fill }, line: { color: lineColor, width: 1 }, rectRadius: 0.05 });
  const runs = [];
  if (title) runs.push({ text: title, options: { bold: true, fontSize: titleSize, color: titleColor, breakLine: true, paraSpaceAfter: 3 } });
  (lines || []).forEach(t => runs.push({ text: t, options: { fontSize: lineSize, color: lineColorText, breakLine: true, paraSpaceAfter: 2 } }));
  s.addText(runs, { x: x + 0.14, y: y + 0.08, w: w - 0.28, h: h - 0.16, fontFace: FONT, valign: 'top' });
}

function arrow(s, x1, y1, x2, y2, color = '94A3B8') {
  // PowerPoint rejects negative shape extents: normalize to a positive
  // bounding box and flip the line so the arrowhead still lands on (x2,y2).
  const flipH = x2 < x1, flipV = y2 < y1;
  s.addShape(pptx.ShapeType.line, {
    x: Math.min(x1, x2), y: Math.min(y1, y2),
    w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    flipH, flipV,
    line: { color, width: 1.75, endArrowType: 'triangle' },
  });
}

function vPipeline(s, x, w, steps, y0 = 1.62, boxH = 0.62, gap = 0.3) {
  steps.forEach((st, i) => {
    const y = y0 + i * (boxH + gap);
    box(s, { x, y, w, h: boxH, title: null, lines: Array.isArray(st) ? st : [st], fill: C.paleBlue, lineColor: 'C3D4EE', titleSize: 11.5, lineSize: 11 });
    if (i < steps.length - 1) arrow(s, x + w / 2, y + boxH, x + w / 2, y + boxH + gap);
  });
}

function table(s, header, rows, o) {
  const head = header.map(t => ({ text: t, options: { bold: true, color: C.white, fill: { color: C.brandDark }, fontSize: o.headSize || 12 } }));
  const body = rows.map((r, i) => r.map(c => ({
    text: c,
    options: { color: C.ink, fontSize: o.size || 12, fill: { color: i % 2 ? C.rowAlt : C.white } },
  })));
  s.addTable([head, ...body], {
    x: o.x, y: o.y, w: o.w, colW: o.colW, rowH: o.rowH || 0.42,
    border: { type: 'solid', color: C.line, pt: 0.5 },
    fontFace: FONT, valign: 'middle', margin: 0.06, autoPage: false,
  });
}

// ============================================================ 1 · TITLE
{
  const s = newSlide();
  s.background = { color: C.dark };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.22, h: H, fill: { color: C.brand } });
  s.addText('ETHIO TELECOM — INDIRECT CHANNEL', { x: 0.95, y: 2.0, w: 11, h: 0.4, fontSize: 13, bold: true, color: C.brand, charSpacing: 3, fontFace: FONT });
  s.addText('VAS Performance Tracker', { x: 0.9, y: 2.42, w: 11.6, h: 1.0, fontSize: 44, bold: true, color: C.white, fontFace: FONT });
  s.addText('Technical Documentation', { x: 0.95, y: 3.5, w: 11, h: 0.6, fontSize: 24, color: 'AEB8C4', fontFace: FONT });
  s.addText('Architecture · Business modules · Security · Infrastructure · Operations', { x: 0.95, y: 4.32, w: 11, h: 0.4, fontSize: 14, color: '7C8894', fontFace: FONT });
  s.addText('October 2026 · v1.0', { x: 0.95, y: 6.55, w: 6, h: 0.35, fontSize: 11, color: '7C8894', fontFace: FONT });
}

// ============================================================ 2 · OVERVIEW
{
  const s = newSlide();
  chrome(s, 'What the system does', 'Overview');
  bullets(s, [
    'One internal web app for two businesses:',
    { t: 'VAS Revenue — services, targets vs actual revenue (Excel imports), dashboards, reports, alerts and follow-up actions.', sub: true },
    { t: 'Indirect Channel — retailer / distributor registry, stock balances, TIN verification, GPS capture and maps, imports and reports.', sub: true },
    'Collaboration built in: direct & group chat, notifications, SMS log, and an AI assistant (Google Gemini).',
    'Single public entry point: https://196.189.155.179:5000 (trusted certificate) — one Node process serves the API and the web app.',
    'Scale: 28 screens, 26 API route modules, one MySQL database, two user sections with shared login.',
  ]);
}

// ============================================================ 2b · PROBLEM & VALUE
{
  const s = newSlide();
  chrome(s, 'The problem it solves & the value it delivers', 'Overview');
  s.addText('BEFORE \u2014 THE PROBLEM', { x: MX, y: 1.56, w: 6, h: 0.3, fontSize: 10.5, bold: true, color: C.mut, charSpacing: 2, fontFace: FONT });
  bullets(s, [
    'Revenue scattered across Excel files \u2014 no single, current view of VAS performance against target.',
    'Service renames and spelling variants silently hid revenue from reports.',
    'Retailer data incomplete: no GPS, no verified addresses, TIN checks done by phone.',
    'Follow-ups (alerts, actions, escalations) tracked in chat and notebooks \u2014 invisible to management.',
    'Access uncontrolled: anyone holding a file sees everything; no record of who changed what.',
  ], { x: MX, y: 1.92, w: 5.95, size: 12.5 });
  s.addShape(pptx.ShapeType.line, { x: 6.78, y: 1.62, w: 0, h: 4.95, line: { color: C.line, width: 1 } });
  s.addText('AFTER \u2014 THE BENEFIT', { x: 7.0, y: 1.56, w: 6, h: 0.3, fontSize: 10.5, bold: true, color: C.brandDark, charSpacing: 2, fontFace: FONT });
  bullets(s, [
    'One live source of truth: targets, actuals, achievement and trends for every VAS service.',
    'Code-first import matching \u2014 renamed services can no longer orphan revenue; unmatched rows are visible, never silent.',
    'Complete channel registry with GPS coordinates, reverse-geocoded addresses and map drill-down per area.',
    'Built-in follow-up loop: alerts \u2192 feedback \u2192 action notes & tasks \u2192 goal cascade \u2014 all auditable.',
    'Role-based access, per-section confinement and a full audit trail on every sensitive change.',
  ], { x: 7.0, y: 1.92, w: 5.73, size: 12.5 });
}

// ============================================================ 3 · STACK
{
  const s = newSlide();
  chrome(s, 'Technology stack', 'Platform');
  table(s, ['Layer', 'Technology', 'Notes'], [
    ['Frontend', 'React 19 · Vite 5 · Tailwind CSS v4 · Recharts', 'SPA built to frontend/dist and served by the API server; react-router 7 with guards'],
    ['Backend', 'Node.js + Express 4 (CommonJS)', '26 route modules; logic lives in routes/*.js; raw SQL — no ORM'],
    ['Database', 'MySQL 8 (prod) · MariaDB 10.4 (dev, XAMPP)', 'mysql2 connection pool; schema created by idempotent setup scripts'],
    ['Auth & security', 'jsonwebtoken · bcryptjs · slider puzzle captcha', 'DB-backed permissions re-resolved on every request'],
    ['Documents & data', 'pptxgenjs · pdfkit · xlsx', 'PPTX / PDF report exports; Excel import pipeline'],
    ['AI', '@google/generative-ai (Gemini)', 'In-app assistant with usage tracking and daily quotas'],
    ['Runtime', 'pm2 · nginx (edge 80/443) · Node TLS proxy', 'One API process behind a TLS terminator on port 5000'],
  ], { x: MX, y: 1.62, w: W - 2 * MX, colW: [2.0, 4.4, 5.73], rowH: 0.56 });
}

// ============================================================ 3b · WHY THIS STACK
{
  const s = newSlide();
  chrome(s, 'Why this technology was chosen', 'Platform');
  table(s, ['Layer', 'Why it was selected', 'What it gives us'], [
    ['React 19\n(frontend)', 'Component model fits a 28-screen, widget-heavy UI; the largest ecosystem; the team already works in JavaScript.', 'Reusable widgets (maps, GPS capture, captcha); fast, consistent screens.'],
    ['Vite 5\n(frontend)', 'Instant dev server and hot reload; zero-config /api proxy; the fastest build tooling available.', 'Same relative-path code in dev and production \u2014 no environment drift.'],
    ['Tailwind v4\n(frontend)', 'Utility classes keep styles next to markup; theming via CSS variables; no class-naming overhead.', 'One design language; tiny production CSS bundle.'],
    ['Node.js + Express\n(backend)', 'One language end to end; Express is minimal and battle-tested and imposes no heavy structure.', 'Explicit business logic in route modules; one process to deploy and monitor.'],
    ['MySQL / MariaDB\n(data)', 'Relational integrity for money and registry data; mature admin tooling; team familiarity.', 'Reliable joins and aggregates for reports; nightly dumps; no license cost.'],
    ['JWT + bcrypt + captcha\n(security)', 'Industry-standard building blocks instead of custom schemes: bcrypt hashing, signed tokens, human-verification gate at login.', 'No plaintext secrets; bot and brute-force resistance; instant permission revocation via DB re-check.'],
  ], { x: MX, y: 1.58, w: W - 2 * MX, colW: [2.35, 5.55, 4.23], rowH: 0.76, size: 10.5, headSize: 12 });
  s.addText('Deliberately NOT chosen: heavyweight frameworks (NestJS, Django) and ORMs \u2014 a single-VPS deployment favors few moving parts and full SQL control for revenue math.', { x: MX, y: 6.62, w: W - 2 * MX, h: 0.4, fontSize: 11, italic: true, color: C.mut, fontFace: FONT });
}

// ============================================================ 4 · TOPOLOGY
{
  const s = newSlide();
  chrome(s, 'System topology (production)', 'Architecture');
  box(s, { x: MX, y: 1.55, w: W - 2 * MX, h: 0.52, title: null, lines: ['nginx — ports 80 / 443  →  302 redirect to https://196.189.155.179:5000'], fill: C.paleBlue, lineColor: 'C3D4EE', lineSize: 12 });
  arrow(s, 4.55, 2.1, 4.55, 2.52);

  const y = 2.55, h = 1.15;
  box(s, { x: 0.6, y, w: 2.1, h, title: 'Browser — React SPA', lines: ['loads frontend/dist', 'calls /api/* same-origin'], fill: C.pale, lineSize: 10 });
  arrow(s, 2.7, y + h / 2, 3.3, y + h / 2);
  box(s, { x: 3.3, y, w: 2.5, h, title: 'vas-https  (pm2)', lines: ['Node TLS terminator', '0.0.0.0:5000 · TLS 1.3', 'trusted LE certificate'], fill: C.pale, lineSize: 10 });
  arrow(s, 5.8, y + h / 2, 6.4, y + h / 2);
  box(s, { x: 6.4, y, w: 2.5, h, title: 'perf-tracking-api (pm2)', lines: ['Express — API + SPA static', 'listens 127.0.0.1:5001'], fill: C.pale, lineSize: 10 });
  arrow(s, 8.9, y + h / 2, 9.5, y + h / 2);
  box(s, { x: 9.5, y, w: 2.4, h, title: 'MySQL 8', lines: ['schema vas_revenue_tracking', 'loopback :3306 only'], fill: C.pale, lineSize: 10 });

  arrow(s, 7.65, y + h, 6.9, 4.3);
  arrow(s, 7.65, y + h, 9.7, 4.3);
  box(s, { x: 5.0, y: 4.32, w: 3.3, h: 0.62, title: null, lines: ['frontend/dist — built SPA (deep links)'], lineSize: 10 });
  box(s, { x: 8.6, y: 4.32, w: 3.3, h: 0.62, title: null, lines: ['backend/uploads/chat — media files'], lineSize: 10 });

  s.addText('SIDECAR SERVICES', { x: MX, y: 5.25, w: 5, h: 0.3, fontSize: 10.5, bold: true, color: C.mut, fontFace: FONT, charSpacing: 2 });
  box(s, { x: 0.6, y: 5.58, w: 3.85, h: 0.85, title: 'Google Gemini API', lines: ['AI assistant — outbound HTTPS'], lineSize: 10 });
  box(s, { x: 4.74, y: 5.58, w: 3.85, h: 0.85, title: 'eTrade host', lines: ['TIN verification — outbound HTTPS'], lineSize: 10 });
  box(s, { x: 8.88, y: 5.58, w: 3.85, h: 0.85, title: 'phpMyAdmin', lines: ['127.0.0.1:8081 — SSH tunnel only'], lineSize: 10 });

  s.addText('VPS has no outbound internet — deployments and certificate renewals are driven from the office PC.', { x: MX, y: 6.68, w: W - 2 * MX, h: 0.35, fontSize: 11, italic: true, color: C.mut, fontFace: FONT });
}

// ============================================================ 5 · BACKEND
{
  const s = newSlide();
  chrome(s, 'Backend at a glance', 'Architecture');
  bullets(s, [
    'Entry point backend/src/server.js — middleware chain, 26 route modules, static SPA fallback, error handler.',
    'Business logic lives directly in routes/*.js — no controllers or models layer.',
    'Every protected call: JWT verify → user re-read from DB → effective role permissions → per-endpoint allow-list check.',
    'Authorization is live: role or status changes apply on the next request, not at next login.',
    'Heavy report/dashboard endpoints cached in memory; partner aggregates pre-warmed at boot.',
    'Route files self-heal their tables at boot (ensureTable pattern).',
  ], { w: 6.2 });
  vPipeline(s, 7.1, 5.6, [
    'HTTP request — JSON, 10 MB limit, CORS',
    'authenticate — JWT → DB-backed user + permissions',
    "requirePermission('module','action') allow-list",
    'route handler — raw SQL via mysql2 pool',
    'central error handler — clean JSON responses',
  ]);
}

// ============================================================ 6 · FRONTEND
{
  const s = newSlide();
  chrome(s, 'Frontend at a glance', 'Architecture');
  bullets(s, [
    'Single React 19 SPA — served by the same Node process in production; Vite dev server proxies /api locally.',
    'Typed API client (services/api.js) — one request() helper attaches the Bearer token to every call.',
    'AuthContext holds session + section swap; DateFilterContext feeds one global date range to all reports.',
    'Route guards: ProtectedRoute · SuperAdminScope · SectionGuard (VAS vs Channel) · PublicRoute.',
    'Shared widgets: Layout shell, PuzzleCaptcha, ColumnPicker, GPS capture, maps.',
  ], { w: 6.2 });
  table(s, ['Area', 'Screens'], [
    ['VAS analytics', 'Dashboard · Targets · Revenue · Import · Reports · Partner Revenue · Services · Categories · Alerts'],
    ['Follow-up', 'Action Notes · Goal Cascade'],
    ['Admin', 'Users · Roles · Permissions · Audit Trail'],
    ['Indirect Channel', 'Dashboard · Batch Import · Single Registration · Reports (maps & GPS)'],
    ['Collaboration', 'Chat · Messages · Notifications · AI Assistant'],
  ], { x: 7.0, y: 1.62, w: 5.73, colW: [1.65, 4.08], rowH: 0.78, size: 11, headSize: 11.5 });
}

// ============================================================ 7 · SECURITY
{
  const s = newSlide();
  chrome(s, 'Security & access control', 'Platform');
  bullets(s, [
    'Login gated by a slider puzzle captcha — HMAC-signed challenge, 3-minute TTL, single-use, rate-limited 30/min per IP.',
    'Passwords bcrypt-hashed; JWT Bearer token on every API call.',
    'Permissions re-resolved from the DB on every request — deactivations and role edits take effect immediately.',
    'RBAC: roles scoped GLOBAL / MULTI_SECTION / single; users with several sections pick one after login (section swap).',
    'Section confinement on both layers: UI SectionGuard + backend sectionScope.',
    'Sensitive actions recorded in audit_trail; the audit viewer is section-filtered.',
    'Database hardening: MySQL binds to loopback only, phpMyAdmin reachable through SSH tunnel only, nightly backups.',
  ]);
}

// ============================================================ 7b · SECURITY DEEP DIVE
{
  const s = newSlide();
  chrome(s, 'Security deep dive \u2014 layered defenses', 'Platform');
  box(s, { x: MX, y: 1.62, w: 6.0, h: 2.3, title: 'Identity & login', titleColor: C.brandDark, lines: [
    'Slider puzzle captcha gates every login \u2014 HMAC-signed, single-use, 3-minute TTL, 30 attempts/min/IP',
    'Passwords bcrypt-hashed; JWT Bearer token on every API call',
    'Multi-section users choose a section after login \u2014 the token carries role + section',
  ] });
  box(s, { x: 6.85, y: 1.62, w: 5.88, h: 2.3, title: 'Authorization', titleColor: C.brandDark, lines: [
    'RBAC: roles hold permissions, scoped GLOBAL / MULTI_SECTION / single-section',
    'Permissions re-resolved from the DB on every request \u2014 revocation is instant',
    'Allow-list per endpoint: requirePermission / requireAllPermissions',
    'Section confinement on both layers: SectionGuard (UI) + sectionScope (API)',
  ] });
  box(s, { x: MX, y: 4.12, w: 6.0, h: 2.3, title: 'Application & transport', titleColor: C.brandDark, lines: [
    'TLS 1.3 on the public entry with a trusted, automatically renewed certificate',
    'Restricted CORS; 10 MB body limit; central error handler \u2014 no stack traces leak',
    'Chat media stored under unguessable names and served as static assets',
  ] });
  box(s, { x: 6.85, y: 4.12, w: 5.88, h: 2.3, title: 'Data & infrastructure', titleColor: C.brandDark, lines: [
    'MySQL binds to 127.0.0.1 only; port 3306 filtered from the internet (verified)',
    'phpMyAdmin loopback-only via SSH tunnel; per-person revocable tunnel keys',
    'Nightly mysqldump at 02:15 with 14-day rotation',
    'audit_trail records user + timestamp for every sensitive write',
  ] });
}

// ============================================================ 8 · VAS MODULE
{
  const s = newSlide();
  chrome(s, 'VAS revenue module', 'Business modules');
  bullets(s, [
    'Catalog: VAS services with types and categories — the anchor for everything revenue.',
    'Targets: monthly allocations per service (revenue_target_allocations) computed by the target calculator.',
    'Actuals: Excel import with preview → confirm; every batch tracked; rows land in partner_revenue.',
    { t: 'Matching rule is code-first: rows are matched to a service by its VAS service code; full-name and fuzzy matching only as fallback; anything unmatched stays out of the numbers — no silent renaming.', b: true },
    'Views: KPI dashboard, service achievement, category breakdown, month-over-month growth.',
    'Follow-up loop: achievement alerts + feedback, action notes & tasks, goal cascade, SMS log.',
  ], { w: 6.5 });
  s.addText('IMPORT PIPELINE', { x: 7.5, y: 1.62, w: 5, h: 0.3, fontSize: 10.5, bold: true, color: C.mut, fontFace: FONT, charSpacing: 2 });
  vPipeline(s, 7.5, 5.2, [
    'Excel sheet uploaded',
    'Preview & validation',
    'Match to VAS service — code-first',
    'Confirm → partner_revenue + import batch',
  ], 1.98, 0.68, 0.34);
}

// ============================================================ 9 · CHANNEL MODULE
{
  const s = newSlide();
  chrome(s, 'Indirect Channel module', 'Business modules');
  bullets(s, [
    'Registry: retailers & distributors keyed by mobile number, organized by domain and category with alias normalization.',
    'TIN verification against the external eTrade service; manager photos linked by TIN.',
    'Stock balances and summary per category / level.',
    'Imports: batch Excel import with row-level error report, plus a guided single registration form.',
    'GPS capture: shared LocationCapture widget records coordinates + reverse-geocoded address on registration and edits (fills empty address fields, tracks user changes).',
    'Maps: AreaMap (one bubble per Geographical Domain) and GPS map (retailer points); clicking a bubble drills down to that area\u2019s retailers on the GPS map.',
  ], { w: 6.5 });
  s.addText('LOCATION DATA FLOW', { x: 7.5, y: 1.62, w: 5, h: 0.3, fontSize: 10.5, bold: true, color: C.mut, fontFace: FONT, charSpacing: 2 });
  vPipeline(s, 7.5, 5.2, [
    'LocationCapture — browser GPS + reverse geocode',
    'lat/lng + address saved with the entity',
    'AreaMap bubbles / GPS retailer points',
    'Drill-down: area → filtered retailer map',
  ], 1.98, 0.68, 0.34);
}

// ============================================================ 9b · HOW IT WORKS
{
  const s = newSlide();
  chrome(s, 'How the system works \u2014 end to end', 'Architecture');
  bullets(s, [
    'Login: the user solves a slider puzzle captcha; the bcrypt hash is verified and a JWT with role + section is issued.',
    'Every screen calls the typed API client; each request is re-authorized against live DB permissions.',
    'VAS flow: monthly targets set per service \u2192 Excel actuals imported \u2192 code-first matching \u2192 dashboards show achievement, gaps and trends.',
    'Channel flow: entities registered or updated (GPS capture + TIN verification) \u2192 stock imported \u2192 maps and reports expose coverage.',
    'Follow-up: alerts fire on under-achievement \u2192 feedback and action notes \u2192 tasks tracked to closure.',
    'Share-out: any report exports to PPTX or PDF in one click; the AI assistant answers questions over the same data.',
  ], { w: 6.5 });
  s.addText('FROM DATA TO DECISION', { x: 7.5, y: 1.62, w: 5, h: 0.3, fontSize: 10.5, bold: true, color: C.mut, fontFace: FONT, charSpacing: 2 });
  vPipeline(s, 7.5, 5.2, [
    'Excel uploads & registrations',
    'Validated, matched, stored in MySQL',
    'Live dashboards & reports',
    'Alerts \u2192 actions \u2192 tasks',
    'Share-out: PPTX \u00b7 PDF \u00b7 SMS',
  ], 1.98, 0.62, 0.32);
}

// ============================================================ 10 · DATA MODEL
{
  const s = newSlide();
  chrome(s, 'Data model — key table groups', 'Architecture');
  box(s, { x: MX, y: 1.62, w: 6.0, h: 2.2, title: 'Identity & access', lines: ['users · roles · permissions · role_permissions', 'user_sections · role_section_access', 'audit_trail — every sensitive write'], titleColor: C.brandDark });
  box(s, { x: 6.85, y: 1.62, w: 5.88, h: 2.2, title: 'Revenue', lines: ['vas_services · vas_service_types · vas_categories', 'revenue_targets · revenue_target_allocations', 'partner_revenue · import_batches · kpi_snapshots'], titleColor: C.brandDark });
  box(s, { x: MX, y: 4.05, w: 6.0, h: 2.2, title: 'Indirect Channel', lines: ['channel_entities (keyed by mobile)', 'channel_domains / categories / aliases', 'stock balances & summary', 'import batches / rows / errors', 'channel_manager_photos (keyed by TIN)'], titleColor: C.brandDark });
  box(s, { x: 6.85, y: 4.05, w: 5.88, h: 2.2, title: 'Collaboration', lines: ['chat messages · groups · members', 'notifications · sms_messages', 'ai_usage (Gemini quotas)', 'alert_feedback'], titleColor: C.brandDark });
  s.addText('Schema is created by idempotent scripts (npm run db:*) — safe to re-run; several tables self-heal at boot.', { x: MX, y: 6.5, w: W - 2 * MX, h: 0.35, fontSize: 11, italic: true, color: C.mut, fontFace: FONT });
}

// ============================================================ 11 · INFRASTRUCTURE
{
  const s = newSlide();
  chrome(s, 'Production infrastructure', 'Operations');
  table(s, ['pm2 process', 'Port', 'Role'], [
    ['vas-https', '0.0.0.0:5000', 'Node TLS terminator — public entry with trusted Let\u2019s Encrypt certificate'],
    ['perf-tracking-api', '127.0.0.1:5001', 'Express — API and built SPA (env-driven PORT)'],
    ['phpmyadmin', '127.0.0.1:8081', 'DB admin UI — loopback only, reached via SSH tunnel'],
    ['jobsethiopia-api · liblelib', '—', 'Unrelated sites sharing the same host'],
  ], { x: MX, y: 1.62, w: W - 2 * MX, colW: [2.9, 2.0, 7.23], rowH: 0.52 });
  bullets(s, [
    'Host: Ubuntu VPS 196.189.155.179 — application at /var/www/performancetracking/app.',
    'nginx owns ports 80/443 and 302-redirects bare-IP traffic to the app URL.',
    'No outbound internet on the VPS: deploys go over scp; ACME renewals are driven from the office PC.',
    'Health probe: GET /api/health → { status: "ok" }.',
  ], { y: 4.6 });
}

// ============================================================ 12 · TLS
{
  const s = newSlide();
  chrome(s, 'TLS certificate & automatic renewal', 'Operations');
  bullets(s, [
    'Public URL https://196.189.155.179:5000 presents a browser-trusted Let\u2019s Encrypt certificate (SAN = the IP) — no self-signed warnings.',
    'Let\u2019s Encrypt issues IP certificates only in the short-lived profile (~6.5 days) — automated renewal is mandatory.',
    { t: 'Renewal flow (scripts/le/renew.js, runs on the office PC):', b: true },
    { t: 'ACME order → HTTP-01 challenge file pushed to the VPS → Let\u2019s Encrypt validates via port 80 → certificate + key installed to ~/vas-tls → pm2 restart vas-https.', sub: true },
    'Windows Task Scheduler runs it daily at 08:00; skips when the installed certificate still has more than 4 days left.',
    'Safe dry-runs with --staging; activity logged to scripts/le/renew.log; docs in scripts/le/README.md.',
    'nginx forwards the ACME challenge path to the app, so validation keeps working without manual steps.',
  ]);
}

// ============================================================ 13 · OPS
{
  const s = newSlide();
  chrome(s, 'Operations & reliability', 'Operations');
  bullets(s, [
    'Backups: nightly mysqldump at 02:15 → ~/backups/vas-YYYY-MM-DD.sql.gz, 14-day rotation, passwordless via ~/.my.cnf (dump verified).',
    'Deploys: vite build → tar frontend/dist → scp → swap + pm2 restart; backend files deployed individually.',
    'Schema changes: idempotent setup scripts (npm run db:*) safe to re-run; route files self-heal missing tables at boot.',
    'Performance: in-memory endpoint caches, pre-warmed partner aggregates, indexes on hot tables.',
    'Dev parity: local XAMPP MariaDB mirrors the production schema; localhost is a secure context, so GPS capture works in development.',
  ], { w: 6.6 });
  s.addText('DEPLOY CHECKLIST', { x: 7.5, y: 1.62, w: 5, h: 0.3, fontSize: 10.5, bold: true, color: C.mut, fontFace: FONT, charSpacing: 2 });
  vPipeline(s, 7.5, 5.2, [
    'npx vite build (frontend)',
    'tar + scp to the VPS',
    'Swap dist / backend files',
    'pm2 restart (no env override)',
    'GET /api/health check',
  ], 1.98, 0.6, 0.28);
}

// ============================================================ 13b · BENEFIT SUMMARY
{
  const s = newSlide();
  chrome(s, 'Service benefits at a glance', 'Value');
  table(s, ['Area', 'Benefit'], [
    ['Revenue visibility', 'Targets vs actuals live per service, category and month \u2014 decisions come from data, not from collected files.'],
    ['Data quality', 'Code-first imports end the silent revenue loss caused by renamed services; every unmatched row is surfaced and reviewed.'],
    ['Field operations', 'GPS-verified retailer registry with area drill-down \u2014 coverage gaps are visible on a map, not in a spreadsheet.'],
    ['Accountability', 'Every change is attributed in the audit trail; alerts and tasks close the loop from problem to resolution.'],
    ['Collaboration', 'Chat, notifications, SMS log and the AI assistant live in the same app \u2014 fewer tools for the team to learn.'],
    ['Cost & simplicity', 'Open-source stack on one VPS \u2014 no per-user license fees, one process to run, monitor and back up.'],
  ], { x: MX, y: 1.62, w: W - 2 * MX, colW: [2.5, 9.63], rowH: 0.64, size: 12.5 });
}

// ============================================================ 14 · GAPS
{
  const s = newSlide();
  chrome(s, 'Known gaps & next steps', 'Roadmap');
  bullets(s, [
    { t: 'Inactive VAS services (IVR, National Lottery, Voice Premium, Mobile Originating) hide ~30M ETB of partner revenue from views — decide: reactivate or archive.', b: true },
    'Historical name-variant rows (e.g. CRBT spellings) stay unmatched by design — candidate for a one-time data cleanup.',
    'No automated test suite yet — the import matching rules already have prototyped unit cases worth keeping.',
    'Hardening backlog: dedicated least-privilege phpMyAdmin user, SSH password-auth off + fail2ban, ufw rules.',
    'Longer term: a domain name + nginx TLS termination would allow standard 90-day certificates and simpler infra.',
  ]);
}

// ============================================================ 15 · CLOSING
{
  const s = newSlide();
  s.background = { color: C.dark };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.22, h: H, fill: { color: C.brand } });
  s.addText('Thank you', { x: 0.95, y: 1.7, w: 11, h: 0.9, fontSize: 40, bold: true, color: C.white, fontFace: FONT });
  s.addText('VAS Performance Tracker — one app for VAS revenue performance and the Indirect Channel.', { x: 0.95, y: 2.7, w: 11, h: 0.4, fontSize: 14, color: 'AEB8C4', fontFace: FONT });
  s.addText('REFERENCE DOCS IN THE REPOSITORY', { x: 0.95, y: 3.9, w: 11, h: 0.35, fontSize: 11, bold: true, color: C.brand, charSpacing: 2, fontFace: FONT });
  s.addText([
    { text: 'scripts/ARCHITECTURE.md — full architecture walkthrough', options: { breakLine: true, paraSpaceAfter: 6 } },
    { text: 'scripts/DATABASE-SECURITY.md — DB access & security runbook', options: { breakLine: true, paraSpaceAfter: 6 } },
    { text: 'scripts/le/README.md — TLS certificate renewal system', options: { breakLine: true } },
  ], { x: 0.95, y: 4.3, w: 11, h: 1.2, fontSize: 13, color: 'C6CEDA', fontFace: FONT });
  s.addText('Regenerate this deck anytime:  node scripts/makeTechDocPptx.js', { x: 0.95, y: 6.55, w: 11, h: 0.35, fontSize: 11, color: '7C8894', fontFace: FONT });
}

// ------------------------------------------------------------------ write
pptx.writeFile({ fileName: OUT }).then(() => {
  console.log('Written:', OUT);
});
