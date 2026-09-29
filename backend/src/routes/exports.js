const express = require('express');
const router = express.Router();
const PptxGenJS = require('pptxgenjs');
const pool = require('../config/database');
const { requirePermission } = require('../middleware/permissions');
const { wrapWithTemplate, extractTemplateLogo } = require('../pptxMerge');
const { ensureFooterCrops } = require('../pptFooter');
const fs = require('fs');
const path = require('path');

// Helper: build date filter for revenue_month columns
function buildFilter(start_date, end_date, period_value, alias) {
  let filter = '';
  const params = [];
  const col = alias ? `${alias}.revenue_month` : 'revenue_month';
  if (start_date && end_date) {
    const startMonth = start_date.substring(0, 7);
    const endMonth = end_date.substring(0, 7);
    filter = `WHERE ${col} >= ? AND ${col} <= ?`;
    params.push(startMonth, endMonth);
  } else if (period_value) {
    filter = `WHERE ${col} = ?`;
    params.push(period_value);
  }
  return { filter, params };
}

// Helper: fetch ALL data from every database table
async function fetchAllData(start_date, end_date, period_value) {
  const { filter, params } = buildFilter(start_date, end_date, period_value);
  const { filter: arFilter, params: arParams } = buildFilter(start_date, end_date, period_value, 'ar');

  // Inactive services are hidden from every module — exclude them from
  // export totals, lists and achievements.
  const [revRows] = await pool.execute(
    `SELECT COALESCE(SUM(total_revenue), 0) as total_revenue,
            COALESCE(SUM(ethio_share), 0) as ethio_share,
            COUNT(DISTINCT partner_name) as partner_count
     FROM partner_revenue ${filter ? filter + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'}`, params
  );
  const [actRows] = await pool.execute(
    `SELECT COALESCE(SUM(ar.amount), 0) as total_revenue, COUNT(DISTINCT ar.partner_name) as partner_count
     FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arFilter ? arFilter + ' AND vs.status = \'active\'' : 'WHERE vs.status = \'active\''}`, arParams
  );
  const totalRevenue = Number(revRows[0]?.total_revenue || 0) + Number(actRows[0]?.total_revenue || 0);
  const totalPartners = Number(revRows[0]?.partner_count || 0) + Number(actRows[0]?.partner_count || 0);

  const [allServices] = await pool.execute("SELECT * FROM vas_services WHERE status = 'active' ORDER BY name");
  const [allCategories] = await pool.execute('SELECT * FROM vas_categories ORDER BY name');

  let targetFilter = '';
  const targetParams = [];
  if (start_date && end_date) {
    targetFilter = 'WHERE target_start_date <= ? AND target_end_date >= ?';
    targetParams.push(end_date, start_date);
  } else if (period_value) {
    targetFilter = 'WHERE period_value = ?';
    targetParams.push(period_value);
  }
  const [allTargets] = await pool.execute(
    `SELECT rt.*, COALESCE(vs.name, rt.service_name) as service_name
     FROM revenue_targets rt
     LEFT JOIN vas_services vs ON rt.service_id = vs.id
     ${targetFilter ? targetFilter + ' AND (rt.service_id IS NULL OR vs.status = \'active\')' : 'WHERE rt.service_id IS NULL OR vs.status = \'active\''} ORDER BY rt.service_name`,
    targetParams
  );

  // Mode-aware target map: manual-allocation targets contribute their admin-set
  // monthly allocations for the window; automatic targets keep the legacy
  // "sum of overlapping target amounts" behaviour.
  const { resolveMonthlyTargets, sumMonthly } = require('../utils/targetCalculator');
  const manualNames = new Set(allTargets.filter(t => t.allocation_mode === 'manual').map(t => t.service_name));
  const targetMonthly = await resolveMonthlyTargets(allTargets, {
    startMonth: start_date ? start_date.substring(0, 7) : (period_value || null),
    endMonth: end_date ? end_date.substring(0, 7) : (period_value || null),
  });
  const manualTotals = sumMonthly(targetMonthly);

  const targetMap = {};
  allTargets.forEach(t => {
    if (t.allocation_mode === 'manual') return;
    targetMap[t.service_name] = (targetMap[t.service_name] || 0) + Number(t.target_amount);
  });
  for (const [svc, amt] of Object.entries(manualTotals)) {
    if (manualNames.has(svc)) targetMap[svc] = amt;
  }

  const [serviceData] = await pool.execute(
    `SELECT service_name, COALESCE(SUM(total_revenue), 0) as actual_amount FROM partner_revenue ${filter ? filter + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'} GROUP BY service_name`, params
  );
  const [manualData] = await pool.execute(
    `SELECT vs.name as service_name, COALESCE(SUM(ar.amount), 0) as actual_amount
     FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arFilter ? arFilter + ' AND vs.status = \'active\'' : 'WHERE vs.status = \'active\''} GROUP BY vs.name`, arParams
  );

  const revenueMap = {};
  serviceData.forEach(r => { revenueMap[r.service_name] = (revenueMap[r.service_name] || 0) + Number(r.actual_amount); });
  manualData.forEach(r => { revenueMap[r.service_name] = (revenueMap[r.service_name] || 0) + Number(r.actual_amount); });

  const serviceAchievements = allServices.map(s => {
    const actual = Number(revenueMap[s.name] || 0);
    const target = Number(targetMap[s.name] || 0);
    const pct = target > 0 ? Math.round((actual / target) * 100) : 0;
    return { name: s.name, actual, target, achievement: pct };
  }).filter(s => s.target > 0);

  const totalTarget = serviceAchievements.reduce((sum, s) => sum + Number(s.target), 0);

  const [monthlyTrend] = await pool.execute(
    `SELECT revenue_month, SUM(total_revenue) as revenue FROM partner_revenue WHERE service_name IN (SELECT name FROM vas_services WHERE status = 'active') GROUP BY revenue_month ORDER BY revenue_month`, []
  );

  // per-service monthly actual revenue (partner + manual) — used for goal cascading
  const [svcMonthlyPartner] = await pool.execute(
    `SELECT service_name, revenue_month, SUM(total_revenue) as revenue
     FROM partner_revenue ${filter ? filter + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'} GROUP BY service_name, revenue_month`, params
  );
  const [svcMonthlyManual] = await pool.execute(
    `SELECT vs.name as service_name, ar.revenue_month, SUM(ar.amount) as revenue
     FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arFilter ? arFilter + ' AND vs.status = \'active\'' : 'WHERE vs.status = \'active\''}
     GROUP BY vs.name, ar.revenue_month`, arParams
  );
  const svcMonthlyMap = {};
  svcMonthlyPartner.forEach(r => {
    const k = `${r.service_name}|${r.revenue_month}`;
    svcMonthlyMap[k] = (svcMonthlyMap[k] || 0) + Number(r.revenue);
  });
  svcMonthlyManual.forEach(r => {
    const k = `${r.service_name}|${r.revenue_month}`;
    svcMonthlyMap[k] = (svcMonthlyMap[k] || 0) + Number(r.revenue);
  });
  const serviceMonthly = Object.entries(svcMonthlyMap).map(([k, revenue]) => {
    const [service_name, revenue_month] = k.split('|');
    return { service_name, revenue_month, revenue };
  });

  const [topPartners] = await pool.execute(
    `SELECT partner_name, SUM(total_revenue) as total_revenue,
            GROUP_CONCAT(DISTINCT service_name) as services
     FROM partner_revenue ${filter ? filter + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'} GROUP BY partner_name ORDER BY total_revenue DESC LIMIT 10`, params
  );

  const [allPartnerRevenue] = await pool.execute(
    `SELECT partner_name, service_name, total_revenue, ethio_share, revenue_month
     FROM partner_revenue ${filter ? filter + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'} ORDER BY revenue_month, service_name, total_revenue DESC`, params
  );

  const [allManualRevenue] = await pool.execute(
    `SELECT ar.partner_name, vs.name as service_name, ar.amount, ar.revenue_month, ar.source, ar.notes
     FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arFilter} ORDER BY ar.revenue_month, vs.name`, arParams
  );

  const [allActions] = await pool.execute('SELECT * FROM action_notes ORDER BY created_at DESC LIMIT 20');
  const [allUsers] = await pool.execute(
    `SELECT u.id, u.full_name, u.email, u.department, u.section, u.division, u.status,
            r.name as role_name
     FROM users u LEFT JOIN roles r ON u.role_id = r.id ORDER BY u.full_name`
  );
  const [userCount] = await pool.execute('SELECT COUNT(*) as cnt FROM users');
  let allImports = [];
  try { [allImports] = await pool.execute('SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 10'); } catch (e) {}
  const [chatStats] = await pool.execute('SELECT COUNT(*) as msg_count FROM chat_messages');
  const [smsStats] = await pool.execute('SELECT COUNT(*) as sent FROM sms_messages');

  let alertData = [];
  for (const sa of serviceAchievements) {
    let alertLevel = 'on_track';
    if (sa.achievement < 50) alertLevel = 'critical';
    else if (sa.achievement < 90) alertLevel = 'warning';
    alertData.push({ service: sa.name, achievement: sa.achievement, level: alertLevel, actual: sa.actual, target: sa.target });
  }

  return {
    kpis: {
      total_revenue: totalRevenue, ethio_share: revRows[0]?.ethio_share || 0,
      partner_count: totalPartners, service_count: allServices.length,
      total_target: totalTarget,
      achievement: totalTarget > 0 ? Math.round((totalRevenue / totalTarget) * 100) : 0,
      user_count: userCount[0]?.cnt || 0, action_count: allActions.length,
      import_count: allImports?.length || 0,
    },
    allServices, allCategories, allTargets, serviceAchievements, monthlyTrend, serviceMonthly,
    topPartners, allPartnerRevenue, allManualRevenue, alertData,
    allActions, allUsers, allImports,
    chatStats: chatStats[0], smsStats: smsStats[0],
  };
}


// Style helpers
const GREEN = '1B5E20';
const LIGHT_GREEN = '4CAF50';
const RED = 'DC2626';
const AMBER = 'D97706';
const BLUE = '1565C0';
const PURPLE = '6A1B9A';
const DARK = '1E293B';
const GRAY = '64748B';
const LIGHT_BG = 'F8FAFC';

function hdr(text, color) {
  return { text, options: { bold: true, color: 'FFFFFF', fill: { color: color || GREEN }, fontSize: 9, fontFace: 'Calibri' } };
}
function c(text, opts) {
  return { text: String(text ?? '-'), options: { fontSize: 8, color: DARK, fontFace: 'Calibri', ...opts } };
}

// Ethio Telecom logo path — set at the start of every /pptx request. Every
// generated *report* slide shows it (intro pages already carry their own).
let LOGO_PATH = null;
// Footer decoration pieces cropped from the user-provided graphic: the blue
// bar bottom-left and the red/green/yellow cluster bottom-right.
let FOOTER_LEFT = null;
let FOOTER_RIGHT = null;
function footerBrand(slide) {
  if (FOOTER_LEFT && FOOTER_RIGHT && fs.existsSync(FOOTER_LEFT) && fs.existsSync(FOOTER_RIGHT)) {
    slide.addImage({ path: FOOTER_LEFT, x: 0.1, y: 7.12, w: 1.05, h: 0.34, sizing: { type: 'contain', w: 1.05, h: 0.34 } });
    slide.addImage({ path: FOOTER_RIGHT, x: 11.72, y: 6.98, w: 1.5, h: 0.52, sizing: { type: 'contain', w: 1.5, h: 0.52 } });
  }
}
function sectionTitle(slide, title) {
  footerBrand(slide);
  if (LOGO_PATH && fs.existsSync(LOGO_PATH)) {
    // official Ethio Telecom logo (922x280) — box matches its aspect ratio
    slide.addImage({ path: LOGO_PATH, x: 0.34, y: 0.1, w: 1.9, h: 0.58, sizing: { type: 'contain', w: 1.9, h: 0.58 } });
  }
  slide.addText(title, { x: 2.62, y: 0.18, w: 10.4, h: 0.45, fontSize: 20, color: GREEN, bold: true, fontFace: 'Calibri' });
  slide.addShape('rect', { x: 2.62, y: 0.66, w: 2, h: 0.03, fill: { color: GREEN } });
}

// ============================================
// EXPORT AS POWERPOINT — FULLY GENERATED
// ============================================
router.get('/pptx', requirePermission('reports.export'), async (req, res) => {
  try {
    const { start_date, end_date, period } = req.query;
    const data = await fetchAllData(start_date, end_date, period);

    // Make the Ethio Telecom logo available for report slides (extracted once
    // from the official template; intro pages keep their own logos).
    const LOGO_FILE = path.join(__dirname, '..', 'assets', '_ethio_logo.png');
    if (!fs.existsSync(LOGO_FILE)) {
      try { await extractTemplateLogo(LOGO_FILE); } catch (e) { console.error('Logo extract failed:', e.message); }
    }
    LOGO_PATH = fs.existsSync(LOGO_FILE) ? LOGO_FILE : null;

    // Footer decoration (blue bottom-left + red/green/yellow bottom-right)
    const foot = ensureFooterCrops();
    FOOTER_LEFT = foot ? foot.left : null;
    FOOTER_RIGHT = foot ? foot.right : null;

    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'VAS Performance Tracker';
    pptx.company = 'Ethio Telecom';
    pptx.subject = 'VAS Revenue Comprehensive Report';

    const reportDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const periodText = start_date && end_date ? `${start_date} to ${end_date}` : 'All Time';

    // ---------- derived analytics shared by the report slides ----------
    const mfmt = v => {
      const n = Number(v) || 0;
      if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
      if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
      return Math.round(n).toLocaleString();
    };
    const pct1 = v => `${(Number(v) || 0).toFixed(1)}%`;
    const statusOf = a => (a >= 90 ? 'On Track' : a >= 50 ? 'Warning' : 'Critical');
    const colorOf = a => (a >= 90 ? GREEN : a >= 50 ? AMBER : RED);

    // per-service monthly actual revenue keyed "service|YYYY-MM"
    const svcMonthMap = {};
    (data.serviceMonthly || []).forEach(r => {
      const k = `${r.service_name}|${r.revenue_month}`;
      svcMonthMap[k] = (svcMonthMap[k] || 0) + Number(r.revenue);
    });
    const monthNum = m => +(String(m).slice(5, 7));
    const sumInMonths = (svc, nums) => {
      let s = 0;
      Object.keys(svcMonthMap).forEach(k => {
        const [sn, mon] = k.split('|');
        if (sn === svc && nums.includes(monthNum(mon))) s += svcMonthMap[k];
      });
      return s;
    };
    // Goal-cascading rows: yearly / semi-annual / quarterly targets (equal
    // monthly split across the target span) vs actual revenue per period.
    const gcRows = (data.serviceAchievements || []).map(sa => {
      const tgtRows = (data.allTargets || []).filter(t => t.service_name === sa.name);
      const totalTgt = tgtRows.reduce((s, t) => s + Number(t.target_amount || 0), 0);
      let spanMonths = 12;
      if (tgtRows.length) {
        const ys = tgtRows.map(t => (t.target_start_date ? +String(t.target_start_date).slice(0, 4) : null)).filter(x => x !== null);
        const ye = tgtRows.map(t => (t.target_end_date ? +String(t.target_end_date).slice(0, 4) : null)).filter(x => x !== null);
        if (ys.length && ye.length) {
          const minY = Math.min(...ys), maxY = Math.max(...ye);
          if (isFinite(minY) && isFinite(maxY) && maxY >= minY) spanMonths = (maxY - minY + 1) * 12;
        }
      }
      const monthlyTgt = spanMonths > 0 ? totalTgt / spanMonths : 0;
      const qT = [1, 2, 3, 4].map(() => monthlyTgt * 3);
      const h1T = monthlyTgt * 6, h2T = monthlyTgt * 6;
      const qA = [sumInMonths(sa.name, [1, 2, 3]), sumInMonths(sa.name, [4, 5, 6]), sumInMonths(sa.name, [7, 8, 9]), sumInMonths(sa.name, [10, 11, 12])];
      const h1A = sumInMonths(sa.name, [1, 2, 3, 4, 5, 6]);
      const h2A = sumInMonths(sa.name, [7, 8, 9, 10, 11, 12]);
      const yearA = Number(sa.actual) || 0;
      return {
        name: sa.name, target: totalTgt, actual: yearA, ach: sa.achievement,
        monthlyTgt, h1A, h2A,
        h1Pct: h1T > 0 ? Math.round((h1A / h1T) * 100) : 0,
        h2Pct: h2T > 0 ? Math.round((h2A / h2T) * 100) : 0,
        qA, qT,
        qPct: qT.map((t, i) => (t > 0 ? Math.round((qA[i] / t) * 100) : 0)),
      };
    });

    // ==========================================
    // SLIDE 1: TITLE PAGE (internal deck only — skipped in final merge)
    // ==========================================
    let slide = pptx.addSlide();
    slide.background = { color: DARK };
    slide.addShape('rect', { x: 0, y: 0, w: '100%', h: 0.8, fill: { color: GREEN } });
    slide.addShape('rect', { x: 0, y: 6.5, w: '100%', h: 0.75, fill: { color: GREEN } });
    slide.addText('VAS Performance Tracker', { x: 0.5, y: 1.8, w: 12, h: 1, fontSize: 36, color: 'FFFFFF', bold: true, fontFace: 'Calibri' });
    slide.addText('Ethio Telecom — Value Added Services Division', { x: 0.5, y: 2.8, w: 12, h: 0.6, fontSize: 18, color: '94A3B8', fontFace: 'Calibri' });
    slide.addText('Comprehensive Revenue Performance Report', { x: 0.5, y: 3.5, w: 12, h: 0.5, fontSize: 16, color: LIGHT_GREEN, fontFace: 'Calibri' });
    slide.addText(`Report Period: ${periodText}`, { x: 0.5, y: 4.5, w: 12, h: 0.4, fontSize: 14, color: '94A3B8', fontFace: 'Calibri' });
    slide.addText(`Generated: ${reportDate}`, { x: 0.5, y: 5.0, w: 12, h: 0.4, fontSize: 14, color: '94A3B8', fontFace: 'Calibri' });
    slide.addText('CONFIDENTIAL — For Internal Use Only', { x: 0.5, y: 6.7, w: 12, h: 0.4, fontSize: 10, color: 'FFFFFF', italic: true, align: 'center', fontFace: 'Calibri' });

    // ==========================================
    // SLIDE 2: TABLE OF CONTENTS (internal deck only — skipped in final merge)
    // ==========================================
    slide = pptx.addSlide();
    slide.background = { color: LIGHT_BG };
    sectionTitle(slide, 'Table of Contents');
    const tocItems = [
      '1.  Service Targets — Overview & Monthly Coverage',
      '2.  Achievement Scores — Status & Target vs Actual',
      '3.  Alerted Services — Status & Gap Priority',
      '4.  Variance Analysis — Overview & Monthly Drivers',
      '5.  Goal Cascading — Yearly, Semi-Annual & Quarterly',
      '6.  Ranking — Top Partners & Services by Revenue',
    ];
    tocItems.forEach((item, i) => {
      const y = 1.0 + i * 0.45;
      slide.addShape('rect', { x: 0.4, y, w: 12, h: 0.4, fill: { color: i % 2 === 0 ? 'FFFFFF' : 'F1F5F9' }, rectRadius: 0.05 });
      slide.addText(item, { x: 0.7, y, w: 12, h: 0.4, fontSize: 12, color: DARK, fontFace: 'Calibri' });
    });

    // ==========================================
    // SLIDE 3: SERVICE TARGETS — OVERVIEW
    // ==========================================
    {
      const sorted = (data.serviceAchievements || []).slice().sort((a, b) => b.target - a.target).slice(0, 13);
      slide = pptx.addSlide();
      slide.background = { color: LIGHT_BG };
      sectionTitle(slide, 'Service Targets — Overview');
      const rows = [[hdr('Service'), hdr('Annual Target (ETB)'), hdr('Monthly Expectation'), hdr('Period'), hdr('Status')]];
      sorted.forEach(s => {
        rows.push([
          c(s.name, { bold: true }),
          c(`ETB ${mfmt(s.target)}`, { align: 'right' }),
          c(`ETB ${mfmt(Number(s.target) / 12)}`, { align: 'right' }),
          c(periodText, { align: 'center' }),
          c(statusOf(s.achievement), { color: colorOf(s.achievement), bold: true, align: 'center' }),
        ]);
      });
      slide.addTable(rows, { x: 0.3, y: 0.9, w: 12.4, border: { type: 'solid', pt: 0.5, color: 'E0E0E0' }, colW: [4.4, 2.5, 2.5, 1.6, 1.4], autoPage: false });
      const tLabels = sorted.map(s => (s.name.length > 16 ? s.name.substring(0, 16) + '...' : s.name));
      slide.addChart(pptx.charts.BAR, [{ name: 'Annual Target (ETB M)', labels: tLabels, values: sorted.map(s => Number(s.target) / 1e6) }], {
        x: 0.3, y: 4.9, w: 12.4, h: 1.85,
        showValue: true, valueFontSize: 8, valueFontColor: DARK,
        chartColors: [BLUE], catAxisLabelColor: DARK, catAxisLabelFontSize: 8, valAxisLabelColor: GRAY,
      });
    }

    // ==========================================
    // SLIDE 4: SERVICE TARGETS — MONTHLY COVERAGE
    // ==========================================
    {
      const sorted = (data.serviceAchievements || []).slice().sort((a, b) => b.target - a.target).slice(0, 13);
      slide = pptx.addSlide();
      slide.background = { color: LIGHT_BG };
      sectionTitle(slide, 'Service Targets — Monthly Coverage');
      const rows = [[hdr('Service'), hdr('Monthly Target'), hdr('Avg Monthly Actual'), hdr('Coverage')]];
      sorted.forEach(s => {
        const mt = Number(s.target) / 12;
        const avgAct = Number(s.actual) / 12;
        const cov = mt > 0 ? Math.round((avgAct / mt) * 100) : 0;
        rows.push([
          c(s.name, { bold: true }),
          c(`ETB ${mfmt(mt)}`, { align: 'right' }),
          c(`ETB ${mfmt(avgAct)}`, { align: 'right' }),
          c(`${cov}%`, { color: colorOf(cov), bold: true, align: 'center' }),
        ]);
      });
      slide.addTable(rows, { x: 0.3, y: 0.9, w: 12.4, border: { type: 'solid', pt: 0.5, color: 'E0E0E0' }, colW: [4.4, 2.8, 2.8, 2.4], autoPage: false });
      const lbls = sorted.map(s => (s.name.length > 14 ? s.name.substring(0, 14) + '...' : s.name));
      slide.addChart(pptx.charts.BAR, [
        { name: 'Monthly Target (ETB M)', labels: lbls, values: sorted.map(s => Number(s.target) / 12 / 1e6) },
        { name: 'Avg Monthly Actual (ETB M)', labels: lbls, values: sorted.map(s => Number(s.actual) / 12 / 1e6) },
      ], {
        x: 0.3, y: 4.6, w: 12.4, h: 2.1,
        barGrouping: 'clustered', chartColors: [BLUE, GREEN],
        legendPos: 't', legendFontSize: 9, catAxisLabelColor: DARK, catAxisLabelFontSize: 8, valAxisLabelColor: GRAY,
      });
    }

    // ==========================================
    // SLIDE 5: ACHIEVEMENT SCORES — STATUS OVERVIEW
    // ==========================================
    {
      const svcs = (data.serviceAchievements || []).slice().sort((a, b) => b.achievement - a.achievement);
      const onT = svcs.filter(s => s.achievement >= 90).length;
      const warn = svcs.filter(s => s.achievement >= 50 && s.achievement < 90).length;
      const crit = svcs.filter(s => s.achievement < 50).length;
      const avgA = svcs.length ? svcs.reduce((s, x) => s + x.achievement, 0) / svcs.length : 0;
      slide = pptx.addSlide();
      slide.background = { color: LIGHT_BG };
      sectionTitle(slide, 'Achievement Scores — Status Overview');
      [
        { label: 'On Track (≥90%)', count: onT, color: GREEN, x: 0.4 },
        { label: 'Warning (50–89%)', count: warn, color: AMBER, x: 4.5 },
        { label: 'Critical (<50%)', count: crit, color: RED, x: 8.6 },
      ].forEach(cd => {
        slide.addShape('rect', { x: cd.x, y: 0.9, w: 3.9, h: 1.05, fill: { color: 'FFFFFF' }, shadow: { type: 'outer', blur: 2, offset: 1, color: '000000', opacity: 0.06 }, rectRadius: 0.08 });
        slide.addShape('rect', { x: cd.x, y: 0.9, w: 0.09, h: 1.05, fill: { color: cd.color }, rectRadius: 0.08 });
        slide.addText(String(cd.count), { x: cd.x + 0.25, y: 0.95, w: 1.2, h: 0.9, fontSize: 30, bold: true, color: cd.color, fontFace: 'Calibri' });
        slide.addText(cd.label, { x: cd.x + 1.55, y: 1.05, w: 2.3, h: 0.8, fontSize: 12, color: GRAY, fontFace: 'Calibri' });
      });
      const rows = [[hdr('Service'), hdr('Target (ETB)'), hdr('Actual (ETB)'), hdr('Achievement'), hdr('Status')]];
      svcs.forEach(s => {
        rows.push([
          c(s.name, { bold: true }),
          c(`ETB ${mfmt(s.target)}`, { align: 'right' }),
          c(`ETB ${mfmt(s.actual)}`, { align: 'right' }),
          c(`${s.achievement}%`, { color: colorOf(s.achievement), bold: true, align: 'center' }),
          c(statusOf(s.achievement), { color: colorOf(s.achievement), bold: true, align: 'center' }),
        ]);
      });
      slide.addTable(rows, { x: 0.3, y: 2.2, w: 12.4, border: { type: 'solid', pt: 0.5, color: 'E0E0E0' }, colW: [4.2, 2.6, 2.6, 1.6, 1.4], autoPage: false });
      slide.addText([
        { text: `Average achievement ${pct1(avgA)} — `, options: { fontSize: 10.5, color: DARK } },
        { text: svcs[0] ? `best: ${svcs[0].name} (${svcs[0].achievement}%). ` : '', options: { fontSize: 10.5, color: GREEN, bold: true } },
        { text: svcs[svcs.length - 1] ? `weakest: ${svcs[svcs.length - 1].name} (${svcs[svcs.length - 1].achievement}%).` : '', options: { fontSize: 10.5, color: RED, bold: true } },
      ], { x: 0.4, y: 6.55, w: 11.0, h: 0.5, fontFace: 'Calibri' });
    }

    // ==========================================
    // SLIDE 6: ACHIEVEMENT SCORES — TARGET VS ACTUAL
    // ==========================================
    {
      const svcs = (data.serviceAchievements || []).slice().sort((a, b) => b.target - a.target);
      slide = pptx.addSlide();
      slide.background = { color: LIGHT_BG };
      sectionTitle(slide, 'Achievement Scores — Target vs Actual');
      const l1 = svcs.slice(0, 6).map(s => (s.name.length > 16 ? s.name.substring(0, 16) + '...' : s.name));
      slide.addChart(pptx.charts.BAR, [
        { name: 'Actual (ETB M)', labels: l1, values: svcs.slice(0, 6).map(s => Number(s.actual) / 1e6) },
        { name: 'Target (ETB M)', labels: l1, values: svcs.slice(0, 6).map(s => Number(s.target) / 1e6) },
      ], {
        x: 0.3, y: 0.9, w: 12.4, h: 2.9,
        barGrouping: 'clustered', chartColors: [GREEN, 'BBDEFB'],
        legendPos: 't', legendFontSize: 9, catAxisLabelColor: DARK, catAxisLabelFontSize: 8, valAxisLabelColor: GRAY,
      });
      const l2 = svcs.map(s => (s.name.length > 16 ? s.name.substring(0, 16) + '...' : s.name));
      slide.addChart(pptx.charts.BAR, [{ name: 'Achievement %', labels: l2, values: svcs.map(s => s.achievement) }], {
        x: 0.3, y: 4.05, w: 12.4, h: 2.0,
        showValue: true, valueFontSize: 8, valueFontColor: DARK,
        valAxisMaxVal: 100, valAxisMinVal: 0, chartColors: [LIGHT_GREEN],
        catAxisLabelColor: DARK, catAxisLabelFontSize: 8, valAxisLabelColor: GRAY,
      });
      const over = svcs.filter(s => s.achievement >= 100).length;
      const under = svcs.filter(s => s.achievement < 100).length;
      slide.addText(
        `Insight: ${over} of ${svcs.length} services are at or above their annual target; ${under} remain below. ` +
        (svcs.length ? `Achievement ranges from ${Math.min(...svcs.map(s => s.achievement))}% to ${Math.max(...svcs.map(s => s.achievement))}%.` : ''),
        { x: 0.4, y: 6.35, w: 11.0, h: 0.6, fontSize: 10.5, color: GRAY, fontFace: 'Calibri' }
      );
    }

    // ==========================================
    // SLIDE 7: ALERTED SERVICES — STATUS OVERVIEW
    // ==========================================
    {
      const levelRank = { critical: 0, warning: 1, on_track: 2 };
      const alerts = (data.alertData || []).slice().sort((a, b) => levelRank[a.level] - levelRank[b.level] || b.achievement - a.achievement);
      const critN = alerts.filter(a => a.level === 'critical').length;
      const warnN = alerts.filter(a => a.level === 'warning').length;
      const onN = alerts.filter(a => a.level === 'on_track').length;
      slide = pptx.addSlide();
      slide.background = { color: LIGHT_BG };
      sectionTitle(slide, 'Alerted Services — Status Overview');
      [
        { label: 'Critical', count: critN, color: RED, x: 0.4 },
        { label: 'Warning', count: warnN, color: AMBER, x: 4.5 },
        { label: 'On Track', count: onN, color: GREEN, x: 8.6 },
      ].forEach(cd => {
        slide.addShape('rect', { x: cd.x, y: 0.9, w: 3.9, h: 1.0, fill: { color: 'FFFFFF' }, shadow: { type: 'outer', blur: 2, offset: 1, color: '000000', opacity: 0.06 }, rectRadius: 0.08 });
        slide.addShape('rect', { x: cd.x, y: 0.9, w: 0.09, h: 1.0, fill: { color: cd.color }, rectRadius: 0.08 });
        slide.addText(String(cd.count), { x: cd.x + 0.25, y: 0.95, w: 1.2, h: 0.85, fontSize: 30, bold: true, color: cd.color, fontFace: 'Calibri' });
        slide.addText(cd.label, { x: cd.x + 1.55, y: 1.05, w: 2.3, h: 0.7, fontSize: 13, color: GRAY, fontFace: 'Calibri' });
      });
      const rows = [[hdr('Service'), hdr('Achievement'), hdr('Actual (ETB)'), hdr('Target (ETB)'), hdr('Status')]];
      alerts.forEach(a => {
        const sc = a.level === 'on_track' ? GREEN : a.level === 'warning' ? AMBER : RED;
        rows.push([
          c(a.service, { bold: true }),
          c(`${a.achievement}%`, { color: sc, bold: true, align: 'center' }),
          c(`ETB ${mfmt(a.actual)}`, { align: 'right' }),
          c(`ETB ${mfmt(a.target)}`, { align: 'right' }),
          c(a.level === 'on_track' ? 'ON TRACK' : a.level === 'warning' ? 'WARNING' : 'CRITICAL', { color: sc, bold: true, align: 'center' }),
        ]);
      });
      slide.addTable(rows, { x: 0.3, y: 2.15, w: 12.4, border: { type: 'solid', pt: 0.5, color: 'E0E0E0' }, colW: [4.2, 1.6, 2.3, 2.3, 2.0], autoPage: false });
      slide.addText(
        `${critN} service${critN === 1 ? '' : 's'} are critical (achievement below 50%) and require immediate attention. ` +
        (alerts[0] ? `Lowest performer: ${alerts[0].service} at ${alerts[0].achievement}%.` : ''),
        { x: 0.4, y: 6.4, w: 11.0, h: 0.5, fontSize: 10.5, color: critN > 0 ? RED : GREEN, bold: true, fontFace: 'Calibri' }
      );
    }

    // ==========================================
    // SLIDE 8: ALERTED SERVICES — GAP & PRIORITY
    // ==========================================
    {
      const gaps = (data.alertData || [])
        .map(a => ({ ...a, gap: Number(a.target) - Number(a.actual) }))
        .filter(a => a.gap > 0)
        .sort((x, y) => y.gap - x.gap);
      slide = pptx.addSlide();
      slide.background = { color: LIGHT_BG };
      sectionTitle(slide, 'Alerted Services — Gap & Priority');
      if (gaps.length) {
        const rows = [[hdr('Priority'), hdr('Service'), hdr('Target (ETB)'), hdr('Actual (ETB)'), hdr('Gap (ETB)'), hdr('Status')]];
        gaps.slice(0, 13).forEach((a, i) => {
          const sc = a.level === 'warning' ? AMBER : RED;
          rows.push([
            c(i + 1, { align: 'center', bold: true }),
            c(a.service, { bold: true }),
            c(`ETB ${mfmt(a.target)}`, { align: 'right' }),
            c(`ETB ${mfmt(a.actual)}`, { align: 'right' }),
            c(`ETB ${mfmt(a.gap)}`, { color: sc, bold: true, align: 'right' }),
            c(a.level === 'warning' ? 'WARNING' : 'CRITICAL', { color: sc, bold: true, align: 'center' }),
          ]);
        });
        slide.addTable(rows, { x: 0.3, y: 0.9, w: 12.4, border: { type: 'solid', pt: 0.5, color: 'E0E0E0' }, colW: [1.0, 3.6, 2.3, 2.3, 2.2, 1.0], autoPage: false });
        const gl = gaps.slice(0, 8).map(a => (a.service.length > 16 ? a.service.substring(0, 16) + '...' : a.service));
        slide.addChart(pptx.charts.BAR, [{ name: 'Revenue Gap (ETB M)', labels: gl, values: gaps.slice(0, 8).map(a => a.gap / 1e6) }], {
        x: 0.3, y: 4.7, w: 12.4, h: 1.75,
        showValue: true, valueFontSize: 8, valueFontColor: DARK,
        chartColors: [RED], catAxisLabelColor: DARK, catAxisLabelFontSize: 8, valAxisLabelColor: GRAY,
        });
        const totGap = gaps.reduce((s, a) => s + a.gap, 0);
        slide.addText(
          `Total unfilled revenue across alerted services: ETB ${mfmt(totGap)}. ` +
          `Highest-priority gap: ${gaps[0].service} (ETB ${mfmt(gaps[0].gap)}).`,
          { x: 0.4, y: 6.6, w: 11.0, h: 0.5, fontSize: 10.5, color: RED, bold: true, fontFace: 'Calibri' }
        );
      } else {
        slide.addText('No alerted services with a positive revenue gap in the selected period.', { x: 0.5, y: 3.2, w: 12, h: 0.6, fontSize: 16, color: GREEN, fontFace: 'Calibri' });
      }
    }

    // ==========================================
    // SLIDE 9: VARIANCE — OVERVIEW
    // ==========================================
    {
      const svcs = (data.serviceAchievements || []).slice().sort((a, b) => (Number(a.actual) - Number(a.target)) - (Number(b.actual) - Number(b.target)));
      const totT = svcs.reduce((s, x) => s + Number(x.target), 0);
      const totA = svcs.reduce((s, x) => s + Number(x.actual), 0);
      const totV = totA - totT;
      slide = pptx.addSlide();
      slide.background = { color: LIGHT_BG };
      sectionTitle(slide, 'Variance Analysis — Overview');
      const rows = [[hdr('Service'), hdr('Target (ETB)'), hdr('Actual (ETB)'), hdr('Variance (ETB)'), hdr('Variance %')]];
      svcs.forEach(s => {
        const v = Number(s.actual) - Number(s.target);
        const vp = Number(s.target) > 0 ? ((v / Number(s.target)) * 100).toFixed(1) : '0.0';
        const clr = v >= 0 ? GREEN : RED;
        rows.push([
          c(s.name, { bold: true }),
          c(`ETB ${mfmt(s.target)}`, { align: 'right' }),
          c(`ETB ${mfmt(s.actual)}`, { align: 'right' }),
          c(`${v >= 0 ? '+' : '−'}ETB ${mfmt(Math.abs(v))}`, { color: clr, bold: true, align: 'right' }),
          c(`${v >= 0 ? '+' : '−'}${vp}%`, { color: clr, bold: true, align: 'center' }),
        ]);
      });
      rows.push([
        c('TOTAL', { bold: true, fill: { color: 'E8F5E9' } }),
        c(`ETB ${mfmt(totT)}`, { align: 'right', bold: true, fill: { color: 'E8F5E9' } }),
        c(`ETB ${mfmt(totA)}`, { align: 'right', bold: true, fill: { color: 'E8F5E9' } }),
        c(`${totV >= 0 ? '+' : '−'}ETB ${mfmt(Math.abs(totV))}`, { color: totV >= 0 ? GREEN : RED, bold: true, align: 'right', fill: { color: 'E8F5E9' } }),
        c(`${totT > 0 ? ((totV / totT) * 100).toFixed(1) : '0.0'}%`, { color: totV >= 0 ? GREEN : RED, bold: true, align: 'center', fill: { color: 'E8F5E9' } }),
      ]);
      slide.addTable(rows, { x: 0.3, y: 0.9, w: 12.4, border: { type: 'solid', pt: 0.5, color: 'E0E0E0' }, colW: [4.2, 2.2, 2.2, 2.4, 1.4], autoPage: false });
      slide.addChart(pptx.charts.BAR, [{ name: 'Variance (ETB M)', labels: svcs.map(s => (s.name.length > 14 ? s.name.substring(0, 14) + '...' : s.name)), values: svcs.map(s => (Number(s.actual) - Number(s.target)) / 1e6) }], {
        x: 0.3, y: 4.7, w: 12.4, h: 1.75,
        showValue: true, valueFontSize: 8, valueFontColor: DARK,
        chartColors: [BLUE], catAxisLabelColor: DARK, catAxisLabelFontSize: 8, valAxisLabelColor: GRAY,
      });
      slide.addText(
        `Portfolio variance is ${totV >= 0 ? '+' : '−'}ETB ${mfmt(Math.abs(totV))} (${totT > 0 ? ((totV / totT) * 100).toFixed(1) : '0.0'}% of target). ` +
        (svcs.length ? `Worst variance: ${svcs[0].name}; best variance: ${svcs[svcs.length - 1].name}.` : ''),
        { x: 0.4, y: 6.6, w: 11.0, h: 0.5, fontSize: 10.5, color: totV >= 0 ? GREEN : RED, bold: true, fontFace: 'Calibri' }
      );
    }

    // ==========================================
    // SLIDE 10: VARIANCE — MONTHLY TREND
    // ==========================================
    {
      const trend = (data.monthlyTrend || []).slice().sort((a, b) => String(a.revenue_month).localeCompare(String(b.revenue_month)));
      const totalTgt = Number(data.kpis.total_target) || 0;
      const expM = totalTgt / 12;
      slide = pptx.addSlide();
      slide.background = { color: LIGHT_BG };
      sectionTitle(slide, 'Variance Analysis — Monthly Trend & Drivers');
      if (trend.length) {
        const labels = trend.map(m => m.revenue_month);
        const actuals = trend.map(m => Number(m.revenue) / 1e6);
        slide.addChart(pptx.charts.BAR, [
          { name: 'Actual (ETB M)', labels, values: actuals },
          { name: 'Monthly Expectation (ETB M)', labels, values: labels.map(() => Number((expM / 1e6).toFixed(2))) },
        ], {
          x: 0.3, y: 0.9, w: 12.4, h: 2.9,
          barGrouping: 'clustered', chartColors: [GREEN, 'BBDEFB'],
          legendPos: 't', legendFontSize: 9, catAxisLabelColor: DARK, catAxisLabelFontSize: 8, valAxisLabelColor: GRAY,
        });
        const varVals = trend.map(m => (Number(m.revenue) - expM) / 1e6);
        slide.addChart(pptx.charts.BAR, [{ name: 'Monthly Variance (ETB M)', labels, values: varVals }], {
          x: 0.3, y: 4.1, w: 12.4, h: 1.9,
          showValue: true, valueFontSize: 8, valueFontColor: DARK,
          chartColors: [AMBER], catAxisLabelColor: DARK, catAxisLabelFontSize: 8, valAxisLabelColor: GRAY,
        });
        const bestM = trend.slice().sort((a, b) => Number(b.revenue) - Number(a.revenue))[0];
        const worstM = trend.slice().sort((a, b) => Number(a.revenue) - Number(b.revenue))[0];
        slide.addText(
          `Monthly expectation is ETB ${mfmt(expM)} (annual target / 12). Peak month: ${bestM.revenue_month} (ETB ${mfmt(bestM.revenue)}); ` +
          `lowest month: ${worstM.revenue_month} (ETB ${mfmt(worstM.revenue)}).`,
          { x: 0.4, y: 6.25, w: 12.4, h: 0.5, fontSize: 10.5, color: GRAY, fontFace: 'Calibri' }
        );
      } else {
        slide.addText('No monthly revenue data available for the selected period.', { x: 0.5, y: 3.2, w: 12, h: 0.6, fontSize: 16, color: GRAY, fontFace: 'Calibri' });
      }
    }

    // ==========================================
    // SLIDE 11: GOAL CASCADING — PERIOD BREAKDOWN
    // ==========================================
    {
      const rowsData = gcRows.slice().sort((a, b) => b.target - a.target);
      slide = pptx.addSlide();
      slide.background = { color: LIGHT_BG };
      sectionTitle(slide, 'Goal Cascading — Yearly & Semi-Annual');
      const rows = [[hdr('Service'), hdr('Year Target (ETB)'), hdr('Year %'), hdr('H1 %'), hdr('H2 %'), hdr('Status')]];
      rowsData.forEach(r => {
        rows.push([
          c(r.name, { bold: true }),
          c(`ETB ${mfmt(r.target)}`, { align: 'right' }),
          c(`${r.ach}%`, { color: colorOf(r.ach), bold: true, align: 'center' }),
          c(`${r.h1Pct}%`, { color: colorOf(r.h1Pct), bold: true, align: 'center' }),
          c(`${r.h2Pct}%`, { color: colorOf(r.h2Pct), bold: true, align: 'center' }),
          c(statusOf(r.ach), { color: colorOf(r.ach), bold: true, align: 'center' }),
        ]);
      });
      slide.addTable(rows, { x: 0.3, y: 0.9, w: 12.4, border: { type: 'solid', pt: 0.5, color: 'E0E0E0' }, colW: [3.8, 2.3, 1.4, 1.4, 1.4, 2.1], autoPage: false });
      // H1 vs H2 achievement chart
      const hl = rowsData.map(r => (r.name.length > 14 ? r.name.substring(0, 14) + '...' : r.name));
      slide.addChart(pptx.charts.BAR, [
        { name: 'H1 Achievement %', labels: hl, values: rowsData.map(r => r.h1Pct) },
        { name: 'H2 Achievement %', labels: hl, values: rowsData.map(r => r.h2Pct) },
      ], {
        x: 0.3, y: 4.7, w: 12.4, h: 1.7,
        barGrouping: 'clustered', valAxisMaxVal: 100, valAxisMinVal: 0,
        chartColors: [BLUE, AMBER], legendPos: 't', legendFontSize: 9,
        catAxisLabelColor: DARK, catAxisLabelFontSize: 8, valAxisLabelColor: GRAY,
      });
      slide.addText(
        'Targets are split equally across the target period (equal-split method). Semi-annual scores show whether momentum is concentrated in H1 or H2.',
        { x: 0.4, y: 6.55, w: 11.0, h: 0.4, fontSize: 9.5, color: GRAY, italic: true, fontFace: 'Calibri' }
      );
    }

    // ==========================================
    // SLIDE 12: GOAL CASCADING — QUARTERLY PROGRESS
    // ==========================================
    {
      const rowsData = gcRows.slice().sort((a, b) => b.target - a.target);
      slide = pptx.addSlide();
      slide.background = { color: LIGHT_BG };
      sectionTitle(slide, 'Goal Cascading — Quarterly Progress');
      const rows = [[hdr('Service'), hdr('Q1 %'), hdr('Q2 %'), hdr('Q3 %'), hdr('Q4 %'), hdr('Best Quarter')]];
      rowsData.forEach(r => {
        const bestQ = r.qPct.indexOf(Math.max(...r.qPct));
        rows.push([
          c(r.name, { bold: true }),
          c(`${r.qPct[0]}%`, { color: colorOf(r.qPct[0]), bold: true, align: 'center' }),
          c(`${r.qPct[1]}%`, { color: colorOf(r.qPct[1]), bold: true, align: 'center' }),
          c(`${r.qPct[2]}%`, { color: colorOf(r.qPct[2]), bold: true, align: 'center' }),
          c(`${r.qPct[3]}%`, { color: colorOf(r.qPct[3]), bold: true, align: 'center' }),
          c(['Q1', 'Q2', 'Q3', 'Q4'][bestQ], { align: 'center' }),
        ]);
      });
      slide.addTable(rows, { x: 0.3, y: 0.9, w: 12.4, border: { type: 'solid', pt: 0.5, color: 'E0E0E0' }, colW: [4.2, 1.5, 1.5, 1.5, 1.5, 2.2], autoPage: false });
      // aggregate quarterly actual vs quarterly target (all services)
      const qAggA = [0, 1, 2, 3].map(i => gcRows.reduce((s, r) => s + (r.qA[i] || 0), 0));
      const qAggT = [0, 1, 2, 3].map(i => gcRows.reduce((s, r) => s + (r.qT[i] || 0), 0));
      slide.addChart(pptx.charts.BAR, [
        { name: 'Quarterly Target (ETB M)', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: qAggT.map(v => v / 1e6) },
        { name: 'Quarterly Actual (ETB M)', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: qAggA.map(v => v / 1e6) },
      ], {
        x: 0.3, y: 4.7, w: 12.4, h: 1.7,
        barGrouping: 'clustered', chartColors: [BLUE, GREEN],
        legendPos: 't', legendFontSize: 9, catAxisLabelColor: DARK, catAxisLabelFontSize: 9, valAxisLabelColor: GRAY,
      });
      const bestQIdx = qAggA.indexOf(Math.max(...qAggA));
      slide.addText(
        `Quarterly achievement across the portfolio: Q1 ${qAggT[0] ? Math.round((qAggA[0] / qAggT[0]) * 100) : 0}%, Q2 ${qAggT[1] ? Math.round((qAggA[1] / qAggT[1]) * 100) : 0}%, ` +
        `Q3 ${qAggT[2] ? Math.round((qAggA[2] / qAggT[2]) * 100) : 0}%, Q4 ${qAggT[3] ? Math.round((qAggA[3] / qAggT[3]) * 100) : 0}%. ` +
        `Strongest quarter: ${['Q1', 'Q2', 'Q3', 'Q4'][bestQIdx]}.`,
        { x: 0.4, y: 6.55, w: 11.0, h: 0.5, fontSize: 10.5, color: GRAY, fontFace: 'Calibri' }
      );
    }

    // ==========================================
    // SLIDE 13: RANKING — TOP PARTNERS
    // ==========================================
    {
      const partners = data.topPartners || [];
      const totalP = partners.reduce((s, p) => s + Number(p.total_revenue || 0), 0);
      slide = pptx.addSlide();
      slide.background = { color: LIGHT_BG };
      sectionTitle(slide, 'Ranking — Top Partners by Revenue');
      if (partners.length) {
        const rows = [[hdr('#'), hdr('Partner Name'), hdr('Revenue (ETB)'), hdr('Share'), hdr('Cumulative')]];
        let cum = 0;
        partners.forEach((p, i) => {
          const rev = Number(p.total_revenue) || 0;
          const share = totalP > 0 ? (rev / totalP) * 100 : 0;
          cum += share;
          rows.push([
            c(i + 1, { align: 'center', bold: true }),
            c(p.partner_name, { bold: true }),
            c(`ETB ${mfmt(rev)}`, { align: 'right' }),
            c(`${share.toFixed(1)}%`, { align: 'center' }),
            c(`${cum.toFixed(1)}%`, { align: 'center', color: cum > 50 ? AMBER : GRAY, bold: cum > 50 }),
          ]);
        });
        slide.addTable(rows, { x: 0.3, y: 0.9, w: 12.4, border: { type: 'solid', pt: 0.5, color: 'E0E0E0' }, colW: [0.6, 5.4, 2.8, 1.8, 1.8], autoPage: false });
        const pl = partners.slice(0, 5).map(p => (p.partner_name.length > 20 ? p.partner_name.substring(0, 20) + '...' : p.partner_name));
        slide.addChart(pptx.charts.BAR, [{ name: 'Revenue (ETB M)', labels: pl, values: partners.slice(0, 5).map(p => Number(p.total_revenue) / 1e6) }], {
          x: 0.3, y: 4.9, w: 12.4, h: 1.8,
          showValue: true, valueFontSize: 9, valueFontColor: DARK,
          chartColors: [PURPLE], catAxisLabelColor: DARK, catAxisLabelFontSize: 8, valAxisLabelColor: GRAY,
        });
        const top5 = partners.slice(0, 5).reduce((s, p) => s + Number(p.total_revenue || 0), 0);
        const top5S = totalP > 0 ? (top5 / totalP) * 100 : 0;
        slide.addText(
          `Top partner: ${partners[0].partner_name} with ${totalP > 0 ? ((Number(partners[0].total_revenue) / totalP) * 100).toFixed(1) : '0.0'}% of revenue; ` +
          `top five partners together hold ${top5S.toFixed(1)}%.`,
          { x: 0.4, y: 6.8, w: 11.0, h: 0.35, fontSize: 10.5, color: GRAY, fontFace: 'Calibri' }
        );
      } else {
        slide.addText('No partner revenue data available for the selected period.', { x: 0.5, y: 3.2, w: 12, h: 0.6, fontSize: 16, color: GRAY, fontFace: 'Calibri' });
      }
    }

    // ==========================================
    // SLIDE 14: RANKING — SERVICES BY REVENUE
    // ==========================================
    {
      const srv = (data.serviceAchievements || []).slice().sort((a, b) => Number(b.actual) - Number(a.actual));
      const totalAct = srv.reduce((s, x) => s + Number(x.actual || 0), 0);
      slide = pptx.addSlide();
      slide.background = { color: LIGHT_BG };
      sectionTitle(slide, 'Ranking — Services by Revenue Contribution');
      if (srv.length) {
        const rows = [[hdr('#'), hdr('Service'), hdr('Revenue (ETB)'), hdr('Share'), hdr('Achievement')]];
        srv.forEach((s, i) => {
          const share = totalAct > 0 ? (Number(s.actual) / totalAct) * 100 : 0;
          rows.push([
            c(i + 1, { align: 'center', bold: true }),
            c(s.name, { bold: true }),
            c(`ETB ${mfmt(s.actual)}`, { align: 'right' }),
            c(`${share.toFixed(1)}%`, { align: 'center' }),
            c(`${s.achievement}%`, { color: colorOf(s.achievement), bold: true, align: 'center' }),
          ]);
        });
        slide.addTable(rows, { x: 0.3, y: 0.9, w: 12.4, border: { type: 'solid', pt: 0.5, color: 'E0E0E0' }, colW: [0.6, 5.4, 2.8, 1.8, 1.8], autoPage: false });
        // revenue share pie (top 6 + other)
        const top6 = srv.slice(0, 6);
        const restSum = totalAct - top6.reduce((s, x) => s + Number(x.actual || 0), 0);
        const pieLabels = top6.map(s => (s.name.length > 16 ? s.name.substring(0, 16) + '...' : s.name)).concat(restSum > 0 ? ['Others'] : []);
        const pieValues = top6.map(s => Number(s.actual) / 1e6).concat(restSum > 0 ? [restSum / 1e6] : []);
        slide.addChart(pptx.charts.PIE, [{ name: 'Revenue', labels: pieLabels, values: pieValues }], {
          x: 0.3, y: 4.6, w: 6.4, h: 2.5,
          showPercent: true, showLegend: true, legendPos: 'r', legendFontSize: 8,
          chartColors: [GREEN, BLUE, PURPLE, AMBER, '00838F', 'E91E63', '795548'],
          dataLabelColor: DARK, dataLabelFontSize: 9,
        });
        slide.addText(
          totalAct > 0 && srv[0]
            ? `Top service: ${srv[0].name} with ${((Number(srv[0].actual) / totalAct) * 100).toFixed(1)}% of total revenue.`
            : 'No service revenue data for the selected period.',
          { x: 7.2, y: 4.9, w: 5.6, h: 0.5, fontSize: 11, color: GRAY, fontFace: 'Calibri' }
        );
      } else {
        slide.addText('No service revenue data available for the selected period.', { x: 0.5, y: 3.2, w: 12, h: 0.6, fontSize: 16, color: GRAY, fontFace: 'Calibri' });
      }
    }

    // ==========================================
    // SLIDE 15: THANK YOU (internal deck only — skipped in final merge)
    // ==========================================
    slide = pptx.addSlide();
    slide.background = { color: DARK };
    slide.addShape('rect', { x: 0, y: 0, w: '100%', h: 0.8, fill: { color: GREEN } });
    slide.addShape('rect', { x: 0, y: 6.5, w: '100%', h: 0.75, fill: { color: GREEN } });
    slide.addText('Thank You', { x: 0, y: 2.0, w: '100%', h: 1, fontSize: 42, color: 'FFFFFF', bold: true, align: 'center', fontFace: 'Calibri' });
    slide.addText('VAS Performance Tracker | Ethio Telecom', { x: 0, y: 3.2, w: '100%', h: 0.6, fontSize: 16, color: '94A3B8', align: 'center', fontFace: 'Calibri' });
    slide.addText(`Generated on ${reportDate} | Period: ${periodText}`, { x: 0, y: 4.0, w: '100%', h: 0.5, fontSize: 13, color: '64748B', align: 'center', fontFace: 'Calibri' });
    slide.addText('CONFIDENTIAL — For Internal Use Only', { x: 0, y: 5.0, w: '100%', h: 0.4, fontSize: 11, color: RED, align: 'center', fontFace: 'Calibri', italic: true });

    // Generate and send — wrapped inside the official VAS template
    // (template pages 1-5 kept as the intro, generated content slides in the
    // middle, the template Thank-You page closes the deck).
    const fileName = `VAS_Report_${new Date().toISOString().slice(0, 10)}.pptx`;
    let buffer = await pptx.write({ outputType: 'nodebuffer' });
    try {
      buffer = await wrapWithTemplate(buffer);
    } catch (mergeErr) {
      console.error('Template merge failed, sending standalone deck:', mergeErr.message);
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);

  } catch (error) {
    console.error('PPTX export error:', error);
    res.status(500).json({ error: 'Failed to generate PowerPoint', message: error.message });
  }
});

module.exports = router;