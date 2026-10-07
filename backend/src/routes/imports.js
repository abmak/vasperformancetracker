const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const { requirePermission } = require('../middleware/permissions');
const pool = require('../config/database');
const { invalidate } = require('../utils/endpointCache');

// Configure multer for file upload
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv'
    ];
    if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(xlsx|xls|csv)$/)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel and CSV files are allowed'));
    }
  }
});

// POST preview revenue from Excel (parse only, no insert)
router.post('/preview', requirePermission('import.upload'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = [];
    let rowNum = 0;
    const summary = { total: 0, valid: 0, invalid: 0, services: {}, months: {}, sheets: {} };

    // Get all services for matching
    const [allServices] = await pool.execute('SELECT id, name, code FROM vas_services');
    // Lookup maps: exact code match first, then exact name, then whole-word
    // fragments of the name. Matching a sheet to a service must anchor on the
    // VAS **service code** — codes are stable, names get renamed, and a rename
    // must not silently re-route sheets to the wrong service.
    const serviceMap = {};
    const serviceList = allServices.map(s => `${s.name} (${s.code || 'no code'})`);
    for (const s of allServices) {
      if (s.code) serviceMap[s.code.toLowerCase().trim()] = s;
      if (s.name) serviceMap[s.name.toLowerCase().trim()] = s;
    }

    // STRICT matching policy (user rule: never guess): a sheet maps to a VAS
    // service ONLY on an exact match — exact service code, exact service name,
    // or a whole word of the sheet name that IS a service code. No substring
    // or word-overlap matching: a sheet named "CRBT" must NOT be silently
    // posted under "CRBT TONE SALES" just because the name contains "CRBT".
    // Unmatched sheets surface as invalid rows in the preview instead, so the
    // data is never attached to the wrong service.
    function matchSheetToService(sheetName) {
      const sLower = sheetName.toLowerCase().trim();
      const cleaned = sLower.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      // 1) Exact match on code or name (after normalizing punctuation/spacing)
      if (serviceMap[cleaned]) return serviceMap[cleaned];
      const trimmed = cleaned.replace(/[_\s]+$/, '');
      if (trimmed !== cleaned && serviceMap[trimmed]) return serviceMap[trimmed];

      // 2) A whole word of the sheet name EQUALS a service CODE, exactly.
      //    e.g. sheet "API-MEGA" → word "api" == code "API"; sheet
      //    "CRBT-Partners" → word "crbt" == code "CRBT". Substring matches
      //    (w.includes(key)) are deliberately NOT accepted.
      const sheetWords = cleaned.split(' ');
      for (const w of sheetWords) {
        const codeOwner = allServices.find(s => s.code && s.code.toLowerCase().trim() === w);
        if (codeOwner) return codeOwner;
      }
      return null;
    }

    // Process each sheet
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (data.length === 0) continue;

      // Match sheet name to a VAS service
      const matchedService = matchSheetToService(sheetName);
      let sheetServiceId = matchedService ? matchedService.id : null;
      let sheetServiceName = matchedService ? matchedService.name : sheetName.trim();

      summary.sheets[sheetName] = { rows: 0, matched: !!sheetServiceId, service: sheetServiceName };

      // If sheet doesn't match any VAS service, mark all rows as invalid and skip
      if (!sheetServiceId) {
        let skippedRows = 0;
        for (let i = 0; i < data.length; i++) {
          const row = data[i];
          rowNum++;
          summary.total++;
          const hasData = Object.values(row).some(v => v && String(v).trim().length > 0);
          if (!hasData) {
            summary.total--;
            rowNum--;
            continue;
          }
          skippedRows++;
          // Find partner name for display
          let pName = '';
          for (const col of Object.keys(row)) {
            if (col.toLowerCase().includes('partner')) { pName = String(row[col]).trim(); break; }
          }
          let amt = 0;
          for (const col of Object.keys(row)) {
            if (col.toLowerCase().includes('total') && col.toLowerCase().includes('revenue')) {
              const v = parseFloat(row[col]); if (!isNaN(v) && v > 0) { amt = v; break; }
            }
          }
          rows.push({
            row: rowNum,
            status: 'invalid',
            errors: [`Sheet "${sheetName}" has no matching VAS Service`],
            error_detail: `This sheet name doesn't match any existing VAS Service. Available services: ${serviceList.join(', ')}. To import this data, create a VAS Service matching this sheet name.`,
            data: { service_name: sheetName, partner_name: pName, amount: amt, sheet: sheetName, raw: Object.entries(row).slice(0, 6).map(([k,v]) => `${k}: ${String(v).substring(0, 40)}`).join(' | ') }
          });
        }
        summary.invalid += skippedRows;
        summary.sheets[sheetName].rows = skippedRows;
        summary.unmatched_sheets = summary.unmatched_sheets || [];
        summary.unmatched_sheets.push({ name: sheetName, available_services: serviceList });
        continue;
      }

      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        rowNum++;
        summary.total++;

        // Skip empty rows early
        const rowHasData = Object.values(row).some(v => v && String(v).trim().length > 0);
        if (!rowHasData) {
          summary.total--;
          rowNum--;
          continue;
        }

        // Only extract: Partner Name + Total Revenue
        let partnerName = '';
        let amount = 0;

        // Find partner name from columns
        for (const col of Object.keys(row)) {
          const colLower = col.toLowerCase().trim();
          if ((colLower.includes('partner') && (colLower.includes('name') || colLower === 'partner nam' || colLower === 'partner')) || colLower === 'partner_name' || colLower === 'partnername') {
            partnerName = String(row[col]).trim();
            break;
          }
        }

        // Find total revenue per partner — strict priority:
        // 1) 'total revenue' col, 2) 'revenue' col, 3) 'charging' col, 4) largest numeric
        function isExcludedCol(colLower) {
          // Exclude share/deduction/fraud columns, ID/code columns
          if (colLower.includes('share') || colLower.includes('deduct') || colLower.includes('fraud')) return true;
          if (colLower === 'sd' || colLower === 'ra' || colLower === 'ra ' || colLower === 'ma') return true;
          if (colLower.includes('service id') || colLower.includes('sp code') || colLower.includes('short code')) return true;
          if (colLower.startsWith('ethio share') || colLower.startsWith('partner share') || colLower.startsWith('ma share')) return true;
          return false;
        }

        // Get header row values (first data row often has sub-headers like "Total", "Monthly Rent")
        const headerRow = data.length > 0 ? data[0] : {};
        const headerValues = {};
        for (const [col, val] of Object.entries(headerRow)) {
          if (val && String(val).trim()) {
            headerValues[col] = String(val).trim().toLowerCase();
          }
        }

        // Priority 1: column with 'total' AND 'revenue' in column name
        for (const col of Object.keys(row)) {
          const colLower = col.toLowerCase().trim();
          const val = parseFloat(row[col]);
          if (isNaN(val) || val === 0 || isExcludedCol(colLower)) continue;
          if (colLower.includes('total') && colLower.includes('revenue')) {
            amount = val;
            break;
          }
        }
        // Priority 1b: column whose header VALUE says 'total' (for __EMPTY columns with 'Total' sub-header)
        if (!amount) {
          for (const col of Object.keys(row)) {
            const colLower = col.toLowerCase().trim();
            const val = parseFloat(row[col]);
            if (isNaN(val) || val === 0) continue;
            const hdrVal = headerValues[col] || '';
            if (hdrVal === 'total' || hdrVal === 'total revenue') {
              amount = val;
              break;
            }
          }
        }
        // Priority 2: column with just 'revenue' in name
        if (!amount) {
          for (const col of Object.keys(row)) {
            const colLower = col.toLowerCase().trim();
            const val = parseFloat(row[col]);
            if (isNaN(val) || val === 0 || isExcludedCol(colLower)) continue;
            if (colLower.includes('revenue')) {
              amount = val;
              break;
            }
          }
        }
        // Priority 3: column with 'charging' in name
        if (!amount) {
          for (const col of Object.keys(row)) {
            const colLower = col.toLowerCase().trim();
            const val = parseFloat(row[col]);
            if (isNaN(val) || val === 0 || isExcludedCol(colLower)) continue;
            if (colLower.includes('charging')) {
              amount = val;
              break;
            }
          }
        }
        // Priority 4: largest numeric value (excluding share/deduction columns)
        if (!amount) {
          let maxVal = 0;
          for (const col of Object.keys(row)) {
            const colLower = col.toLowerCase().trim();
            const val = parseFloat(row[col]);
            if (isNaN(val) || val === 0 || isExcludedCol(colLower)) continue;
            if (val > maxVal) maxVal = val;
          }
          if (maxVal > 0) amount = maxVal;
        }

        // Skip empty/header rows
        if (!partnerName && (!amount || amount < 1)) {
          summary.total--;
          rowNum--;
          continue;
        }

        // Skip remark/validation rows
        if (partnerName.toLowerCase().includes('validated') || partnerName.toLowerCase().includes('total') || partnerName.toLowerCase().includes('remark')) {
          summary.total--;
          rowNum--;
          continue;
        }

        // Service comes from sheet name (already matched)
        let serviceId = sheetServiceId;
        let serviceName = sheetServiceName;

        if (!serviceId && partnerName) {
          // Try matching a "Service Type" column — EXACT code or name only
          // (strict policy: never guess from partial values).
          for (const col of Object.keys(row)) {
            const colLower = col.toLowerCase().trim();
            if (colLower.includes('service') && colLower.includes('type')) {
              const svcClean = String(row[col]).toLowerCase().trim()
                .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
              if (!svcClean) break;
              const svcExact = allServices.find(s =>
                (s.code && s.code.toLowerCase().trim() === svcClean) ||
                (s.name && s.name.toLowerCase().trim() === svcClean));
              if (svcExact) {
                serviceId = svcExact.id;
                serviceName = svcExact.name;
              }
              break;
            }
          }
        }

        const rowResult = { row: rowNum, status: 'valid', errors: [], data: {} };

        if (!serviceId) {
          rowResult.status = 'invalid';
          rowResult.errors.push(`Service not found for sheet: ${sheetName}`);
          rowResult.error_detail = `Could not match this row's data to any VAS Service. Available: ${serviceList.join(', ')}`;
        }
        if (!amount || amount <= 0) {
          rowResult.status = 'invalid';
          rowResult.errors.push('No revenue amount found in any column');
          rowResult.error_detail = `Columns checked: ${Object.keys(row).map(k => k).join(', ')}. No numeric revenue value detected.`;
        }
        if (!partnerName) {
          // Still valid — some rows may not have partner names
          partnerName = '(No partner)';
        }

        rowResult.data = {
          service_id: serviceId,
          service_name: serviceName,
          partner_name: partnerName,
          amount: amount || 0,
          notes: `Sheet: ${sheetName}`,
          sheet: sheetName,
          raw: Object.keys(row).slice(0, 4).map(k => `${k}: ${String(row[k]).substring(0, 30)}`).join(' | ')
        };

        if (rowResult.status === 'valid') {
          summary.valid++;
          summary.services[serviceName] = (summary.services[serviceName] || 0) + 1;
        } else {
          summary.invalid++;
        }

        rows.push(rowResult);
        summary.sheets[sheetName].rows++;
      }
    }

    res.json({
      filename: req.file.originalname,
      rows: rows.slice(0, 1000),
      total_rows: rows.length,
      summary
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST import revenue from Excel
router.post('/revenue', requirePermission('import.upload'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const batchId = uuidv4();
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);

    if (data.length === 0) {
      return res.status(400).json({ error: 'File is empty or has no valid data' });
    }

    // Create batch record
    await pool.execute(
      'INSERT INTO import_batches (id, filename, total_records, imported_by, status) VALUES (?, ?, ?, ?, ?)',
      [batchId, req.file.originalname, data.length, req.body.imported_by || 'System', 'processing']
    );

    let successful = 0;
    let failed = 0;
    const errors = [];

    // Expected columns: service_code/name, amount, date, notes
    for (const row of data) {
      try {
        // Find service by code or name
        let serviceId = null;
        const serviceCode = row.service_code || row.ServiceCode || row.code || row.Code;
        const serviceName = row.service_name || row.ServiceName || row.name || row.Name;

        if (serviceCode) {
          const [svc] = await pool.execute('SELECT id FROM vas_services WHERE code = ?', [serviceCode]);
          if (svc.length > 0) serviceId = svc[0].id;
        }
        if (!serviceId && serviceName) {
          const [svc] = await pool.execute('SELECT id FROM vas_services WHERE name = ?', [serviceName]);
          if (svc.length > 0) serviceId = svc[0].id;
        }

        if (!serviceId) {
          failed++;
          errors.push(`Row ${successful + failed}: Service not found (${serviceCode || serviceName})`);
          continue;
        }

        const amount = parseFloat(row.amount || row.Amount || row.revenue || row.Revenue);
        const dateStr = row.date || row.Date || row.revenue_date || row.RevenueDate;
        const notes = row.notes || row.Notes || '';

        if (!amount || amount <= 0) {
          failed++;
          errors.push(`Row ${successful + failed}: Invalid amount`);
          continue;
        }

        if (!dateStr) {
          failed++;
          errors.push(`Row ${successful + failed}: Missing date`);
          continue;
        }

        // Parse date
        let revenueDate;
        if (typeof dateStr === 'number') {
          // Excel serial date
          const date = new Date((dateStr - 25569) * 86400 * 1000);
          revenueDate = date.toISOString().split('T')[0];
        } else {
          revenueDate = new Date(dateStr).toISOString().split('T')[0];
        }

        await pool.execute(
          'INSERT INTO actual_revenue (service_id, amount, revenue_date, revenue_month, source, import_batch_id, entered_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [serviceId, amount, revenueDate, revenueDate.substring(0, 7), 'excel_import', batchId, req.body.imported_by || 'System', notes]
        );
        successful++;
      } catch (rowError) {
        failed++;
        errors.push(`Row ${successful + failed}: ${rowError.message}`);
      }
    }

    // Update batch
    await pool.execute(
      'UPDATE import_batches SET successful_records = ?, failed_records = ?, status = ?, error_log = ? WHERE id = ?',
      [successful, failed, failed === 0 ? 'completed' : 'completed', errors.join('\n'), batchId]
    );

    // Audit trail
    await pool.execute(
      'INSERT INTO audit_trail (action, entity_type, description, user_name) VALUES (?, ?, ?, ?)',
      ['import', 'revenue', `Imported ${successful} revenue records from ${req.file.originalname}`, req.body.imported_by || 'System']
    );

    // Invalidate partner caches so month dropdown and data refresh
    if (successful > 0) {
      invalidate('/partners/months');
      invalidate('/partners');
      invalidate('/partners/summary');
      invalidate('/partners/top-partners');
      invalidate('/dashboard');
    }

    res.json({
      batch_id: batchId,
      total_records: data.length,
      successful,
      failed,
      errors: errors.slice(0, 20) // Limit errors shown
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST confirm import (insert pre-validated rows)
router.post('/confirm', requirePermission('import.upload'), async (req, res) => {
  try {
    const { rows, filename, imported_by, revenue_month: revenueMonthOverride } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows to import' });
    }

    const batchId = uuidv4();

    // Create batch record
    await pool.execute(
      'INSERT INTO import_batches (id, filename, total_records, imported_by, status) VALUES (?, ?, ?, ?, ?)',
      [batchId, filename || 'preview_import', rows.length, imported_by || 'System', 'processing']
    );

    let successful = 0;
    let failed = 0;
    const errors = [];

    // Cache service names to avoid repeated lookups
    const serviceNameCache = {};

    for (const row of rows) {
      try {
        const { service_id, amount, date, revenue_month, partner_name, notes } = row;
        if (!service_id || !amount) {
          failed++;
          errors.push(`Row ${row.row || successful + failed}: Missing required data`);
          continue;
        }
        // Use override month if provided, otherwise use row's month
        const effectiveMonth = revenueMonthOverride || revenue_month;
        const revDate = date || (effectiveMonth ? `${effectiveMonth}-01` : null);
        if (!revDate) {
          failed++;
          errors.push(`Row ${row.row || successful + failed}: Missing date/month`);
          continue;
        }

        // Always look up the VAS service name from the service_id to ensure consistent naming
        if (!serviceNameCache[service_id]) {
          const [svc] = await pool.execute('SELECT name FROM vas_services WHERE id = ?', [service_id]);
          serviceNameCache[service_id] = svc.length > 0 ? svc[0].name : row.service_name || '';
        }
        const vasServiceName = serviceNameCache[service_id];

        // Insert into partner_revenue with the VAS service name and effective month
        try {
          await pool.execute(
            'INSERT INTO partner_revenue (service_name, partner_name, total_revenue, revenue_month, import_batch_id) VALUES (?, ?, ?, ?, ?)',
            [vasServiceName, partner_name || '', amount, effectiveMonth || revDate.substring(0, 7), batchId]
          );
        } catch (e) {
          await pool.execute(
            'INSERT INTO actual_revenue (service_id, amount, revenue_date, revenue_month, source, import_batch_id, entered_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [service_id, amount, revDate, effectiveMonth || revDate.substring(0, 7), 'excel_import', batchId, imported_by || 'System', notes || '']
          );
        }
        successful++;
      } catch (rowError) {
        failed++;
        errors.push(`Row ${row.row || successful + failed}: ${rowError.message}`);
      }
    }

    // Update batch
    await pool.execute(
      'UPDATE import_batches SET successful_records = ?, failed_records = ?, status = ?, error_log = ? WHERE id = ?',
      [successful, failed, failed === 0 ? 'completed' : 'completed', errors.join('\n'), batchId]
    );

    // Audit trail
    await pool.execute(
      'INSERT INTO audit_trail (action, entity_type, description, user_name) VALUES (?, ?, ?, ?)',
      ['import', 'revenue', `Confirmed import of ${successful} revenue records from ${filename}`, imported_by || 'System']
    );

    // Invalidate partner caches so month dropdown and data refresh
    if (successful > 0) {
      invalidate('/partners/months');
      invalidate('/partners');
      invalidate('/partners/summary');
      invalidate('/partners/top-partners');
      invalidate('/dashboard');
    }

    res.json({
      batch_id: batchId,
      total_records: rows.length,
      successful,
      failed,
      errors: errors.slice(0, 20)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET import history
router.get('/history', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 50'
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET template info
router.get('/template', (req, res) => {
  res.json({
    columns: [
      { name: 'Partner Name', required: true, description: 'Name of the partner company' },
      { name: 'Total Revenue', required: true, description: 'Total revenue amount in ETB' }
    ],
    example_rows: [
      { 'Partner Name': 'OROMIA BROTHERS AND SISTERS UNITY CHARITY ORGANIZATION', 'Total Revenue': 7370.69 },
      { 'Partner Name': 'ETHIO TELECOM SOLUTIONS PLC', 'Total Revenue': 125000.00 }
    ]
  });
});

// DELETE import batch and its revenue data
router.delete('/:id', async (req, res) => {
  try {
    const [batch] = await pool.execute('SELECT * FROM import_batches WHERE id = ?', [req.params.id]);
    if (batch.length === 0) return res.status(404).json({ error: 'Import batch not found' });

    // Delete revenue data linked to this import batch
    await pool.execute('DELETE FROM partner_revenue WHERE import_batch_id = ?', [req.params.id]);
    await pool.execute('DELETE FROM actual_revenue WHERE import_batch_id = ?', [req.params.id]);

    // Delete the import batch record
    await pool.execute('DELETE FROM import_batches WHERE id = ?', [req.params.id]);

    // Invalidate partner caches
    invalidate('/partners/months');
    invalidate('/partners');
    invalidate('/partners/summary');
    invalidate('/partners/top-partners');

    res.json({ message: 'Import batch and associated revenue data deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
