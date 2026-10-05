#!/usr/bin/env node
// makeArchTechDoc.js
// Builds "System-Architecture-Technical-Documentation.pptx" — a technical
// document that shows the FULL SYSTEM ARCHITECTURE and its detailed design.
//
// Run from the repo root:  node scripts/makeArchTechDoc.js
// Reuses pptxgenjs from backend/node_modules (already a project dependency).
//
// NOTE: scripts/diagrams/*.svg use <foreignObject> and cannot render inside
// PowerPoint, so every diagram here is drawn with native shapes/tables.

const path = require('path');
const PptxGenJS = require('../backend/node_modules/pptxgenjs');

const OUT = path.join(__dirname, '..', 'System-Architecture-Technical-Documentation.pptx');

// ------------------------------------------------------------------ tokens
const C = {
  brand: '78BE20', brandDark: '55801A',
  ink: '1F2A37', mut: '6B7280', line: 'D9DEE6',
  pale: 'F1F6E8', paleBlue: 'EEF3FB', white: 'FFFFFF',
  dark: '17202A', box: 'F7F9F4', boxLine: 'C9D6B8',
  acc: '2563EB', rowAlt: 'F6F8F2', paleAmber: 'FBF6E8',
};
const FONT = 'Segoe UI';
const MONO = 'Consolas';
const W = 13.333, H = 7.5, MX = 0.6;

const pptx = new PptxGenJS();
pptx.defineLayout({ name: 'WIDE', width: W, height: H });
pptx.layout = 'WIDE';
pptx.author = 'VAS Performance Tracker';
pptx.company = 'Ethio Telecom';
pptx.subject = 'System Architecture — Technical Documentation';
pptx.title = 'VAS Performance Tracker — System Architecture';

let pageNo = 0;
function newSlide() { pageNo++; return pptx.addSlide(); }

function chrome(s, title, kicker) {
  s.background = { color: C.white };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.1, fill: { color: C.brand } });
  if (kicker) s.addText(kicker.toUpperCase(), { x: MX, y: 0.28, w: W - 2 * MX, h: 0.3, fontSize: 11, bold: true, color: C.brandDark, fontFace: FONT, charSpacing: 2 });
  s.addText(title, { x: MX, y: 0.55, w: W - 2 * MX, h: 0.7, fontSize: 26, bold: true, color: C.ink, fontFace: FONT });
  s.addShape(pptx.ShapeType.line, { x: MX, y: 1.34, w: W - 2 * MX, h: 0, line: { color: C.line, width: 1 } });
  s.addText('VAS Performance Tracker — System Architecture', { x: MX, y: H - 0.42, w: 7, h: 0.3, fontSize: 9, color: C.mut, fontFace: FONT });
  s.addText(String(pageNo), { x: W - 1.2, y: H - 0.42, w: 0.6, h: 0.3, fontSize: 10, color: C.mut, align: 'right', fontFace: FONT });
}

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
        fontSize: x.sub ? 12 : (o.size || 14),
        breakLine: true,
        paraSpaceAfter: x.sub ? 4 : 8,
      },
    };
  });
  s.addText(runs, { x: o.x ?? MX, y: o.y ?? 1.58, w: o.w ?? (W - 2 * MX), h: o.h ?? (H - 2.05), fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.1 });
}

function box(s, { x, y, w, h, title, lines, fill = C.box, lineColor = C.boxLine, titleColor = C.ink, titleSize = 12.5, lineSize = 10.5, lineColorText = C.ink, mono = false }) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: fill }, line: { color: lineColor, width: 1 }, rectRadius: 0.05 });
  const runs = [];
  if (title) runs.push({ text: title, options: { bold: true, fontSize: titleSize, color: titleColor, breakLine: true, paraSpaceAfter: 3 } });
  (lines || []).forEach(t => runs.push({ text: t, options: { fontSize: lineSize, color: lineColorText, breakLine: true, paraSpaceAfter: 2, fontFace: mono ? MONO : FONT } }));
  s.addText(runs, { x: x + 0.14, y: y + 0.08, w: w - 0.28, h: h - 0.16, fontFace: mono ? MONO : FONT, valign: 'top' });
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

function vPipeline(s, x, w, steps, y0 = 1.62, boxH = 0.62, gap = 0.3, size = 11) {
  steps.forEach((st, i) => {
    const y = y0 + i * (boxH + gap);
    box(s, { x, y, w, h: boxH, title: null, lines: Array.isArray(st) ? st : [st], fill: C.paleBlue, lineColor: 'C3D4EE', lineSize: size });
    if (i < steps.length - 1) arrow(s, x + w / 2, y + boxH, x + w / 2, y + boxH + gap);
  });
}

function table(s, header, rows, o) {
  const head = header.map(t => ({ text: t, options: { bold: true, color: C.white, fill: { color: C.brandDark }, fontSize: o.headSize || 11.5 } }));
  const body = rows.map((r, i) => r.map(c => ({
    text: c,
    options: { color: C.ink, fontSize: o.size || 10.5, fill: { color: i % 2 ? C.rowAlt : C.white } },
  })));
  s.addTable([head, ...body], {
    x: o.x, y: o.y, w: o.w, colW: o.colW, rowH: o.rowH || 0.36,
    border: { type: 'solid', color: C.line, pt: 0.5 },
    fontFace: FONT, valign: 'middle', margin: 0.05, autoPage: false,
  });
}

// ============================================================ 1 · TITLE
{
  const s = newSlide();
  s.background = { color: C.dark };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.22, h: H, fill: { color: C.brand } });
  s.addText('ETHIO TELECOM — INDIRECT CHANNEL', { x: 0.95, y: 1.85, w: 11.5, h: 0.4, fontSize: 13, bold: true, color: C.brand, charSpacing: 3, fontFace: FONT });
  s.addText('VAS Performance Tracker', { x: 0.9, y: 2.27, w: 11.8, h: 1.0, fontSize: 42, bold: true, color: C.white, fontFace: FONT });
  s.addText('System Architecture — Technical Document', { x: 0.95, y: 3.35, w: 11.5, h: 0.6, fontSize: 22, color: 'AEB8C4', fontFace: FONT });
  s.addText('Topology · Backend & frontend design · Request lifecycle · Security · Data model · Deployment', { x: 0.95, y: 4.15, w: 11.6, h: 0.4, fontSize: 13, color: '7C8894', fontFace: FONT });
  s.addText('October 2026 · v1.0', { x: 0.95, y: 6.55, w: 6, h: 0.35, fontSize: 11, color: '7C8894', fontFace: FONT });
}

// ============================================================ 2 · DESIGN PRINCIPLES
{
  const s = newSlide();
  chrome(s, 'Architecture at a glance & design principles', 'Overview');
  bullets(s, [
    'Single-repo monorepo: backend/ (Node.js + Express + MySQL) and frontend/ (React 19 + Vite + Tailwind), one product.',
    { t: 'One process, one port: in production a single Node process serves both the REST API (/api/*) and the built SPA, with a catch-all fallback to index.html for deep links.', b: true },
    'No ORM, no controllers layer: business logic and raw SQL live directly in 26 route modules (routes/*.js) over one shared mysql2 pool.',
    'Authorization is live: every request re-reads the user and re-resolves permissions from the database, so role changes and deactivations apply immediately.',
    'Self-healing schema: idempotent setup scripts (npm run db:*) plus ensureTable() boot hooks keep tables present and safe to re-run.',
    'One VPS, few moving parts: nginx at the edge, a Node TLS terminator on the public port, Express behind it, MySQL bound to loopback only.',
    'Two business domains in one app — VAS Revenue and the Indirect Channel — isolated by section controls on both UI and API.',
  ]);
}

// ============================================================ 3 · TOPOLOGY
{
  const s = newSlide();
  chrome(s, 'System topology (production)', 'Architecture');
  box(s, { x: MX, y: 1.5, w: W - 2 * MX, h: 0.48, title: null, lines: ['nginx — ports 80 / 443  →  302 redirect to https://196.189.155.179:5000'], fill: C.paleBlue, lineColor: 'C3D4EE', lineSize: 12 });
  arrow(s, 4.55, 2.0, 4.55, 2.4);

  const y = 2.42, h = 1.12;
  box(s, { x: 0.6, y, w: 2.1, h, title: 'Browser — React SPA', lines: ['loads frontend/dist', 'calls /api/* same-origin'], fill: C.pale, lineSize: 10 });
  arrow(s, 2.7, y + h / 2, 3.3, y + h / 2);
  box(s, { x: 3.3, y, w: 2.5, h, title: 'vas-https (pm2)', lines: ['Node TLS terminator', '0.0.0.0:5000 · TLS 1.3', 'trusted Let\u2019s Encrypt cert'], fill: C.pale, lineSize: 10 });
  arrow(s, 5.8, y + h / 2, 6.4, y + h / 2);
  box(s, { x: 6.4, y, w: 2.5, h, title: 'perf-tracking-api (pm2)', lines: ['Express — API + SPA static', 'listens 127.0.0.1:5001'], fill: C.pale, lineSize: 10 });
  arrow(s, 8.9, y + h / 2, 9.5, y + h / 2);
  box(s, { x: 9.5, y, w: 2.4, h, title: 'MySQL 8', lines: ['schema vas_revenue_tracking', 'loopback :3306 only'], fill: C.pale, lineSize: 10 });

  arrow(s, 7.65, y + h, 6.9, 4.1);
  arrow(s, 7.65, y + h, 9.7, 4.1);
  box(s, { x: 5.0, y: 4.12, w: 3.3, h: 0.58, title: null, lines: ['frontend/dist — built SPA (deep links)'], lineSize: 10 });
  box(s, { x: 8.6, y: 4.12, w: 3.3, h: 0.58, title: null, lines: ['backend/uploads/chat — media files'], lineSize: 10 });

  s.addText('SIDECAR / EXTERNAL SERVICES', { x: MX, y: 4.9, w: 6, h: 0.3, fontSize: 10.5, bold: true, color: C.mut, fontFace: FONT, charSpacing: 2 });
  box(s, { x: 0.6, y: 5.22, w: 3.85, h: 0.82, title: 'Google Gemini API', lines: ['AI assistant — outbound HTTPS (routes/ai.js)'], lineSize: 10 });
  box(s, { x: 4.74, y: 5.22, w: 3.85, h: 0.82, title: 'eTrade host', lines: ['TIN verification — outbound HTTPS (routes/channel.js)'], lineSize: 10 });
  box(s, { x: 8.88, y: 5.22, w: 3.85, h: 0.82, title: 'phpMyAdmin', lines: ['127.0.0.1:8081 — SSH tunnel only'], lineSize: 10 });

  s.addText('The VPS has no outbound internet — deployments and certificate renewals are driven from the office PC over SSH.', { x: MX, y: 6.38, w: W - 2 * MX, h: 0.5, fontSize: 11, italic: true, color: C.mut, fontFace: FONT });
}

// ============================================================ 4 · REPO LAYOUT
{
  const s = newSlide();
  chrome(s, 'Repository layout (monorepo)', 'Architecture');
  const tree = [
    'targettracking/',
    '├── backend/                      Express + MySQL API (CommonJS)',
    '│   ├── package.json              express · mysql2 · jsonwebtoken · bcryptjs · multer',
    '│   │                             xlsx · pptxgenjs · pdfkit · @google/generative-ai',
    '│   ├── uploads/chat/             chat media (served at /api/chat/media)',
    '│   └── src/',
    '│       ├── server.js             ENTRY: middleware, mounts 26 route modules, SPA fallback',
    '│       ├── env.js                loads .env',
    '│       ├── config/               database.js (pool) + idempotent db:* setup scripts',
    '│       ├── middleware/           permissions.js (LIVE auth) · auth.js (legacy, not mounted)',
    '│       ├── routes/               26 route modules — business logic lives here',
    '│       └── utils/                captcha · role permissions · caches · calculators',
    '├── frontend/                     React 19 + Vite 5 + Tailwind v4 SPA',
    '│   ├── vite.config.js            dev :3001, proxies /api → localhost:5000',
    '│   └── src/',
    '│       ├── App.jsx               router + route guards',
    '│       ├── components/           Layout · PuzzleCaptcha · ColumnPicker · channel/*',
    '│       ├── context/              AuthContext (auth + request) · DateFilterContext',
    '│       ├── pages/                28 screens',
    '│       └── services/api.js       request() helper + typed API client',
    '└── scripts/                      ops docs, SQL audits, architecture docs',
  ].join('\n');
  s.addText(tree, { x: MX, y: 1.5, w: W - 2 * MX, h: 5.5, fontSize: 9.6, color: C.ink, fontFace: MONO, valign: 'top', lineSpacingMultiple: 0.95 });
}

// ============================================================ 5 · REQUEST LIFECYCLE
{
  const s = newSlide();
  chrome(s, 'Request lifecycle & API pipeline', 'Backend');
  bullets(s, [
    'Every call enters one Express app — CORS, JSON body (10 MB limit) and URL-encoded parsers run first.',
    'Public paths (/api/auth, /api/health, /api/chat/media) skip authentication; everything else is guarded.',
    'authenticate (middleware/permissions.js) verifies the JWT, reloads the active user from the DB and resolves the effective role + permissions.',
    'Endpoint checks then run allow-list style: requirePermission(\'module\',\'action\') passes if the user holds any listed permission; requireAllPermissions needs all.',
    'Handlers execute raw SQL through the shared mysql2 pool; the utils layer supplies captcha, caches and calculators.',
    'A central error handler converts failures to clean JSON — 4xx pass through, 5xx hide stack traces.',
  ], { w: 6.2, size: 12.5 });
  vPipeline(s, 7.15, 5.55, [
    'HTTP request → Express app :5001 (behind TLS :5000)',
    'cors · json({limit:\'10mb\'}) · urlencoded',
    'authenticate — JWT → live user + permissions',
    "requirePermission('module','action') — allow-list",
    'route handler — raw SQL via mysql2 pool',
    'central error handler → JSON response',
  ], 1.6, 0.6, 0.22, 10.5);
}

// ============================================================ 6 · MODULE MAP 1
{
  const s = newSlide();
  chrome(s, 'Backend module map (1 of 2)', 'Backend');
  table(s, ['Mount', 'Module', 'Responsibility'], [
    ['/api/auth', 'auth.js', 'Login (+ puzzle captcha gate), me, change-password, forgot/reset, avatar, swap-section'],
    ['/api/health', 'inline', 'Liveness probe → { status: "ok" }'],
    ['/api/chat/media', 'express.static', 'Public chat media (unguessable filenames)'],
    ['/api/services', 'services.js', 'VAS service catalog (permission-guarded)'],
    ['/api/targets', 'targets.js', 'Revenue targets + month allocations (targetCalculator)'],
    ['/api/revenue', 'revenue.js', 'Revenue CRUD — audit-logged'],
    ['/api/reports', 'reports.js', 'Performance / trend reports'],
    ['/api/dashboard', 'dashboard.js', 'KPIs, service achievement, category breakdown, MoM growth'],
    ['/api/imports', 'imports.js', 'Excel import preview → confirm (xlsx), batches'],
    ['/api/partners', 'partners.js', 'Partner revenue datasets + fuzzy merge cache'],
    ['/api/actions', 'actions.js', 'Action notes, history, replies'],
    ['/api/action-tasks', 'actionTasks.js', 'Tasks under actions'],
    ['/api/goal-cascade', 'goalCascade.js', 'Goal cascades + items, auto-generate'],
  ], { x: MX, y: 1.55, w: W - 2 * MX, colW: [2.5, 2.4, 7.23], rowH: 0.4, size: 10 });
}

// ============================================================ 7 · MODULE MAP 2
{
  const s = newSlide();
  chrome(s, 'Backend module map (2 of 2)', 'Backend');
  table(s, ['Mount', 'Module', 'Responsibility'], [
    ['/api/categories', 'categories.js', 'Categories (permission-guarded)'],
    ['/api/roles', 'roles.js', 'Roles, permission assignment, section access'],
    ['/api/permissions', 'permissions.js', 'Permission catalog CRUD'],
    ['/api/users', 'users.js', 'User admin + per-section assignments'],
    ['/api/audit', 'audit.js', 'Audit trail (section-filtered)'],
    ['/api/alerts', 'alerts.js', 'Target achievement alerts'],
    ['/api/alert-feedback', 'alertFeedback.js', 'Feedback, reactions, replies'],
    ['/api/sms', 'sms.js', 'SMS log / send / import-and-send'],
    ['/api/chat', 'chat.js', 'Direct messages, groups, typing, media upload'],
    ['/api/notifications', 'notifications.js', 'Per-user notifications'],
    ['/api/exports', 'exports.js', 'PPTX (pptxgenjs) / PDF (pdfkit) report exports'],
    ['/api/ai', 'ai.js', 'Gemini assistant, usage tracking, daily quotas'],
    ['/api/channel\n+ /api/channel/imports', 'channel.js\nchannelImports.js', 'Indirect Channel: entities, TIN verify (eTrade), photos, imports, reports'],
  ], { x: MX, y: 1.55, w: W - 2 * MX, colW: [2.5, 2.4, 7.23], rowH: 0.4, size: 10 });
  s.addText('Every module except auth, health and chat/media sits behind the shared authenticate middleware; permission checks are declared inside each route file.', { x: MX, y: 6.45, w: W - 2 * MX, h: 0.4, fontSize: 10.5, italic: true, color: C.mut, fontFace: FONT });
}

// ============================================================ 8 · UTILS & CONFIG
{
  const s = newSlide();
  chrome(s, 'Backend utils & config layers', 'Backend');
  box(s, { x: MX, y: 1.55, w: 6.0, h: 4.9, title: 'utils/ — shared services', titleColor: C.brandDark, titleSize: 13, lines: [
    'puzzleCaptcha.js — slider captcha: 240×160 canvas, 52px piece, HMAC-signed id (ts.x.hmac), 3-min TTL, single-use, 30/min per IP.',
    'rolePermissions.js — resolves role → permission rows; narrows MULTI_SECTION roles by the token section.',
    'sectionMembership.js — SQL fragments for cross-section visibility (chat, audit).',
    'endpointCache.js — in-memory response cache for heavy report/dashboard endpoints.',
    'partnerCountCache.js — warmed partner aggregates, pre-warmed at boot in server.js.',
    'partnerMerge.js — fuzzy merge of partner name variants.',
    'targetCalculator.js — target allocation math + revenue_target_allocations.',
  ], lineSize: 11 });
  box(s, { x: 6.85, y: 1.55, w: 5.88, h: 2.35, title: 'config/ — data access', titleColor: C.brandDark, lines: [
    'database.js — the single mysql2 pool (limit 10, keep-alive); every module imports this one pool.',
    'env.js — loads .env; PORT and DB credentials are environment-driven.',
  ], lineSize: 11 });
  box(s, { x: 6.85, y: 4.05, w: 5.88, h: 2.4, title: 'config/ — schema setup (npm run db:*)', titleColor: C.brandDark, lines: [
    'dbSetup.js · channelDbSetup.js · simplifiedImport.js',
    'addIndexes · addScopeColumns · addMultiSectionScope',
    'addSectionSwapPermission · addChatPermissions · addChannelEditPermissions',
    'ensureAdminPermissions · ensureTable() boot hooks in actions, actionTasks, goalCascade, notifications, ai.',
    'All scripts are idempotent — safe to re-run.',
  ], lineSize: 10.5 });
}

// ============================================================ 9 · FRONTEND ARCH
{
  const s = newSlide();
  chrome(s, 'Frontend architecture', 'Frontend');
  bullets(s, [
    'React 19 SPA bootstrapped by main.jsx → App.jsx (BrowserRouter + Toaster).',
    'Context providers wrap the tree: AuthProvider (session, section, request helper) and DateFilterProvider (one global date range).',
    'Route guards compose: ProtectedRoute → SuperAdminScope → SectionGuard; PublicRoute bounces logged-in users away.',
    '28 pages organized by domain; the Layout shell provides the sidebar, topbar and section switcher.',
    'All data access goes through services/api.js — one request() helper attaches Authorization: Bearer <token>.',
    'Recharts renders every chart; shared widgets cover captcha, column picker, GPS capture and maps.',
  ], { w: 6.2, size: 12 });
  s.addText('LAYERED REQUEST PATH', { x: 7.05, y: 1.52, w: 6, h: 0.3, fontSize: 10.5, bold: true, color: C.mut, fontFace: FONT, charSpacing: 2 });
  vPipeline(s, 7.05, 5.65, [
    'Page component (pages/*)',
    'Typed API object (services/api.js)',
    'request() — fetch + Bearer token',
    'Express /api/* → JSON response',
    'State update → Recharts / tables',
  ], 1.85, 0.6, 0.26, 11);
}

// ============================================================ 10 · ROUTING & GUARDS
{
  const s = newSlide();
  chrome(s, 'Frontend routing & guards', 'Frontend');
  table(s, ['Route group', 'Paths', 'Guard'], [
    ['Public', '/ · /login · /forgot-password · /reset-password', 'PublicRoute — logged-in users redirected to their dashboard'],
    ['Admin', '/admin/users · /roles · /audit', 'ProtectedRoute + SuperAdminScope (GLOBAL admin home)'],
    ['VAS', '/dashboard · /services · /categories · /targets · /revenue\n/import · /reports · /partners · /actions · /goals · /alerts', 'ProtectedRoute + SectionGuard (VAS)'],
    ['Indirect Channel', '/channel · /channel/import-batch · /channel/import-single\n/channel/reports', 'ProtectedRoute + SectionGuard (Channel)'],
    ['Collaboration', '/users · /messages · /chat · /ai · /ai-usage', 'ProtectedRoute (+ section filters)'],
  ], { x: MX, y: 1.55, w: W - 2 * MX, colW: [2.0, 6.0, 4.13], rowH: 0.72, size: 10.5 });
  bullets(s, [
    { t: 'ProtectedRoute — no user or a pending section choice redirects to /login, so deep links cannot skip section selection.', sub: true },
    { t: 'SuperAdminScope — a GLOBAL master admin with no section is pinned to /admin/users, /roles and /audit until they swap into a section.', sub: true },
    { t: 'SectionGuard — restricts routes to listed sections; master and cross-section users pass. Mirrors the backend sectionScope.', sub: true },
    { t: 'Multi-section users see SectionChooser after login, which calls swapSection() before entering the app.', sub: true },
  ], { y: 5.0, size: 11.5 });
}

// ============================================================ 11 · LOGIN SEQUENCE
{
  const s = newSlide();
  chrome(s, 'Login & captcha — request sequence', 'Security');
  table(s, ['#', 'From → To', 'What happens'], [
    ['1', 'Browser → /api/auth', 'GET /api/auth/captcha — request a challenge'],
    ['2', 'Express → puzzleCaptcha', 'issueChallenge() returns { id, bg, piece, piece_y, size }'],
    ['3', 'puzzleCaptcha', 'id = ts.pieceX.hmac (base64url) — TTL 3 min, single-use, 30/min per IP'],
    ['4', 'Browser', 'User drags the slider; answer ref = { captcha_id, captcha_x }'],
    ['5', 'Browser → /api/auth/login', 'POST email, password, captcha_id, captcha_x'],
    ['6', 'Express → puzzleCaptcha', 'verifyChallenge(id, x) — ±8px tolerance; replay/expiry → 400 captcha_failed (new puzzle)'],
    ['7', 'Express → MySQL', 'SELECT user by email · bcrypt compare · active check'],
    ['8', 'Express → MySQL', 'Resolve role scope + role_section_access / user_sections'],
    ['9', 'Express → Browser', 'Multiple sections → { user, sections } → SectionChooser → POST /swap-section'],
    ['10', 'Express → Browser', 'Single section → JWT { id, role_id, section, role_name } → localStorage.vas_token → dashboard'],
  ], { x: MX, y: 1.52, w: W - 2 * MX, colW: [0.6, 3.3, 8.23], rowH: 0.43, size: 10.5, headSize: 11 });
  s.addText('The captcha gate runs before any DB or bcrypt work — protecting the login endpoint from brute force and bot traffic.', { x: MX, y: 6.6, w: W - 2 * MX, h: 0.4, fontSize: 10.5, italic: true, color: C.mut, fontFace: FONT });
}

// ============================================================ 12 · SECURITY ARCH
{
  const s = newSlide();
  chrome(s, 'Security architecture — layered defenses', 'Security');
  box(s, { x: MX, y: 1.55, w: 6.0, h: 2.35, title: 'Identity & login', titleColor: C.brandDark, lines: [
    'Slider puzzle captcha gates every login — HMAC-signed, single-use, 3-min TTL, 30 attempts/min/IP',
    'Passwords bcrypt-hashed; JWT Bearer token on every API call',
    'Multi-section users choose a section; the token carries role + section',
  ], lineSize: 11 });
  box(s, { x: 6.85, y: 1.55, w: 5.88, h: 2.35, title: 'Authorization (live RBAC)', titleColor: C.brandDark, lines: [
    'Roles hold permissions, scoped GLOBAL / MULTI_SECTION / single-section',
    'Permissions re-resolved from the DB on every request — revocation is instant',
    'Allow-list per endpoint: requirePermission / requireAllPermissions',
    'Section confinement on both layers: SectionGuard (UI) + sectionScope (API)',
  ], lineSize: 11 });
  box(s, { x: MX, y: 4.05, w: 6.0, h: 2.35, title: 'Application & transport', titleColor: C.brandDark, lines: [
    'TLS 1.3 on the public entry with a trusted, auto-renewed certificate',
    'Restricted CORS; 10 MB body limit; central error handler — no stack traces leak',
    'Chat media stored under unguessable names and served as static assets',
    'audit_trail records user + timestamp for every sensitive write',
  ], lineSize: 11 });
  box(s, { x: 6.85, y: 4.05, w: 5.88, h: 2.35, title: 'Data & infrastructure', titleColor: C.brandDark, lines: [
    'MySQL binds to 127.0.0.1 only; port 3306 filtered from the internet (verified)',
    'phpMyAdmin loopback-only via SSH tunnel; per-person revocable keys',
    'Nightly mysqldump at 02:15 with 14-day rotation',
    'Deployments and renewals driven from the office PC — VPS has no outbound internet',
  ], lineSize: 11 });
}

// ============================================================ 13 · DATA MODEL DOMAINS
{
  const s = newSlide();
  chrome(s, 'Data model — domains & table groups', 'Data');
  box(s, { x: MX, y: 1.55, w: 6.0, h: 2.35, title: 'Identity & access (RBAC core)', titleColor: C.brandDark, lines: [
    'users · roles · permissions · role_permissions',
    'user_sections · role_section_access (swappable sections)',
    'audit_trail — every sensitive write, section-filtered',
  ] });
  box(s, { x: 6.85, y: 1.55, w: 5.88, h: 2.35, title: 'Revenue core (VAS)', titleColor: C.brandDark, lines: [
    'vas_services · vas_service_types · vas_categories',
    'revenue_targets · revenue_target_allocations',
    'partner_revenue · import_batches · kpi_snapshots',
    'action_notes · action_tasks · action_history · action_replies',
  ] });
  box(s, { x: MX, y: 4.05, w: 6.0, h: 2.35, title: 'Indirect Channel (parallel schema)', titleColor: C.brandDark, lines: [
    'channel_entities — keyed by mobile number',
    'channel_domains / categories / aliases · channel_geo_aliases',
    'channel_stock_balances · channel_stock_summary',
    'channel_import_batches / rows / errors',
    'channel_manager_photos — keyed by TIN (from eTrade)',
  ] });
  box(s, { x: 6.85, y: 4.05, w: 5.88, h: 2.35, title: 'Collaboration & follow-up', titleColor: C.brandDark, lines: [
    'chat_messages · chat_groups · chat_group_members',
    'notifications · sms_messages',
    'goal_cascades · goal_cascade_items',
    'alert_feedback · ai_usage (Gemini quotas)',
  ] });
}

// ============================================================ 14 · DATA MODEL RELATIONSHIPS
{
  const s = newSlide();
  chrome(s, 'Data model — relationships & integrity', 'Data');
  bullets(s, [
    { t: 'RBAC core', b: true },
    { t: 'users → roles (default role_id) → role_permissions → permissions; user_sections assigns per-section roles; role_section_access lists which sections a role may swap into.', sub: true },
    { t: 'Revenue core', b: true },
    { t: 'vas_services anchors revenue_targets → revenue_target_allocations; actuals flow into partner_revenue, tracked by import_batches; kpi_snapshots keeps dashboard history.', sub: true },
    { t: 'Follow-up chain', b: true },
    { t: 'action_notes → action_tasks / action_history / action_replies; goal_cascades → goal_cascade_items; alert_feedback links users to alert responses.', sub: true },
    { t: 'Channel schema', b: true },
    { t: 'channel_domains → channel_categories → channel_entities → channel_stock_balances; import batches fan out to rows and error rows; manager photos join to entities via TIN.', sub: true },
    { t: 'Integrity approach', b: true },
    { t: 'money and registry data are relational with indexes on hot tables; import_batches use varchar(36) ids so every imported row is traceable to its batch.', sub: true },
  ], { size: 12.5 });
}

// ============================================================ 15 · EXTERNAL INTEGRATIONS
{
  const s = newSlide();
  chrome(s, 'External integrations', 'Architecture');
  box(s, { x: MX, y: 1.55, w: 6.0, h: 2.5, title: 'Google Gemini — AI assistant', titleColor: C.brandDark, lines: [
    'routes/ai.js calls @google/generative-ai (optionally through an undici proxy).',
    'Keys come from environment variables — never committed.',
    'Usage and quotas tracked per user in ai_usage; a daily limit protects cost.',
    'Answers are grounded on the same dataset the dashboards read.',
  ], lineSize: 11 });
  box(s, { x: 6.85, y: 1.55, w: 5.88, h: 2.5, title: 'eTrade host — TIN verification', titleColor: C.brandDark, lines: [
    'routes/channel.js issues an outbound HTTPS request (https.get) with Referer/Origin headers.',
    'Verifies a retailer/distributor TIN against the external registry.',
    'Manager photos are then linked to channel entities by TIN.',
  ], lineSize: 11 });
  box(s, { x: MX, y: 4.2, w: 6.0, h: 2.2, title: 'Let\u2019s Encrypt (ACME)', titleColor: C.brandDark, lines: [
    'IP certificate issued in the short-lived profile (~6.5-day validity).',
    'HTTP-01 challenge proxied by nginx to the Express app.',
    'Renewal is driven from the office PC and installs to ~/vas-tls, then restarts vas-https.',
  ], lineSize: 11 });
  box(s, { x: 6.85, y: 4.2, w: 5.88, h: 2.2, title: 'Document & data services', titleColor: C.brandDark, lines: [
    'pptxgenjs — PPTX report exports.',
    'pdfkit — PDF report exports.',
    'xlsx — Excel import parsing on the server.',
  ], lineSize: 11 });
}

// ============================================================ 16 · BUILD & RUN
{
  const s = newSlide();
  chrome(s, 'Build, run & environments', 'Operations');
  table(s, ['Concern', 'Value'], [
    ['Backend dev', 'npm run dev (nodemon) — port 5000'],
    ['Frontend dev', 'npm run dev (Vite :3001, /api proxied to :5000)'],
    ['Frontend build', 'npx vite build → frontend/dist (served by Express when present)'],
    ['Production', 'pm2 perf-tracking-api → backend/src/server.js, serves frontend/dist behind vas-https on :5000'],
    ['DB setup scripts', 'npm run db:setup · db:admin-perms · db:chat-perms · db:channel-edit-perms · db:multi-section-scope'],
    ['Deploy (VPS)', 'vite build → tar frontend/dist + changed backend files → scp → extract → pm2 restart'],
    ['Health', 'GET /api/health → { status: "ok" }'],
    ['Lint / tests', 'npm run lint (oxlint, frontend); node --check (backend). No automated test suite in repo.'],
  ], { x: MX, y: 1.6, w: W - 2 * MX, colW: [2.6, 9.53], rowH: 0.6, size: 11.5, headSize: 12 });
}

// ============================================================ 17 · PRODUCTION RUNTIME
{
  const s = newSlide();
  chrome(s, 'Production runtime on the VPS', 'Operations');
  table(s, ['pm2 process', 'Port', 'Role'], [
    ['vas-https', '0.0.0.0:5000', 'Node TLS terminator — public entry, trusted Let\u2019s Encrypt certificate, TLS 1.3'],
    ['perf-tracking-api', '127.0.0.1:5001', 'Express — API and built SPA (env-driven PORT)'],
    ['phpmyadmin', '127.0.0.1:8081', 'DB admin UI — loopback only, reached via SSH tunnel'],
    ['jobsethiopia-api · liblelib', '—', 'Unrelated sites sharing the same host'],
  ], { x: MX, y: 1.6, w: W - 2 * MX, colW: [2.9, 2.0, 7.23], rowH: 0.52, size: 11 });
  bullets(s, [
    'Host: Ubuntu VPS 196.189.155.179 — application at /var/www/performancetracking/app.',
    'nginx owns ports 80/443 and 302-redirects bare-IP traffic to the app URL; it forwards the ACME challenge path to Express.',
    'The VPS has no outbound internet: deployments go over scp; ACME renewals run from the office PC.',
    'pm2 restarts must not override the cached environment (no --update-env) or the stale PORT breaks binding.',
  ], { y: 4.5, size: 12 });
}

// ============================================================ 18 · RELIABILITY & CACHING
{
  const s = newSlide();
  chrome(s, 'Reliability, caching & operations', 'Operations');
  bullets(s, [
    'Backups: nightly mysqldump at 02:15 → ~/backups/vas-YYYY-MM-DD.sql.gz, 14-day rotation, passwordless via ~/.my.cnf (verified).',
    'Performance: in-memory endpoint caches, partner aggregates pre-warmed at boot, indexes on hot tables.',
    'Schema resilience: idempotent setup scripts plus ensureTable() boot hooks recreate missing tables automatically.',
    'Dev parity: local XAMPP MariaDB mirrors the production schema; localhost is a secure context so GPS capture works in development.',
    'Certificate resilience: daily renewal job skips when >4 days of validity remain; logged to scripts/le/renew.log.',
    'Recovery: redeploy is a tar + scp + pm2 restart; the SPA is served from disk so a backend restart does not break static assets.',
  ], { w: 6.6, size: 12 });
  s.addText('DEPLOY / VERIFY CHECKLIST', { x: 7.45, y: 1.55, w: 5.4, h: 0.3, fontSize: 10.5, bold: true, color: C.mut, fontFace: FONT, charSpacing: 2 });
  vPipeline(s, 7.45, 5.25, [
    'npx vite build (frontend)',
    'tar + scp to the VPS',
    'Swap dist / backend files',
    'pm2 restart (no env override)',
    'GET /api/health → ok',
    'Spot-check login + a report',
  ], 1.9, 0.56, 0.24, 10.5);
}

// ============================================================ 19 · END-TO-END
{
  const s = newSlide();
  chrome(s, 'End-to-end walkthrough — click to database', 'Architecture');
  bullets(s, [
    '1  Browser loads the SPA from Express, then React Router mounts the page behind its guards.',
    '2  The page calls a typed API object; request() attaches the Bearer token and issues fetch(/api/...).',
    '3  nginx/vas-https terminates TLS on :5000 and forwards to Express on :5001.',
    '4  Express parses the request, authenticate reloads the user and re-resolves permissions from MySQL.',
    '5  requirePermission checks the module/action allow-list; the handler runs raw SQL via the pool.',
    '6  Caches short-circuit heavy endpoints; results return as JSON with clean error handling.',
    '7  Sensitive writes also insert into audit_trail before responding.',
    '8  React stores the result in state; Recharts and tables re-render the updated view.',
  ], { w: 6.4, size: 12 });
  s.addText('ONE REQUEST, ONE PATH', { x: 7.25, y: 1.55, w: 5.6, h: 0.3, fontSize: 10.5, bold: true, color: C.mut, fontFace: FONT, charSpacing: 2 });
  vPipeline(s, 7.25, 5.45, [
    'React page (guarded)',
    'services/api.js → fetch + token',
    'vas-https TLS :5000 → Express :5001',
    'authenticate + requirePermission',
    'SQL via mysql2 pool → MySQL',
    'JSON response → UI re-render',
  ], 1.9, 0.58, 0.26, 10.5);
}

// ============================================================ 20 · CLOSING
{
  const s = newSlide();
  s.background = { color: C.dark };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.22, h: H, fill: { color: C.brand } });
  s.addText('Architecture in one line', { x: 0.95, y: 1.5, w: 11, h: 0.8, fontSize: 32, bold: true, color: C.white, fontFace: FONT });
  s.addText('One Node process serves the API and the React SPA on a single VPS, with live DB-backed authorization, a parallel revenue/channel schema, and a trusted TLS edge driven from the office PC.', { x: 0.95, y: 2.5, w: 11.4, h: 1.0, fontSize: 14, color: 'C6CEDA', fontFace: FONT });
  s.addText('REFERENCE DOCS IN THE REPOSITORY', { x: 0.95, y: 4.0, w: 11, h: 0.35, fontSize: 11, bold: true, color: C.brand, charSpacing: 2, fontFace: FONT });
  s.addText([
    { text: 'scripts/ARCHITECTURE.md — full architecture walkthrough (source of this deck)', options: { breakLine: true, paraSpaceAfter: 6 } },
    { text: 'scripts/DATABASE-SECURITY.md — DB access & security runbook', options: { breakLine: true, paraSpaceAfter: 6 } },
    { text: 'scripts/le/README.md — TLS certificate renewal system', options: { breakLine: true } },
  ], { x: 0.95, y: 4.4, w: 11, h: 1.3, fontSize: 13, color: 'C6CEDA', fontFace: FONT });
  s.addText('Regenerate this deck anytime:  node scripts/makeArchTechDoc.js', { x: 0.95, y: 6.55, w: 11, h: 0.35, fontSize: 11, color: '7C8894', fontFace: FONT });
}

// ------------------------------------------------------------------ write
pptx.writeFile({ fileName: OUT }).then(() => {
  console.log('Written:', OUT);
});
