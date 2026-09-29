const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pool = require('../config/database');

// Optional egress proxy — the production VPS's international link is
// intermittent; set AI_PROXY_URL in .env.production to route Gemini traffic
// through a working proxy (also honours standard HTTPS_PROXY).
const proxyUrl = process.env.AI_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) {
  try {
    const { setGlobalDispatcher, ProxyAgent } = require('undici');
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log('[AI] Routing Gemini traffic through proxy');
  } catch (e) {
    console.warn('[AI] Proxy configured but undici unavailable:', e.message);
  }
}

// ── API Key Pool (round-robin rotation) ────────────────────────────────────────
// Keys are loaded from environment variables — never hardcode secrets in source!
// Set GEMINI_API_KEY_1 through GEMINI_API_KEY_5 in your .env file.
const API_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5,
].filter(Boolean); // ignore undefined slots


const genAIClients = API_KEYS.map(k => new GoogleGenerativeAI(k));
let currentKeyIndex = 0;

// Track per-key 429 errors so we can skip a key that's been rate-limited
const keyCooldownUntil = API_KEYS.map(() => 0); // timestamp ms

function getActiveClient() {
  const now = Date.now();
  const start = currentKeyIndex;
  for (let i = 0; i < API_KEYS.length; i++) {
    const idx = (start + i) % API_KEYS.length;
    if (now >= keyCooldownUntil[idx]) {
      currentKeyIndex = (idx + 1) % API_KEYS.length; // next time start from the one after
      console.log(`[AI] Using API key #${idx + 1}/${API_KEYS.length}`);
      return { client: genAIClients[idx], keyIndex: idx };
    }
  }
  // All keys on cooldown — use the one whose cooldown ends soonest
  const soonestIdx = keyCooldownUntil.indexOf(Math.min(...keyCooldownUntil));
  currentKeyIndex = (soonestIdx + 1) % API_KEYS.length;
  console.log(`[AI] All keys on cooldown — using key #${soonestIdx + 1} (cooldown ends in ${Math.max(0, keyCooldownUntil[soonestIdx] - now)}ms)`);
  return { client: genAIClients[soonestIdx], keyIndex: soonestIdx };
}

function markKeyRateLimited(keyIndex, retryAfterMs = 60000) {
  keyCooldownUntil[keyIndex] = Date.now() + retryAfterMs;
  console.warn(`[AI] Key #${keyIndex + 1} rate-limited, cooldown ${retryAfterMs}ms`);
}

// Network errors (the VPS international link is intermittent) — retry a few
// times per key with backoff before giving the next key a chance.
const isNetworkErr = (e) =>
  /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|network|socket/i.test(
    (e && (e.message || '')) + (e && e.cause ? ' ' + (e.cause.code || e.cause.message || '') : '')
  );

async function sendMessageWithRetry(chat, message, keyIndex, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const delay = 1200 * i; // 1.2s, 2.4s
      console.warn(`[AI] Key #${keyIndex + 1} network retry ${i}/${attempts - 1} in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      return await chat.sendMessage(message);
    } catch (err) {
      lastErr = err;
      const is429 = err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED');
      if (is429) throw err; // hand over to key rotation
      if (!isNetworkErr(err)) throw err; // genuine API error — don't retry
      // network error — loop and retry
    }
  }
  throw lastErr;
}

// ── Model fallback chain ───────────────────────────────────────────────────────
// Gemini demand spikes are per model: while one flash model answers 503 "high
// demand", a sibling model usually answers normally. A request therefore walks
// this chain instead of being pinned to a single model. Override the order (or
// trim the list) with GEMINI_MODELS in the environment.
const MODEL_CHAIN = (process.env.GEMINI_MODELS || [
  'gemini-3.6-flash',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-flash-latest',
].join(','))
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

// 503 "model is currently experiencing high demand" and friends are transient
// upstream conditions — worth another model rather than failing the request.
const errorStatus = (e) =>
  Number(e && (e.status || e.statusCode || (e.response && e.response.status))) || 0;

const isOverloadedErr = (e) => {
  if (errorStatus(e) === 503 || errorStatus(e) === 500) return true;
  const msg = (e && (e.message || '')) +
    (e && e.cause ? ' ' + (e.cause.code || e.cause.message || '') : '');
  return /\b503\b|UNAVAILABLE|overloaded|high demand|service unavailable|internal error|\b500\b|DEADLINE_EXCEEDED|timed ?out/i.test(msg);
};

// 429s are per API key, so they rotate the key for the same model. Match the
// status or an explicit rate-limit phrase — deliberately NOT a bare /rate/,
// because every Gemini error message embeds the request URL and
// "generateContent" contains "rate", which made every 503 look like a 429 and
// burn all the API keys.
const isRateLimitErr = (e) => {
  if (errorStatus(e) === 429) return true;
  const msg = (e && (e.message || '')) || '';
  return /\b429\b|RESOURCE_EXHAUSTED|too many requests|rate limit|rate-limit|quota exceeded/i.test(msg);
};

const modelCooldownUntil = new Map(); // model name -> timestamp ms
// A short cool-down only affects which model is tried FIRST on the next
// request — overloaded models stay in the chain, because the condition clears
// within seconds and a retry very often succeeds.
function markModelOverloaded(model, retryAfterMs = 20000) {
  modelCooldownUntil.set(model, Date.now() + retryAfterMs);
  console.warn(`[AI] Model ${model} overloaded, cooling down ${Math.round(retryAfterMs / 1000)}s`);
}

// Healthy models first (chain order), cooled-down ones last so a request still
// has somewhere to go when every model is spiking.
function pickModelOrder() {
  const now = Date.now();
  const ready = [];
  const cooling = [];
  for (const m of MODEL_CHAIN) {
    (now >= (modelCooldownUntil.get(m) || 0) ? ready : cooling).push(m);
  }
  cooling.sort((a, b) => (modelCooldownUntil.get(a) || 0) - (modelCooldownUntil.get(b) || 0));
  return [...ready, ...cooling];
}

// ── Retry plan ─────────────────────────────────────────────────────────────────
// 503s are transient per request, so one failed attempt is not a verdict: the
// plan cycles the model chain and the cap keeps a bad moment from making the
// user wait forever. Override the cap with AI_MAX_ATTEMPTS.
const MAX_TOTAL_ATTEMPTS = Number(process.env.AI_MAX_ATTEMPTS) || 8;

function buildAttemptPlan() {
  const order = pickModelOrder();
  const plan = [];
  while (plan.length < MAX_TOTAL_ATTEMPTS) plan.push(...order);
  return plan.slice(0, MAX_TOTAL_ATTEMPTS);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Short, growing pause with jitter between attempts — long enough for a
// momentary demand spike to pass, short enough not to stall the chat.
function sleepForRetry(attempt) {
  return sleep(Math.min(900, attempt * 150) + Math.floor(Math.random() * 150));
}

// The first four turns seed the conversation with the freshly built VAS
// context; the rest is the user's own history.
function buildChat(model, history, contextStr) {
  const chatHistory = [];
  if (history && Array.isArray(history)) {
    history.forEach(msg => {
      chatHistory.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      });
    });
  }

  return model.startChat({
    history: [
      { role: 'user', parts: [{ text: 'You are the VAS AI Assistant. Analyze the following data and be ready to answer questions.' }] },
      { role: 'model', parts: [{ text: 'I understand. I am the VAS AI Assistant for Ethio Telecom. I have access to the current VAS revenue data including services, targets, achievements, monthly trends, partners, and alerts. Ask me anything about the VAS performance data.' }] },
      { role: 'user', parts: [{ text: contextStr }] },
      { role: 'model', parts: [{ text: 'I have analyzed the VAS data. I can see the revenue achievements, trends, partner performance, and alert statuses. What would you like to know?' }] },
      ...chatHistory,
    ],
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.7,
      topP: 0.9,
    },
  });
}

// ── Ensure DB tables exist ─────────────────────────────────────────────────────
async function ensureAITables() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS ai_usage (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        query_date DATE NOT NULL,
        question_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_date (user_id, query_date),
        INDEX idx_user_date (user_id, query_date)
      )
    `);
  } catch (e) {
    console.error('[AI] ai_usage table check failed:', e.message);
  }
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS ai_chat_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        session_id VARCHAR(36) NOT NULL,
        role ENUM('user', 'assistant') NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_session (user_id, session_id),
        INDEX idx_user_created (user_id, created_at)
      )
    `);
  } catch (e) {
    console.error('[AI] ai_chat_history table check failed:', e.message);
  }
  try {
    await pool.execute(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS max_ai_questions_per_day INT DEFAULT 50
    `);
  } catch (e) {
    // Column already exists — ignore
  }
}

// Run once on module load (fire-and-forget)
ensureAITables();

// ── Helpers ────────────────────────────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function checkQuota(userId) {
  if (!userId) return { allowed: true, used: 0, max: 50 };

  // Get user's max
  const [userRows] = await pool.execute(
    'SELECT max_ai_questions_per_day FROM users WHERE id = ?',
    [userId]
  );
  const max = Number(userRows[0]?.max_ai_questions_per_day || 50);

  // Get today's usage
  const [usageRows] = await pool.execute(
    'SELECT question_count FROM ai_usage WHERE user_id = ? AND query_date = ?',
    [userId, todayStr()]
  );
  const used = Number(usageRows[0]?.question_count || 0);

  return { allowed: used < max, used, max };
}

async function incrementUsage(userId) {
  if (!userId) return;
  try {
    await pool.execute(`
      INSERT INTO ai_usage (user_id, query_date, question_count)
      VALUES (?, ?, 1)
      ON DUPLICATE KEY UPDATE question_count = question_count + 1
    `, [userId, todayStr()]);
  } catch (e) {
    console.error('[AI] Failed to track usage:', e.message);
  }
}

// ── Format currency for AI context ────────────────────────────────────────────
function formatETB(amount) {
  if (amount >= 1e9) return `ETB ${(amount / 1e9).toFixed(2)}B`;
  if (amount >= 1e6) return `ETB ${(amount / 1e6).toFixed(1)}M`;
  if (amount >= 1e3) return `ETB ${(amount / 1e3).toFixed(0)}K`;
  return `ETB ${amount.toFixed(0)}`;
}

// ── Build VAS context from database ────────────────────────────────────────────
async function buildVASContext() {
  const context = {};

  try {
    const [revRows] = await pool.execute(
      `SELECT COALESCE(SUM(total_revenue), 0) as total_revenue,
              COALESCE(SUM(ethio_share), 0) as ethio_share,
              COUNT(DISTINCT partner_name) as partner_count
       FROM partner_revenue`
    );
    const [actRows] = await pool.execute(
      `SELECT COALESCE(SUM(ar.amount), 0) as total_revenue
       FROM actual_revenue ar`
    );
    const manualTotal = Number(actRows[0]?.total_revenue || 0);
    context.total_revenue = Number(revRows[0]?.total_revenue || 0) + (manualTotal < 1e12 ? manualTotal : 0);
    context.partner_count = Number(revRows[0]?.partner_count || 0);

    const [services] = await pool.execute('SELECT * FROM vas_services ORDER BY name');
    context.services = services.map(s => ({ name: s.name, id: s.id }));

    // Get ALL targets — keep individual rows for multi-target services
    const [targets] = await pool.execute(
      `SELECT rt.id, rt.service_name, rt.target_amount, rt.period_type,
              rt.target_start_date, rt.target_end_date
       FROM revenue_targets rt
       ORDER BY rt.service_name, rt.target_start_date`
    );
    context.targets = targets.map(t => ({
      service: t.service_name,
      target: Number(t.target_amount),
      period: t.period_type,
      start: t.target_start_date,
      end: t.target_end_date,
    }));

    const [svcRevenue] = await pool.execute(
      `SELECT service_name, SUM(total_revenue) as actual FROM partner_revenue GROUP BY service_name`
    );
    const [manualRevenue] = await pool.execute(
      `SELECT vs.name as service_name, SUM(ar.amount) as actual
       FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id
       WHERE ar.revenue_month IS NOT NULL AND ar.amount < 1000000000
       GROUP BY vs.name`
    );
    const revenueMap = {};
    svcRevenue.forEach(r => { revenueMap[r.service_name] = (revenueMap[r.service_name] || 0) + Number(r.actual); });
    manualRevenue.forEach(r => { revenueMap[r.service_name] = (revenueMap[r.service_name] || 0) + Number(r.actual); });

    // Per-service monthly revenue breakdown
    const [monthlyByService] = await pool.execute(
      `SELECT service_name, revenue_month, SUM(total_revenue) as revenue
       FROM partner_revenue GROUP BY service_name, revenue_month
       ORDER BY service_name, revenue_month`
    );
    context.monthly_by_service = {};
    monthlyByService.forEach(r => {
      if (!context.monthly_by_service[r.service_name]) context.monthly_by_service[r.service_name] = [];
      context.monthly_by_service[r.service_name].push({ month: r.revenue_month, revenue: Number(r.revenue) });
    });

    // Aggregate per service for achievements (sum overlapping targets)
    const targetAgg = {};
    context.targets.forEach(t => {
      if (!targetAgg[t.service]) targetAgg[t.service] = { total: 0, count: 0, first: t.start, last: t.end };
      targetAgg[t.service].total += t.target;
      targetAgg[t.service].count++;
    });

    context.achievements = Object.entries(targetAgg).map(([svc, agg]) => {
      const actual = revenueMap[svc] || 0;
      const pct = agg.total > 0 ? Math.round((actual / agg.total) * 100) : 0;
      return { service: svc, actual, target: agg.total, achievement_pct: pct, target_count: agg.count, start: agg.first, end: agg.last };
    });
    // Add services with no targets but revenue
    context.services.forEach(s => {
      if (!targetAgg[s.name] && revenueMap[s.name]) {
        context.achievements.push({ service: s.name, actual: revenueMap[s.name], target: 0, achievement_pct: 0, target_count: 0, start: null, end: null });
      }
    });
    // Add services with no data at all
    context.services.forEach(s => {
      if (!context.achievements.find(a => a.service === s.name)) {
        context.achievements.push({ service: s.name, actual: 0, target: 0, achievement_pct: 0, target_count: 0, start: null, end: null });
      }
    });

    const [monthlyTrend] = await pool.execute(
      `SELECT revenue_month, SUM(total_revenue) as revenue FROM partner_revenue GROUP BY revenue_month ORDER BY revenue_month`
    );
    context.monthly_trend = monthlyTrend.map(m => ({ month: m.revenue_month, revenue: Number(m.revenue) }));

    const [topPartners] = await pool.execute(
      `SELECT partner_name, SUM(total_revenue) as total_revenue,
              GROUP_CONCAT(DISTINCT service_name) as services
       FROM partner_revenue GROUP BY partner_name ORDER BY total_revenue DESC LIMIT 10`
    );
    context.top_partners = topPartners.map(p => ({
      name: p.partner_name,
      revenue: Number(p.total_revenue),
      services: p.services,
    }));

    // Per-service alerts (NOT global — each service evaluated individually)
    context.alerts = context.achievements.map(a => ({
      service: a.service,
      achievement: a.achievement_pct,
      actual: a.actual,
      target: a.target,
      gap: a.target > 0 ? a.target - a.actual : 0,
      level: a.target === 0 ? 'no_target'
        : a.achievement_pct >= 90 ? 'on_track'
        : a.achievement_pct >= 70 ? 'warning'
        : a.achievement_pct >= 50 ? 'behind'
        : 'critical',
    }));

    const [userCount] = await pool.execute('SELECT COUNT(*) as cnt FROM users');
    context.user_count = Number(userCount[0]?.cnt || 0);
  } catch (error) {
    console.error('Error building VAS context:', error);
  }

  return context;
}

// ── POST /api/ai/chat — Send message to AI assistant ──────────────────────────
router.post('/chat', async (req, res) => {
  try {
    const { message, history, user_id } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // ── Quota check ────────────────────────────────────────────────────────
    const quota = await checkQuota(user_id);
    if (!quota.allowed) {
      return res.status(429).json({
        error: 'quota_exceeded',
        message: `⚠️ Daily AI quota reached — you have used ${quota.used}/${quota.max} questions today. Please try again tomorrow or ask an admin to increase your limit.`,
        used: quota.used,
        max: quota.max,
      });
    }

    // ── Build context ──────────────────────────────────────────────────────
    const vasContext = await buildVASContext();

    // Build comprehensive context string
    const totalTarget = vasContext.achievements.reduce((s, a) => s + a.target, 0);
    const totalActual = vasContext.achievements.reduce((s, a) => s + a.actual, 0);
    const overallPct = totalTarget > 0 ? Math.round((totalActual / totalTarget) * 100) : 0;
    const totalGap = totalTarget - totalActual;

    // Count alerts by severity
    const critCount = vasContext.alerts.filter(a => a.level === 'critical').length;
    const warnCount = vasContext.alerts.filter(a => a.level === 'warning' || a.level === 'behind').length;
    const onTrackCount = vasContext.alerts.filter(a => a.level === 'on_track').length;
    const noTargetCount = vasContext.alerts.filter(a => a.level === 'no_target').length;

    const contextStr = `
You are the VAS AI Assistant for Ethio Telecom's Value Added Services (VAS) division.
You have COMPLETE access to VAS revenue data and must answer ALL questions thoroughly.
You can provide insights, analysis, recommendations, comparisons, trends, and any other analysis.

CRITICAL RULES — FOLLOW EXACTLY:
1. Use ONLY the numbers provided below. Do NOT fabricate, estimate, or recalculate.
2. Format large numbers as: ETB X.XXB (billions), ETB XXX.XM (millions), ETB XXXK (thousands)
3. If a service has 0 revenue, say 'No revenue data available' — do NOT show percentage as 0%
4. If target is 0, say 'Target not set' — do NOT show achievement as 0% or NaN
5. Always show both the formatted number AND the raw ETB amount when referencing revenue
6. ALWAYS provide a COMPLETE answer — list ALL services, ALL partners, ALL data when asked
7. Never truncate or abbreviate — show every single service and every single partner when asked

══════════════════════════════════════════════════════════════════
OVERALL VAS PERFORMANCE SUMMARY
══════════════════════════════════════════════════════════════════
- Total Revenue (all sources): ${formatETB(vasContext.total_revenue)} (${vasContext.total_revenue.toLocaleString()} ETB)
- Total Target (all services): ${formatETB(totalTarget)} (${totalTarget.toLocaleString()} ETB)
- Overall Achievement: ${overallPct}%
- Total Revenue Gap (target - actual): ${formatETB(totalGap)}
- Total Partners (unique, fuzzy-merged): ${vasContext.partner_count}
- Active VAS Services: ${vasContext.services.length}
- Users: ${vasContext.user_count}
- Alert Summary: ${critCount} CRITICAL, ${warnCount} WARNING, ${onTrackCount} ON TRACK, ${noTargetCount} NO TARGET

══════════════════════════════════════════════════════════════════
DETAILED SERVICE PERFORMANCE (ALL ${vasContext.achievements.length} SERVICES)
══════════════════════════════════════════════════════════════════
${vasContext.achievements.sort((a, b) => b.achievement_pct - a.achievement_pct).map((a, i) => {
  const gap = a.target > 0 ? formatETB(a.target - a.actual) : 'N/A';
  const alertLevel = vasContext.alerts.find(al => al.service === a.service);
  const levelEmoji = alertLevel?.level === 'critical' ? '🔴' : alertLevel?.level === 'behind' ? '🟠' : alertLevel?.level === 'warning' ? '🟡' : alertLevel?.level === 'on_track' ? '🟢' : '⚪';
  let line = `${i + 1}. ${levelEmoji} ${a.service}`;
  if (a.target > 0 && a.actual > 0) {
    line += `: Revenue ${formatETB(a.actual)} | Target ${formatETB(a.target)} | Achievement ${a.achievement_pct}% | Gap ${gap}`;
  } else if (a.target > 0 && a.actual === 0) {
    line += `: No revenue recorded | Target ${formatETB(a.target)} | Achievement 0% | Gap ${gap}`;
  } else if (a.target === 0 && a.actual > 0) {
    line += `: Revenue ${formatETB(a.actual)} | Target not set`;
  } else {
    line += `: No data (no target and no revenue)`;
  }
  if (a.start && a.end) {
    const startD = typeof a.start === 'string' ? a.start.substring(0, 10) : new Date(a.start).toISOString().substring(0, 10);
    const endD = typeof a.end === 'string' ? a.end.substring(0, 10) : new Date(a.end).toISOString().substring(0, 10);
    line += ` | Period: ${startD} to ${endD}`;
  }
  if (a.target_count > 1) line += ` (${a.target_count} target records)`;
  return line;
}).join('\n')}

══════════════════════════════════════════════════════════════════
MONTHLY REVENUE BY SERVICE
══════════════════════════════════════════════════════════════════
${Object.keys(vasContext.monthly_by_service).length > 0 ?
  Object.entries(vasContext.monthly_by_service).map(([svc, months]) =>
    `${svc}:\n${months.map(m => `  ${m.month}: ${formatETB(m.revenue)}`).join('\n')}`
  ).join('\n\n') : 'No monthly data available yet'}

══════════════════════════════════════════════════════════════════
MONTHLY REVENUE TREND (ALL SERVICES COMBINED)
══════════════════════════════════════════════════════════════════
${vasContext.monthly_trend.length > 0 ? vasContext.monthly_trend.map(m => `- ${m.month}: ${formatETB(m.revenue)}`).join('\n') : '- No monthly data available yet'}

══════════════════════════════════════════════════════════════════
TOP 10 PARTNERS BY REVENUE
══════════════════════════════════════════════════════════════════
${vasContext.top_partners.length > 0 ? vasContext.top_partners.map((p, i) => `${i + 1}. ${p.name}: ${formatETB(p.revenue)} (services: ${p.services})`).join('\n') : '- No partner revenue data yet'}

══════════════════════════════════════════════════════════════════
REVENUE ALERTS (per-service assessment)
══════════════════════════════════════════════════════════════════
Severity levels: ON_TRACK (≥90%), WARNING (70-89%), BEHIND (50-69%), CRITICAL (<50%), NO_TARGET (no target set)
${vasContext.alerts.sort((a, b) => a.achievement - b.achievement).map(a => {
  const levelStr = a.level.toUpperCase().replace('_', ' ');
  const gapStr = a.gap > 0 ? `Gap: ${formatETB(a.gap)}` : (a.target === 0 ? 'No target set' : 'On target');
  return `- ${a.service}: ${levelStr} — ${a.achievement}% of target achieved (${gapStr})`;
}).join('\n')}

══════════════════════════════════════════════════════════════════
REVENUE TARGETS BY SERVICE (with date periods)
══════════════════════════════════════════════════════════════════
${vasContext.targets.map(t => {
  const startD = typeof t.start === 'string' ? t.start.substring(0, 10) : new Date(t.start).toISOString().substring(0, 10);
  const endD = typeof t.end === 'string' ? t.end.substring(0, 10) : new Date(t.end).toISOString().substring(0, 10);
  return `- ${t.service}: ${formatETB(t.target)} (${t.period || 'annual'}) from ${startD} to ${endD}`;
}).join('\n')}

══════════════════════════════════════════════════════════════════
ALL VAS SERVICES (including those with no data)
══════════════════════════════════════════════════════════════════
${vasContext.services.map(s => `- ${s.name}`).join('\n')}

INSTRUCTIONS:
- Answer questions about VAS revenue, services, partners, targets, alerts, and trends
- Use ONLY the exact numbers from this context — never fabricate data
- When asked about ALL services, list ALL of them — do not skip or truncate
- When asked about partners, list ALL top 10 partners with full details
- When asked about monthly trends, show ALL months with revenue for EACH service
- CRITICAL alert means the service is below 50% of its target — NOT that the target is missing
- Be concise, professional, and data-driven
- If asked about something not in this data, say so honestly
- Always format currency properly (e.g., ETB 1.63B not 1628048738)
- When asked about underperforming services, show each service's achievement percentage and the gap between actual and target
- When asked for recommendations, base them on the actual data — suggest specific actions for specific underperforming services
`;

    // ── Model fallback + retry ─────────────────────────────────────────────
    // Measured behaviour of the 503 "high demand" responses: they are transient
    // and per request rather than per model — a model answering 503 very often
    // answers normally seconds later, and the retry lands on a different API
    // key. So the request walks a plan that cycles the model chain with a short
    // pause between attempts, instead of giving up on the first spike. 429s are
    // genuinely per API key, so those rotate the key and retry.
    let lastError = null;
    const attemptPlan = buildAttemptPlan();

    for (let attempt = 0; attempt < attemptPlan.length; attempt++) {
      const modelName = attemptPlan[attempt];
      const { client, keyIndex } = getActiveClient();

      if (attempt > 0) await sleepForRetry(attempt);

      try {
        const model = client.getGenerativeModel({ model: modelName });
        const chat = buildChat(model, history, contextStr);
        const result = await sendMessageWithRetry(chat, message, keyIndex);
        const reply = result.response.text();

        if (attempt > 0) {
          console.log(`[AI] Answered by ${modelName} after ${attempt + 1} attempts`);
        }

        // Success — increment usage
        await incrementUsage(user_id);

        const remaining = quota.max - (quota.used + 1);
        return res.json({
          reply,
          timestamp: new Date().toISOString(),
          quota: { used: quota.used + 1, max: quota.max, remaining: Math.max(0, remaining) },
        });
      } catch (apiErr) {
        lastError = apiErr;
        if (isRateLimitErr(apiErr)) {
          console.warn(`[AI] Key #${keyIndex + 1} rate-limited (429), rotating to next key...`);
          markKeyRateLimited(keyIndex, 60000); // cooldown 1 min
          continue; // same model, different key
        }
        if (isNetworkErr(apiErr)) {
          console.warn(`[AI] Key #${keyIndex + 1} unreachable after retries, rotating to next key...`);
          continue; // network flake — give the next key (same endpoint) a chance
        }
        if (isOverloadedErr(apiErr)) {
          console.warn(`[AI] ${modelName} reported high demand (attempt ${attempt + 1}/${attemptPlan.length}), retrying...`);
          markModelOverloaded(modelName);
          continue; // the plan's next entry is usually a different model
        }
        // Non-transient error (bad request, safety block, ...) — throw immediately
        throw apiErr;
      }
    }

    // Every model/key combination failed
    throw lastError || new Error('All API keys exhausted');
  } catch (error) {
    console.error('AI chat error:', error);
    if (isNetworkErr(error)) {
      return res.status(503).json({
        error: 'AI assistant error',
        message: 'The AI service is unreachable from the server right now (network). Please try again in a moment.',
      });
    }
    if (isRateLimitErr(error) || /All API keys/i.test(error.message || '')) {
      return res.status(429).json({
        error: 'quota_exceeded',
        message: 'All AI keys are rate-limited right now. Please try again in a minute.',
      });
    }
    if (isOverloadedErr(error)) {
      return res.status(503).json({
        error: 'ai_busy',
        message: 'The AI models are all busy right now (high demand). Please try again in a minute.',
      });
    }
    // Never surface the raw SDK error to the user — it is already logged above.
    res.status(500).json({
      error: 'AI assistant error',
      message: 'The AI assistant could not answer that. Please try again.',
    });
  }
});

// ── GET /api/ai/quota — Check current user's quota ────────────────────────────
router.get('/quota', async (req, res) => {
  try {
    const userId = req.query.user_id;
    const quota = await checkQuota(userId);
    res.json(quota);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/ai/suggestions — Get suggested questions ─────────────────────────
router.get('/suggestions', async (req, res) => {
  try {
    const context = await buildVASContext();
    const critCount = context.alerts.filter(a => a.level === 'critical').length;
    const warnCount = context.alerts.filter(a => a.level === 'warning').length;

    const suggestions = [
      'What is the overall revenue achievement percentage?',
      `Which services are critically underperforming? (${critCount} critical)`,
      'What are the top 3 partners by revenue?',
      `How is the monthly revenue trend looking?`,
      'Which service has the best achievement rate?',
      `What is the total revenue gap across all services?`,
    ];

    res.json({ suggestions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/ai/usage-report — Full usage report across all users ────────────
router.get('/usage-report', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    // Default: last 30 days
    const end = end_date || todayStr();
    const startDefault = new Date();
    startDefault.setDate(startDefault.getDate() - 30);
    const start = start_date || `${startDefault.getFullYear()}-${String(startDefault.getMonth() + 1).padStart(2, '0')}-${String(startDefault.getDate()).padStart(2, '0')}`;

    // 1. Per-user summary: total questions used, daily limit, usage by date
    const [userUsage] = await pool.execute(
      `SELECT 
        u.id, u.full_name, u.username, u.email, u.status,
        COALESCE(u.max_ai_questions_per_day, 50) as daily_limit,
        COALESCE(SUM(au.question_count), 0) as total_questions,
        COUNT(DISTINCT au.query_date) as active_days,
        MAX(au.question_count) as peak_daily_usage,
        MIN(au.query_date) as first_usage,
        MAX(au.query_date) as last_usage
       FROM users u
       LEFT JOIN ai_usage au ON u.id = au.user_id 
         AND au.query_date >= ? AND au.query_date <= ?
       WHERE u.status = 'active'
       GROUP BY u.id, u.full_name, u.username, u.email, u.status, u.max_ai_questions_per_day
       ORDER BY total_questions DESC`
    , [start, end]);

    // 2. Daily usage trend (all users combined)
    const [dailyTrend] = await pool.execute(
      `SELECT query_date, SUM(question_count) as total_questions, 
              COUNT(DISTINCT user_id) as active_users
       FROM ai_usage
       WHERE query_date >= ? AND query_date <= ?
       GROUP BY query_date
       ORDER BY query_date`
    , [start, end]);

    // 3. Top users ranking
    const [topUsers] = await pool.execute(
      `SELECT u.full_name, u.username, SUM(au.question_count) as total_questions,
              COALESCE(u.max_ai_questions_per_day, 50) as daily_limit
       FROM ai_usage au
       JOIN users u ON au.user_id = u.id
       WHERE au.query_date >= ? AND au.query_date <= ?
       GROUP BY au.user_id, u.full_name, u.username, u.max_ai_questions_per_day
       ORDER BY total_questions DESC
       LIMIT 10`
    , [start, end]);

    // 4. Summary stats
    const totalQuestions = userUsage.reduce((sum, u) => sum + Number(u.total_questions), 0);
    const totalActiveUsers = userUsage.filter(u => Number(u.total_questions) > 0).length;
    const totalUsers = userUsage.length;
    const avgPerUser = totalActiveUsers > 0 ? Math.round(totalQuestions / totalActiveUsers) : 0;
    const maxDailySum = dailyTrend.reduce((max, d) => Math.max(max, Number(d.total_questions)), 0);
    const peakDay = dailyTrend.find(d => Number(d.total_questions) === maxDailySum);

    // 5. Quota exhaustion count — users who hit their daily limit
    const [exhaustions] = await pool.execute(
      `SELECT au.user_id, u.full_name, COUNT(*) as times_exhausted
       FROM ai_usage au
       JOIN users u ON au.user_id = u.id
       JOIN (
         SELECT user_id, MAX(COALESCE((SELECT max_ai_questions_per_day FROM users WHERE id = au2.user_id), 50)) as limit_val
         FROM ai_usage au2
         GROUP BY user_id
       ) limits ON au.user_id = limits.user_id
       WHERE au.question_count >= limits.limit_val
         AND au.query_date >= ? AND au.query_date <= ?
       GROUP BY au.user_id, u.full_name
       ORDER BY times_exhausted DESC`
    , [start, end]);

    res.json({
      summary: {
        total_questions: totalQuestions,
        total_active_users: totalActiveUsers,
        total_users: totalUsers,
        avg_per_active_user: avgPerUser,
        peak_daily_total: maxDailySum,
        peak_day: peakDay?.query_date || null,
        date_range: { start, end },
      },
      user_usage: userUsage.map(u => ({
        user_id: u.id,
        full_name: u.full_name,
        username: u.username,
        email: u.email,
        daily_limit: Number(u.daily_limit),
        total_questions: Number(u.total_questions),
        active_days: Number(u.active_days),
        peak_daily: Number(u.peak_daily_usage || 0),
        first_usage: u.first_usage,
        last_usage: u.last_usage,
        avg_per_day: u.active_days > 0 ? Math.round(Number(u.total_questions) / Number(u.active_days)) : 0,
        usage_pct: Math.round((Number(u.total_questions) / (Number(u.active_days) || 1) / Number(u.daily_limit || 50)) * 100),
      })),
      daily_trend: dailyTrend.map(d => ({
        date: d.query_date,
        questions: Number(d.total_questions),
        active_users: Number(d.active_users),
      })),
      top_users: topUsers.map(u => ({
        name: u.full_name,
        username: u.username,
        total: Number(u.total_questions),
        daily_limit: Number(u.daily_limit),
      })),
      exhaustions: exhaustions.map(e => ({
        user_id: e.user_id,
        full_name: e.full_name,
        times_exhausted: Number(e.times_exhausted),
      })),
    });
  } catch (error) {
    console.error('Usage report error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/ai/history — Get chat history for a user ─────────────────────────
router.get('/history', async (req, res) => {
  try {
    const userId = req.query.user_id;
    const sessionId = req.query.session_id;
    const limit = parseInt(req.query.limit) || 100;

    if (!userId) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    let query = 'SELECT * FROM ai_chat_history WHERE user_id = ?';
    const params = [userId];

    if (sessionId) {
      query += ' AND session_id = ?';
      params.push(sessionId);
    }

    query += ' ORDER BY created_at ASC LIMIT ?';
    params.push(limit);

    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Chat history error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/ai/history/sessions — Get user's chat sessions ──────────────────
router.get('/history/sessions', async (req, res) => {
  try {
    const userId = req.query.user_id;
    if (!userId) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const [rows] = await pool.execute(
      `SELECT session_id, 
              MIN(created_at) as started_at, 
              MAX(created_at) as last_message_at,
              COUNT(*) as message_count,
              SUBSTRING_INDEX(SUBSTRING_INDEX(
                (SELECT content FROM ai_chat_history WHERE user_id = ? AND session_id = ah.session_id AND role = 'user' ORDER BY created_at ASC LIMIT 1),
                '\n', 1
              ), '\n', -1) as first_question
       FROM ai_chat_history ah
       WHERE user_id = ?
       GROUP BY session_id
       ORDER BY last_message_at DESC`
    , [userId, userId]);
    res.json(rows);
  } catch (error) {
    console.error('Chat sessions error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/ai/history — Save a single chat message ────────────────────────
router.post('/history', async (req, res) => {
  try {
    const { user_id, session_id, role, content } = req.body;
    if (!user_id || !session_id || !role || !content) {
      return res.status(400).json({ error: 'user_id, session_id, role, and content are required' });
    }

    await pool.execute(
      'INSERT INTO ai_chat_history (user_id, session_id, role, content) VALUES (?, ?, ?, ?)',
      [user_id, session_id, role, content]
    );

    // Auto-delete messages older than 7 days
    await pool.execute(
      'DELETE FROM ai_chat_history WHERE created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)'
    );

    const [count] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM ai_chat_history WHERE user_id = ? AND session_id = ?',
      [user_id, session_id]
    );

    res.json({ saved: true, total: count[0].cnt });
  } catch (error) {
    console.error('Save chat history error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /api/ai/history/:sessionId — Delete a chat session ────────────────
router.delete('/history/:sessionId', async (req, res) => {
  try {
    const userId = req.query.user_id;
    const sessionId = req.params.sessionId;
    if (!userId) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    await pool.execute(
      'DELETE FROM ai_chat_history WHERE user_id = ? AND session_id = ?',
      [userId, sessionId]
    );

    res.json({ message: 'Session deleted' });
  } catch (error) {
    console.error('Delete chat history error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/ai/api-keys — API key pool status ─────────────────────────────
router.get('/api-keys', async (req, res) => {
  try {
    const now = Date.now();
    const keys = API_KEYS.map((key, idx) => {
      const masked = key.substring(0, 8) + '...' + key.substring(key.length - 4);
      const cooldownEnd = keyCooldownUntil[idx];
      const isCoolingDown = now < cooldownEnd;
      const cooldownRemainingSec = isCoolingDown ? Math.ceil((cooldownEnd - now) / 1000) : 0;
      const isActive = idx === ((currentKeyIndex - 1 + API_KEYS.length) % API_KEYS.length) && !isCoolingDown;

      return {
        key_index: idx + 1,
        masked_key: masked,
        status: isCoolingDown ? 'rate_limited' : isActive ? 'active' : 'standby',
        cooldown_remaining_sec: cooldownRemainingSec,
        cooldown_end: isCoolingDown ? new Date(cooldownEnd).toISOString() : null,
      };
    });

    const activeCount = keys.filter(k => k.status === 'active').length;
    const rateLimitedCount = keys.filter(k => k.status === 'rate_limited').length;
    const standbyCount = keys.filter(k => k.status === 'standby').length;

    res.json({
      total_keys: API_KEYS.length,
      active_keys: activeCount,
      rate_limited_keys: rateLimitedCount,
      standby_keys: standbyCount,
      current_key_index: currentKeyIndex,
      keys,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
