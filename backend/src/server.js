const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('./env');

// Node cluster bootstrap. In production the primary process forks one worker per
// CPU core — under pm2 fork/instances=1 both cores were otherwise idle — and
// only the workers build the Express app below. In development this returns
// false and everything runs in a single process as before. See ./cluster.js.
const { bootstrapCluster, workerLabel } = require('./cluster');
if (bootstrapCluster()) return;

const serviceRoutes = require('./routes/services');
const targetRoutes = require('./routes/targets');
const revenueRoutes = require('./routes/revenue');
const reportRoutes = require('./routes/reports');
const dashboardRoutes = require('./routes/dashboard');
const importRoutes = require('./routes/imports');
const auditRoutes = require('./routes/audit');
const partnerRoutes = require('./routes/partners');
const actionRoutes = require('./routes/actions');
const categoryRoutes = require('./routes/categories');
const roleRoutes = require('./routes/roles');
const permissionRoutes = require('./routes/permissions');
const userRoutes = require('./routes/users');
const authRoutes = require('./routes/auth');
const alertRoutes = require('./routes/alerts');
const smsRoutes = require('./routes/sms');
const chatRoutes = require('./routes/chat');
const exportRoutes = require('./routes/exports');
const alertFeedbackRoutes = require('./routes/alertFeedback');
const aiRoutes = require('./routes/ai');
const actionTaskRoutes = require('./routes/actionTasks');
const goalCascadeRoutes = require('./routes/goalCascade');
const notificationRoutes = require('./routes/notifications');
const channelRoutes = require('./routes/channel');
const channelImportRoutes = require('./routes/channelImports');

const { authenticate } = require('./middleware/permissions');

const app = express();

// Which process answered — makes load spreading across cluster workers visible
// in responses and while debugging (label only, no secrets).
app.use((req, res, next) => {
  res.setHeader('X-Worker', workerLabel());
  next();
});

// Port comes from the environment (.env.production carries PORT=5001 in
// production, where 5000 is taken by the public TLS terminator); plain 5000
// remains the default for local development.
const PORT = Number(process.env.PORT) || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Auth routes — no token required
app.use('/api/auth', authRoutes);

// Health check — no token required
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ACME HTTP-01 challenge answers (Let's Encrypt). The TLS certificate for the
// public IP is short-lived (~6 days) and is renewed by an external machine
// that has internet access — this VPS has none. That machine drops the
// challenge file into ../acme-challenges (relative to the backend dir) and
// Let's Encrypt fetches http://196.189.155.179/.well-known/acme-challenge/<token>.
// nginx forwards exactly this path here on port 80; no auth, no secrets.
app.get('/.well-known/acme-challenge/:token', (req, res) => {
  const file = path.join(__dirname, '..', 'acme-challenges', path.basename(req.params.token));
  fs.readFile(file, 'utf8', (err, body) => {
    if (err) return res.status(404).send('not found');
    res.type('text/plain').send(body);
  });
});

// Chat media files are loaded by <img>/<audio>/<a> tags, which cannot send the
// Authorization header — serve the uploads folder publicly (files are unguessable
// random names, and only chat uploads live there).
app.use('/api/chat/media', express.static(path.join(__dirname, '../uploads/chat')));

// All other API routes require authentication
app.use('/api/services', authenticate, serviceRoutes);
app.use('/api/targets', authenticate, targetRoutes);
app.use('/api/revenue', authenticate, revenueRoutes);
app.use('/api/reports', authenticate, reportRoutes);
app.use('/api/dashboard', authenticate, dashboardRoutes);
app.use('/api/imports', authenticate, importRoutes);
app.use('/api/audit', authenticate, auditRoutes);
app.use('/api/partners', authenticate, partnerRoutes);
app.use('/api/actions', authenticate, actionRoutes);
app.use('/api/categories', authenticate, categoryRoutes);
app.use('/api/roles', authenticate, roleRoutes);
app.use('/api/permissions', authenticate, permissionRoutes);
app.use('/api/users', authenticate, userRoutes);
app.use('/api/alerts', authenticate, alertRoutes);
app.use('/api/sms', authenticate, smsRoutes);
app.use('/api/chat', authenticate, chatRoutes);
app.use('/api/exports', authenticate, exportRoutes);
app.use('/api/alert-feedback', authenticate, alertFeedbackRoutes);
app.use('/api/ai', authenticate, aiRoutes);
app.use('/api/action-tasks', authenticate, actionTaskRoutes);
app.use('/api/goal-cascade', authenticate, goalCascadeRoutes);
app.use('/api/notifications', authenticate, notificationRoutes);

// Indirect Channel section — separate tables, separate route namespace
app.use('/api/channel/imports', authenticate, channelImportRoutes);
app.use('/api/channel', authenticate, channelRoutes);

// Production single-service mode: serve the built frontend when present.
// The SPA calls the API with relative /api paths, so everything runs on this
// one port — no separate web server needed.
const distDir = path.join(__dirname, '../../frontend/dist');
if (require('fs').existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  // Body-parser and multer reject bad requests with a 4xx status on the error
  // object. Reporting those as a generic 500 hides the real reason (an oversized
  // upload simply read as "Internal server error"), so pass them through.
  const status = Number(err.status || err.statusCode) || 500;
  if (status >= 500) {
    console.error('Error:', err);
    res.status(status).json({ error: 'Internal server error', message: err.message });
  } else {
    console.warn(`Rejected ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(status).json({ error: err.message || 'Request rejected' });
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 VAS Revenue Backend running on port ${PORT} [${workerLabel()}]`);
  
  // Pre-warm caches on startup so first user requests are instant
  setTimeout(async () => {
    try {
      // 1. Warm the shared partner count (runs fuzzy merge once)
      const { warmPartnerCount } = require('./utils/partnerCountCache');
      await warmPartnerCount();
    } catch {}

    // Endpoint pre-warm runs in one worker only. Its self-requests are
    // round-robined across every worker anyway, and letting each worker warm
    // separately would repeat the same expensive report queries at boot on a
    // small box; the others fill their caches as real traffic reaches them.
    if (process.env.VAS_CLUSTER_WORKER && process.env.NODE_APP_INSTANCE !== '0') return;
    
    const jwt = require('jsonwebtoken');
    const http = require('http');
    const token = jwt.sign({ id: 1, role: 'admin' }, process.env.JWT_SECRET || 'vas-revenue-secret-key-2024', { expiresIn: '1h' });
    const warmUrl = (path) => {
      return new Promise((resolve) => {
        http.get(`http://localhost:${PORT}${path}`, { headers: { Authorization: 'Bearer ' + token } }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve());
        }).on('error', () => resolve());
      });
    };
    console.log('🔥 Pre-warming endpoint caches...');
    // Build date ranges dynamically based on today
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const lastDayOfMonth = new Date(y, now.getMonth() + 1, 0).getDate();
    // Fiscal year: June–May (adjust if yours differs)
    const fiscalStart = now.getMonth() >= 5 ? y : y - 1; // >= June means new FY
    const commonRanges = [
      // Current fiscal year (most common view)
      `start_date=${fiscalStart}-06-01&end_date=${fiscalStart + 1}-05-31`,
      // Previous fiscal year
      `start_date=${fiscalStart - 1}-06-01&end_date=${fiscalStart}-05-31`,
      // Current month
      `start_date=${y}-${mo}-01&end_date=${y}-${mo}-${lastDayOfMonth}`,
    ];
    const warmPromises = [];
    for (const range of commonRanges) {
      warmPromises.push(warmUrl(`/api/dashboard/kpis?${range}`));
      warmPromises.push(warmUrl(`/api/partners/dashboard-kpis?${range}`));
      warmPromises.push(warmUrl(`/api/partners/summary?${range}`));
      warmPromises.push(warmUrl(`/api/partners/top-partners?${range}`));
    }
    // Also warm the partner months list and alerts
    warmPromises.push(warmUrl('/api/partners/months'));
    warmPromises.push(warmUrl(`/api/alerts?start_date=${fiscalStart}-06-01&end_date=${fiscalStart + 1}-05-31`));
    Promise.all(warmPromises).then(() => console.log('✅ All caches warmed')).catch(() => {});
  }, 200);
});

// Stop accepting, let in-flight responses finish, then exit. The cluster primary
// signals workers with SIGTERM on restart, and pm2 only waits ~1.6s before it
// goes for SIGKILL — so the deadline here stays well inside that window.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  if (server.closeIdleConnections) server.closeIdleConnections();
  setTimeout(() => process.exit(0), 1000).unref();
});

module.exports = app;
