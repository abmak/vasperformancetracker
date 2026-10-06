/**
 * Indirect Channel schema.
 *
 * The channel is a *snapshot* dataset: each import is a stock-balance reading
 * taken "as of" a period, keyed by the channel user's mobile number.
 *
 * Everything lives in channel_* tables so it can never collide with the VAS
 * tables (separate-tables-per-section decision).
 */

const pool = require('./database');

const STATEMENTS = [
  // ── Domains: IDC / Yimulu Only / Enterprise ───────────────────────────────
  `CREATE TABLE IF NOT EXISTS channel_domains (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    sort_order INT DEFAULT 0,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,

  // ── Categories: level 1 distributor, 2 sub-distributor, 3 retailer ────────
  `CREATE TABLE IF NOT EXISTS channel_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    domain_id INT NOT NULL,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    level TINYINT NOT NULL,
    sort_order INT DEFAULT 0,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_channel_cat_domain (domain_id)
  )`,

  // ── Raw category spellings seen in the source workbooks ──────────────────
  `CREATE TABLE IF NOT EXISTS channel_category_aliases (
    id INT AUTO_INCREMENT PRIMARY KEY,
    raw_value VARCHAR(150) UNIQUE NOT NULL,
    category_id INT NOT NULL,
    KEY idx_channel_alias_cat (category_id)
  )`,

  // ── Curated geography mapping for the messy "Geographical Domain" column ──
  `CREATE TABLE IF NOT EXISTS channel_geo_aliases (
    id INT AUTO_INCREMENT PRIMARY KEY,
    raw_value VARCHAR(190) UNIQUE NOT NULL,
    area_name VARCHAR(190),
    area_code VARCHAR(50),
    region VARCHAR(150),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,

  // ── Master registry: one row per channel user, keyed by mobile number ────
  `CREATE TABLE IF NOT EXISTS channel_entities (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mobile_number VARCHAR(20) UNIQUE NOT NULL,
    user_name VARCHAR(255) NOT NULL,
    category_id INT NOT NULL,
    status ENUM('active','canceled','inactive') DEFAULT 'active',
    geo_domain_raw VARCHAR(150),
    product VARCHAR(150),
    parent_mobile VARCHAR(20),
    owner_mobile VARCHAR(20),
    parent_id INT NULL,
    owner_id INT NULL,
    source ENUM('import','manual') DEFAULT 'import',
    first_seen_period DATE NULL,
    last_seen_period DATE NULL,
    import_code VARCHAR(40) NULL,
    imported_at DATETIME NULL,
    created_by VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_channel_ent_cat (category_id),
    KEY idx_channel_ent_status (status),
    KEY idx_channel_ent_geo (geo_domain_raw),
    KEY idx_channel_ent_parent (parent_id),
    KEY idx_channel_ent_owner (owner_id),
    KEY idx_channel_ent_name (user_name)
  )`,

  // ── Stock balance time series: entity x period x product ─────────────────
  `CREATE TABLE IF NOT EXISTS channel_stock_balances (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entity_id INT NOT NULL,
    period_month DATE NOT NULL,
    product VARCHAR(150) NOT NULL DEFAULT 'eTopUP',
    available_balance DECIMAL(20,2) DEFAULT 0,
    import_batch_id VARCHAR(36) NULL,
    source ENUM('import','manual') DEFAULT 'import',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_channel_balance (entity_id, period_month, product),
    KEY idx_channel_bal_period (period_month),
    KEY idx_channel_bal_batch (import_batch_id)
  )`,

  // ── Authoritative per-period summary block (the "Stock Balance Summary") ──
  `CREATE TABLE IF NOT EXISTS channel_stock_summary (
    id INT AUTO_INCREMENT PRIMARY KEY,
    period_month DATE NOT NULL,
    domain_id INT NOT NULL,
    category_id INT NULL,
    category_label VARCHAR(150) NOT NULL,
    level TINYINT NULL,
    stock_balance DECIMAL(20,2) DEFAULT 0,
    entity_count INT DEFAULT 0,
    source ENUM('import','manual') DEFAULT 'import',
    import_batch_id VARCHAR(36) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_channel_summary (period_month, domain_id, category_label),
    KEY idx_channel_sum_period (period_month)
  )`,

  // ── Staged detail rows for a previewed-but-uncommitted batch ─────────────
  // The preview parses the workbook once and parks the accepted rows here, so
  // confirming only has to send the batch id back. Round-tripping every row
  // through the browser put a hard ceiling on file size (the JSON body limit)
  // and let the client dictate what got written.
  `CREATE TABLE IF NOT EXISTS channel_import_rows (
    id INT AUTO_INCREMENT PRIMARY KEY,
    batch_id VARCHAR(36) NOT NULL,
    sheet_name VARCHAR(150),
    row_num INT,
    mobile_number VARCHAR(20) NOT NULL,
    user_name VARCHAR(255) NOT NULL,
    category_id INT NOT NULL,
    status ENUM('active','canceled','inactive') DEFAULT 'active',
    geo_domain_raw VARCHAR(150),
    product VARCHAR(150),
    parent_mobile VARCHAR(20),
    owner_mobile VARCHAR(20),
    available_balance DECIMAL(20,2) DEFAULT 0,
    has_warning TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_channel_rows_batch (batch_id),
    KEY idx_channel_rows_mobile (mobile_number)
  )`,

  // ── Import batches ───────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS channel_import_batches (
    id VARCHAR(36) PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    period_month DATE NULL,
    total_rows INT DEFAULT 0,
    valid_rows INT DEFAULT 0,
    inserted_rows INT DEFAULT 0,
    updated_rows INT DEFAULT 0,
    duplicate_rows INT DEFAULT 0,
    rejected_rows INT DEFAULT 0,
    warning_rows INT DEFAULT 0,
    discarded_rows INT DEFAULT 0,
    new_entities INT DEFAULT 0,
    detail_balance_total DECIMAL(20,2) DEFAULT 0,
    summary_balance_total DECIMAL(20,2) DEFAULT 0,
    reconciliation_variance DECIMAL(20,2) DEFAULT 0,
    summary_rows INT DEFAULT 0,
    status ENUM('staged','completed','failed') DEFAULT 'staged',
    error_log TEXT,
    imported_by VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL
  )`,

  // ── Rejected / skipped rows, kept for the review screen ──────────────────
  `CREATE TABLE IF NOT EXISTS channel_import_errors (
    id INT AUTO_INCREMENT PRIMARY KEY,
    batch_id VARCHAR(36) NOT NULL,
    sheet_name VARCHAR(150),
    row_num INT,
    severity ENUM('reject','warning','duplicate') DEFAULT 'reject',
    reason VARCHAR(255),
    raw_data TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_channel_err_batch (batch_id)
  )`,

  // ── Manager photos, keyed by TIN ──────────────────────────────────────────
  // Fetched from eTrade's Registration API during TIN verification (the
  // company manager's passport photo) or uploaded by hand to replace it. Keyed
  // by TIN rather than entity id so every record sharing a TIN — and a TIN
  // re-verified later — resolves to the same official photo.
  `CREATE TABLE IF NOT EXISTS channel_manager_photos (
    tin VARCHAR(20) PRIMARY KEY,
    photo MEDIUMBLOB NOT NULL,
    content_type VARCHAR(50) NOT NULL DEFAULT 'image/jpeg',
    source ENUM('etrade','upload') NOT NULL DEFAULT 'etrade',
    manager_name VARCHAR(150) NULL,
    manager_name_eng VARCHAR(150) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
];

/**
 * Columns added after the tables below shipped. `CREATE TABLE IF NOT EXISTS`
 * silently does nothing to a table that already exists, so every addition is
 * declared here as well and applied by ensureChannelSchema().
 */
const ADDED_COLUMNS = [
  // Which staged rows the validator flagged, so /confirm can let the operator
  // choose between importing and discarding them.
  ['channel_import_rows', 'has_warning', 'TINYINT(1) NOT NULL DEFAULT 0'],
  // Rows carrying warnings, and how many of them were dropped at confirm time.
  ['channel_import_batches', 'warning_rows', 'INT DEFAULT 0'],
  ['channel_import_batches', 'discarded_rows', 'INT DEFAULT 0'],

  // ── IDC hierarchy format ─────────────────────────────────────────────────
  // The per-level workbooks name their uplines *and* carry those uplines'
  // contact and region inline, so a retailer file describes the whole chain.
  // Every level also records the "existing business" the user runs.
  ['channel_entities', 'business_type', 'VARCHAR(150) NULL'],
  ['channel_import_rows', 'business_type', 'VARCHAR(150) NULL'],
  ['channel_import_rows', 'parent_name', 'VARCHAR(255) NULL'],
  ['channel_import_rows', 'owner_name', 'VARCHAR(255) NULL'],
  ['channel_import_rows', 'owner_region', 'VARCHAR(150) NULL'],
  // How many uplines the batch had to create because the file named them
  // before any Distributor / Sub-Distributor registration existed.
  ['channel_import_batches', 'hierarchy_created', 'INT DEFAULT 0'],

  // ── Retailer compliance details ──────────────────────────────────────────
  // Three optional columns that only the retailer sheet / form carries: the
  // tax identification number, where the shop physically sits, and the
  // national (Fayda) id. Distributors and Sub-Distributors leave them null.
  ['channel_entities', 'tin', 'VARCHAR(50) NULL'],
  ['channel_entities', 'location', 'VARCHAR(255) NULL'],
  ['channel_entities', 'national_id', 'VARCHAR(50) NULL'],
  ['channel_entities', 'woreda', 'VARCHAR(150) NULL'],
  ['channel_entities', 'sub_city', 'VARCHAR(150) NULL'],
  ['channel_entities', 'house_no', 'VARCHAR(100) NULL'],
  ['channel_entities', 'trade_name', 'VARCHAR(255) NULL'],
  ['channel_entities', 'photo_keywords', 'VARCHAR(255) NULL'],

  // ── TIN verification flag ───────────────────────────────────────────────
  // Stamped when the record's TIN is found on the eTrade / Ministry of
  // Revenue register — by the single-entity verify, a batch verify run, or
  // the importer's pre-verify — and cleared when the TIN changes or an
  // explicit "set false" arrives. A record without a TIN stays null: no
  // TIN, no verdict. NULL also means "never checked" for records that do
  // carry one.
  ['channel_entities', 'tin_verified', 'TINYINT(1) NULL DEFAULT NULL'],

  // ── GPS coordinates captured at registration ─────────────────────────────
  // The single-registration form asks the operator to share their device
  // location when registering a retailer, so the shop's physical position is
  // recorded alongside the free-text address. DECIMAL(10,7) spans ±999° with
  // ~1cm precision — ample for both latitude and longitude.
  ['channel_entities', 'latitude', 'DECIMAL(10,7) NULL'],
  ['channel_entities', 'longitude', 'DECIMAL(10,7) NULL'],
  // When the position was taken and how good it was (meters), so a stale or
  // low-quality fix can be told apart from a fresh, accurate one.
  ['channel_entities', 'location_captured_at', 'DATETIME NULL'],
  ['channel_entities', 'location_accuracy_m', 'DECIMAL(8,2) NULL'],

  // ── Reverse-geocoded address parts ───────────────────────────────────────
  // The registration form resolves the captured position against Nominatim
  // (OpenStreetMap) in the operator's browser and sends the structured parts
  // along, so reports can group by country/city without parsing free text.
  // The composed "street, city, country" string also fills the location
  // column when the operator left it empty.
  ['channel_entities', 'addr_country', 'VARCHAR(100) NULL'],
  ['channel_entities', 'addr_city', 'VARCHAR(150) NULL'],
  ['channel_entities', 'addr_street', 'VARCHAR(255) NULL'],
  ['channel_import_rows', 'tin', 'VARCHAR(50) NULL'],
  ['channel_import_rows', 'location', 'VARCHAR(255) NULL'],
  ['channel_import_rows', 'national_id', 'VARCHAR(50) NULL'],
  ['channel_import_rows', 'woreda', 'VARCHAR(150) NULL'],
  ['channel_import_rows', 'sub_city', 'VARCHAR(150) NULL'],
  ['channel_import_rows', 'house_no', 'VARCHAR(100) NULL'],
  ['channel_import_rows', 'trade_name', 'VARCHAR(255) NULL'],

  // ── Which import a user came from ────────────────────────────────────────
  // Deleting a batch has to be able to take the users that batch created with
  // it, and the staged rows are purged the moment the batch commits — so the
  // link is kept on the entity itself. `first_batch_id` records who introduced
  // the user, `last_batch_id` who refreshed them most recently; a manually
  // registered user has neither and is therefore never touched by a batch
  // delete.
  ['channel_entities', 'first_batch_id', 'VARCHAR(36) NULL'],
  ['channel_entities', 'last_batch_id', 'VARCHAR(36) NULL'],

  // ── The short id an operator can quote ───────────────────────────────────
  // The batch uuid is the key, but nobody can read `3031541a-a558-…` over the
  // phone. Every import also carries `IMP-YYYYMMDD-NN`, stored on the batch and
  // stamped onto each user it writes so a screen can show which import a record
  // came from, and when, without a join.
  ['channel_import_batches', 'import_code', 'VARCHAR(40) NULL'],
  ['channel_entities', 'import_code', 'VARCHAR(40) NULL'],
  ['channel_entities', 'imported_at', 'DATETIME NULL'],

  // ── Auto-created vs directly imported ────────────────────────────────────
  // A retailer file names its uplines, and the import creates Distributor /
  // Sub-Distributor rows the user never typed — they are real entities in the
  // hierarchy, but they inflate every dashboard count and dimension chart if
  // they are not distinguished from the rows the file actually carried.
  ['channel_entities', 'is_inferred', 'TINYINT(1) NOT NULL DEFAULT 0'],

  // ── The human-readable identifier an operator reads out ──────────────────
  // Every Distributor, Sub-Distributor and Retailer gets its own code
  // (`IDC-D-0001`, `IDC-SD-0001`, `IDC-R-0001`) — stable, unique across the
  // registry and independent of the internal row id, so a record can be quoted
  // on a form or in a phone call. Assigned by assignIdentifierCodes().
  ['channel_entities', 'identifier_code', 'VARCHAR(40) NULL'],
];

// Indexes added after the fact, for the columns above.
const ADDED_INDEXES = [
  ['channel_import_batches', 'uq_channel_batch_code', 'UNIQUE KEY uq_channel_batch_code (import_code)'],
  ['channel_entities', 'idx_channel_ent_code', 'KEY idx_channel_ent_code (import_code)'],
  // Deleting a batch finds its users and re-counts them by batch id — without
  // these the predicate scans the whole registry once per delete page.
  ['channel_entities', 'idx_channel_ent_first_batch', 'KEY idx_channel_ent_first_batch (first_batch_id)'],
  ['channel_entities', 'idx_channel_ent_last_batch', 'KEY idx_channel_ent_last_batch (last_batch_id)'],
  // The code has to be unique, and lookups by it are exact.
  ['channel_entities', 'uq_channel_ent_identifier', 'UNIQUE KEY uq_channel_ent_identifier (identifier_code)'],
];

// Level → the tag used inside an identifier code (IDC-D-0001 / IDC-SD-0001 …).
const IDENTIFIER_LEVEL_TAG = { 1: 'D', 2: 'SD', 3: 'R' };

const SEED_DOMAINS = [
  ['IDC', 'IDC (Indirect Channel)', 1],
  ['YIMULU', 'Yimulu Only', 2],
  ['ENTERPRISE', 'Enterprise', 3],
];

// domain code, category code, display name, level, sort order
const SEED_CATEGORIES = [
  ['IDC', 'IC_DISTRIBUTOR', 'Distributor', 1, 1],
  ['IDC', 'IC_SUB_DISTRIBUTOR', 'Sub Distributor', 2, 2],
  ['IDC', 'IC_RETAILER', 'Retailer', 3, 3],
  ['YIMULU', 'YIMULU_DISTRIBUTOR', 'Distributor', 1, 1],
  ['YIMULU', 'YIMULU_SUB_DISTRIBUTOR', 'Sub Distributor', 2, 2],
  ['YIMULU', 'YIMULU_RETAILER', 'Retailer', 3, 3],
  ['ENTERPRISE', 'ENTERPRISE_L1', 'Bank, Fintech & International', 1, 1],
  // AC- rows sit under banks / fintech / postal partners, so they hang off Enterprise.
  // Only this one row needs changing if the AC- prefix turns out to mean something else.
  ['ENTERPRISE', 'AC_SUB_DISTRIBUTOR', 'Agent Sub Distributor', 2, 2],
  // The retailer extract carries AC-Retailer rows owned by fintech partners
  // (e.g. kifiya Financial Technology PLC), so agents retail at level 3 too.
  ['ENTERPRISE', 'AC_RETAILER', 'Agent Retailer', 3, 3],
];

// Every raw spelling observed in the source workbooks → canonical category.
const SEED_ALIASES = [
  ['IC-Distributor', 'IC_DISTRIBUTOR'],
  ['IC Distributor', 'IC_DISTRIBUTOR'],
  ['IC-Distributer', 'IC_DISTRIBUTOR'],
  ['IC-Sub_Distributer', 'IC_SUB_DISTRIBUTOR'],
  ['IC-Sub_Distributor', 'IC_SUB_DISTRIBUTOR'],
  ['IC Sub Distributor', 'IC_SUB_DISTRIBUTOR'],
  ['IC-Retailer', 'IC_RETAILER'],
  ['IC Retalier', 'IC_RETAILER'],
  ['IC-Retalier', 'IC_RETAILER'],
  ['AC-Sub_Distributer', 'AC_SUB_DISTRIBUTOR'],
  ['AC-Sub_Distributor', 'AC_SUB_DISTRIBUTOR'],
  ['AC Sub Distributor', 'AC_SUB_DISTRIBUTOR'],
  ['AC-Retailer', 'AC_RETAILER'],
  ['AC-Retaller', 'AC_RETAILER'],
  ['AC-Retalier', 'AC_RETAILER'],
  ['AC Retailer', 'AC_RETAILER'],
  ['Enterprise', 'ENTERPRISE_L1'],
  ['Bank, Fintech & International', 'ENTERPRISE_L1'],
  ['Yimulu Distributor', 'YIMULU_DISTRIBUTOR'],
  ['Yimulu sub distributor', 'YIMULU_SUB_DISTRIBUTOR'],
  ['Yimulu Sub Distributor', 'YIMULU_SUB_DISTRIBUTOR'],
  ['Yimulu Retailer', 'YIMULU_RETAILER'],
];

// Summary block ("Domain" / "Category" / "Stock Balance") → canonical category,
// matched on domain + hierarchy level.
const SUMMARY_LEVEL_MAP = {
  IDC: { 1: 'IC_DISTRIBUTOR', 2: 'IC_SUB_DISTRIBUTOR', 3: 'IC_RETAILER' },
  YIMULU: { 1: 'YIMULU_DISTRIBUTOR', 2: 'YIMULU_SUB_DISTRIBUTOR', 3: 'YIMULU_RETAILER' },
  ENTERPRISE: { 1: 'ENTERPRISE_L1', 2: 'AC_SUB_DISTRIBUTOR', 3: 'AC_RETAILER' },
};

const SUMMARY_DOMAIN_MAP = {
  IDC: 'IDC',
  'YIMULU ONLY': 'YIMULU',
  YIMULU: 'YIMULU',
  ENTERPRISE: 'ENTERPRISE',
};

const SUMMARY_CATEGORY_LEVELS = {
  DISTRIBUTOR: 1,
  'SUB DISTRIBUTOR': 2,
  'SUB_DISTRIBUTOR': 2,
  SUBDISTRIBUTOR: 2,
  RETAILER: 3,
  'AGENT RETAILER': 3,
  'AC RETAILER': 3,
  'AC-RETAILER': 3,
  'AGENT SUB DISTRIBUTOR': 2,
  'AGENT SUB_DISTRIBUTOR': 2,
  'AGENT SUBDISTRIBUTOR': 2,
  'BANK, FINTECH & INTERNATIONAL': 1,
  'BANK FINTECH INTERNATIONAL': 1,
};

let ensured = false;
let ensuring = null;

/** Add one column if it is missing — a no-op once the schema is current. */
async function ensureColumn(table, column, definition) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows[0].n > 0) return false;
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/**
 * Give every registry row an identifier code, once.
 *
 * The code is `<domain>-<level tag>-<sequence>` — `IDC-D-0001` for a
 * Distributor, `IDC-SD-0001` for a Sub-Distributor, `IDC-R-0001` for a
 * Retailer — with the sequence counting per domain and level, so the three
 * levels number themselves independently and a code never changes afterwards.
 *
 * Only rows with no code are touched, which makes this safe to call after an
 * import, after a hand registration, and once on startup to backfill a registry
 * written before the column existed.
 *
 * @returns {Promise<number>} how many rows were given a code
 */
async function assignIdentifierCodes() {
  const [missing] = await pool.query(
    `SELECT e.id, c.level, d.code AS domain_code
       FROM channel_entities e
       JOIN channel_categories c ON c.id = e.category_id
       JOIN channel_domains d ON d.id = c.domain_id
      WHERE e.identifier_code IS NULL OR e.identifier_code = ''
      ORDER BY e.id`
  );
  if (!missing.length) return 0;

  // Continue where the existing codes left off, per domain + level.
  const [existing] = await pool.query(
    `SELECT d.code AS domain_code, c.level,
            MAX(CAST(SUBSTRING_INDEX(e.identifier_code, '-', -1) AS UNSIGNED)) AS max_seq
       FROM channel_entities e
       JOIN channel_categories c ON c.id = e.category_id
       JOIN channel_domains d ON d.id = c.domain_id
      WHERE e.identifier_code IS NOT NULL AND e.identifier_code <> ''
      GROUP BY d.code, c.level`
  );
  const next = new Map(existing.map((r) => [`${r.domain_code}|${r.level}`, Number(r.max_seq) || 0]));

  const assignments = [];
  for (const row of missing) {
    const key = `${row.domain_code}|${row.level}`;
    const seq = (next.get(key) || 0) + 1;
    next.set(key, seq);
    const tag = IDENTIFIER_LEVEL_TAG[row.level] || 'X';
    assignments.push([row.id, `${row.domain_code}-${tag}-${String(seq).padStart(4, '0')}`]);
  }

  for (let i = 0; i < assignments.length; i += 200) {
    const chunk = assignments.slice(i, i + 200);
    await pool.query(
      `UPDATE channel_entities
          SET identifier_code = CASE id ${chunk.map(() => 'WHEN ? THEN ?').join(' ')} END
        WHERE id IN (${chunk.map(() => '?').join(',')})
          AND (identifier_code IS NULL OR identifier_code = '')`,
      [...chunk.flat(), ...chunk.map(([id]) => id)]
    );
  }

  return assignments.length;
}

/** Add one index if it is missing — a no-op once the schema is current. */
async function ensureIndex(table, index, definition) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index]
  );
  if (rows[0].n > 0) return false;
  await pool.query(`ALTER TABLE ${table} ADD ${definition}`);
  return true;
}

async function ensureChannelSchema() {
  if (ensured) return;
  if (ensuring) return ensuring;

  ensuring = (async () => {
    for (const sql of STATEMENTS) {
      await pool.query(sql);
    }

    for (const [table, column, definition] of ADDED_COLUMNS) {
      await ensureColumn(table, column, definition);
    }

    // Backfill the TIN verification flag once: a record whose manager photo
    // was stored by the verify flow had its TIN confirmed against eTrade /
    // MoR at that moment, so it starts as verified. Both sides normalize the
    // TIN (digits only, zero-padded to 10) so legacy unpadded spellings
    // match. Only null flags are touched — an explicit not-verified verdict
    // is never overridden — and the query becomes a no-op once every TIN row
    // has a verdict.
    await pool.query(
      `UPDATE channel_entities e
         JOIN channel_manager_photos mp
           ON mp.tin = LPAD(REPLACE(REPLACE(REPLACE(e.tin, ' ', ''), '-', ''), '+', ''), 10, '0')
          SET e.tin_verified = 1
        WHERE e.tin IS NOT NULL AND e.tin <> '' AND e.tin_verified IS NULL`
    );

    // ── Registry permission catalog ──────────────────────────────────────
    // view / edit / delete each come in two strengths: the bare permission
    // reaches every record; the *_own variant is confined to the records the
    // caller's account recorded (channel_entities.created_by — the operator
    // who ran the import or filled the registration form). Seeded here so a
    // deploy lights them up in the role editor with no manual script.
    //
    // Guard: the permission catalog lives in the BASE tables (permissions,
    // roles, role_permissions), which are created outside this module. On a
    // fresh environment (e.g. the CI database) they may not exist yet — the
    // channel schema itself is still complete, so skip the seeding instead
    // of failing the whole ensure. Re-run the base setup to enable it.
    const [basePermTables] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name IN ('permissions', 'roles', 'role_permissions')`
    );
    const baseTablesReady = basePermTables[0].n === 3;
    if (!baseTablesReady) {
      console.warn('[channelDbSetup] base permission tables (permissions/roles/role_permissions) not present — skipping registry permission seeding');
    }
    const REGISTRY_PERMISSIONS = [
      { name: 'channel_entities.view',       description: 'View all registered channel data (Entity Registry and reports)',        action: 'view' },
      { name: 'channel_entities.view_own',   description: 'View only channel records recorded by own account',                     action: 'view_own' },
      { name: 'channel_entities.edit',       description: 'Edit registered channel data (dashboard registry and reports)',         action: 'edit' },
      { name: 'channel_entities.edit_own',   description: 'Edit only channel records recorded by own account',                     action: 'edit_own' },
      { name: 'channel_entities.delete',     description: 'Delete registered channel data (dashboard registry and reports)',       action: 'delete' },
      { name: 'channel_entities.delete_own', description: 'Delete only channel records recorded by own account',                   action: 'delete_own' },
    ];
    for (const p of REGISTRY_PERMISSIONS) {
      if (!baseTablesReady) break;
      const [ex] = await pool.query('SELECT id FROM permissions WHERE name = ?', [p.name]);
      if (ex.length === 0) {
        await pool.query(
          'INSERT INTO permissions (name, description, module, action, section) VALUES (?, ?, ?, ?, ?)',
          [p.name, p.description, 'channel_entities', p.action, 'INDIRECT_CHANNEL']
        );
      }
    }

    // GLOBAL-scope roles hold the master admin's every right, so the
    // registry permissions land in their grants too — the interface reads
    // the token's permission list, and without the grant it would hide the
    // registry from the one account that must always see it.
    if (baseTablesReady) {
      await pool.query(
        `INSERT IGNORE INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r JOIN permissions p
           ON p.module = 'channel_entities' AND p.section = 'INDIRECT_CHANNEL'
          WHERE r.scope = 'GLOBAL'`
      );
    }

    for (const [table, index, definition] of ADDED_INDEXES) {
      await ensureIndex(table, index, definition);
    }

    for (const [code, name, sort] of SEED_DOMAINS) {
      await pool.query(
        'INSERT INTO channel_domains (code, name, sort_order) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), sort_order = VALUES(sort_order)',
        [code, name, sort]
      );
    }

    const [domains] = await pool.query('SELECT id, code FROM channel_domains');
    const domainId = Object.fromEntries(domains.map((d) => [d.code, d.id]));

    for (const [dCode, code, name, level, sort] of SEED_CATEGORIES) {
      await pool.query(
        'INSERT INTO channel_categories (domain_id, code, name, level, sort_order) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), level = VALUES(level), domain_id = VALUES(domain_id)',
        [domainId[dCode], code, name, level, sort]
      );
    }

    const [cats] = await pool.query('SELECT id, code FROM channel_categories');
    const catId = Object.fromEntries(cats.map((c) => [c.code, c.id]));

    for (const [raw, code] of SEED_ALIASES) {
      await pool.query(
        'INSERT INTO channel_category_aliases (raw_value, category_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE category_id = VALUES(category_id)',
        [raw, catId[code]]
      );
    }

    // Backfill identifier codes for anything registered before the column
    // existed. Together with the unique index, this is what makes the codes
    // present on every list without each screen having to compute one.
    await assignIdentifierCodes();

    ensured = true;
  })();

  try {
    return await ensuring;
  } finally {
    ensuring = null;
  }
}

module.exports = {
  ensureChannelSchema,
  assignIdentifierCodes,
  SUMMARY_LEVEL_MAP,
  SUMMARY_DOMAIN_MAP,
  SUMMARY_CATEGORY_LEVELS,
};
