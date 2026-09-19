/**
 * SQLite em memória com o schema REAL do backend (derivado das migrations em
 * `database/migrations`), usado pelas suítes de integração/endpoint.
 *
 * Por que existe:
 *  - o backend de produção roda em PostgreSQL, mas a suíte precisa rodar sem
 *    servidor externo (determinística, `sqlite3` é a única dependência nativa);
 *  - as suítes antigas criavam um knex `:memory:` sem rodar migrations
 *    (`src/database/migrations` não existe), o que gerava `no such table`;
 *  - o pool é fixado em 1 conexão porque cada conexão nova em `:memory:` abre
 *    um banco vazio diferente.
 *
 * O schema cobre as tabelas/colunas usadas pelos fluxos sob teste. Colunas
 * JSON são TEXT (mesma serialização usada pelos models) e booleanos são
 * INTEGER (0/1), exatamente como o driver sqlite3 entrega.
 *
 * Datas são declaradas como TEXT de propósito: no SQLite uma coluna declarada
 * `DATE`/`DATETIME` recebe afinidade NUMÉRICA, e comparar '2026-12-01' com o
 * timestamp numérico gerado pelo driver converte os dois para 2026 — fazendo
 * `next_billing_date >= now` retornar falso e `hasActiveSubscription` quebrar.
 * Com afinidade TEXT a comparação lexicográfica 'YYYY-MM-DD...' funciona.
 */
const knexFactory = require('knex');
const { installPgCompat } = require('./sqlitePgCompat');

const db = knexFactory({
  client: 'sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true,
  pool: { min: 1, max: 1 },
});

/**
 * O driver sqlite3 não serializa `Date`: o binding vira a string
 * "[object Object]" (verificado em `select ?`), o que quebra silenciosamente
 * qualquer comparação de data feita com `new Date()` no código de produção
 * (ex.: `Partner.hasActiveSubscription`, que compara `next_billing_date >= now`).
 * `prepBindings` é o hook oficial do knex chamado antes de cada execução;
 * normalizamos Date para 'YYYY-MM-DD HH:MM:SS.mmm' em UTC — formato comparável
 * lexicograficamente com as colunas TEXT e com `CURRENT_TIMESTAMP` do SQLite.
 */
function formatSqliteDate(date) {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Timestamp no formato gravado pelo harness ('YYYY-MM-DD HH:MM:SS.mmm', UTC).
 * Use nos fixtures sempre que a coluna for comparada em SQL com um `Date`
 * (ex.: `TowProposal.findExpiringSoon`), garantindo comparação lexicográfica
 * coerente. NÃO serve para colunas comparadas com a referência de deadline do
 * SQLite do harness — para essas use `sqliteEpochMs`.
 */
function sqliteTimestamp(value = Date.now()) {
  return formatSqliteDate(value instanceof Date ? value : new Date(value));
}

/**
 * Epoch ms — formato de deadline do SQLite do harness, o mesmo devolvido por
 * `EmergencyRequest.proposalDeadlineReference` (Date no PostgreSQL, epoch ms no
 * SQLite; ver `resolveProposalDeadlineReference`).
 *
 * Use em `expires_at` sempre que a consulta comparar a coluna com essa
 * referência (ex.: `EmergencyRequest.expireProposals`,
 * `EmergencyRequest.acceptProposal`). Comparar um TEXT ISO ('2026-…') com o
 * epoch ms devolvido pela referência nunca casa: com a afinidade TEXT da coluna
 * o número vira texto e a ordem lexicográfica é outra.
 *
 * `proposal_selection_deadline` continua em ISO (`sqliteTimestamp`/ISO string)
 * neste harness porque também é lida em JS (`isFutureProposalDeadline`) e uma
 * string de dígitos não é parseável por `new Date(string)`.
 */
function sqliteEpochMs(value = Date.now()) {
  return value instanceof Date ? value.getTime() : Number(value);
}

function normalizeBinding(value) {
  if (value instanceof Date) {
    return formatSqliteDate(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeBinding);
  }
  return value;
}

const basePrepBindings = db.client.prepBindings.bind(db.client);
db.client.prepBindings = (bindings = []) => basePrepBindings(bindings).map(normalizeBinding);

// Traduz as construções PG-only (`::json->>`, `::text`, ILIKE) usadas por
// alguns models para o dialeto SQLite — ver tests/helpers/sqlitePgCompat.js.
installPgCompat(db);

const TABLES = [
  'users',
  'partners',
  'partner_services',
  'categories',
  'services',
  'mechanics',
  'appointments',
  'reviews',
  'emergency_requests',
  'tow_proposals',
  'delivery_orders',
  'purchase_orders',
  'subscriptions',
  'subscription_history',
  'system_settings',
  'products',
  'payments',
  'revoked_tokens',
  'notifications',
  'real_time_tracking',
  'service_modules',
  'tow_vehicles',
  'tow_vehicle_documents',
];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    role VARCHAR(20) DEFAULT 'user',
    cpf VARCHAR(14),
    cnpj VARCHAR(18),
    address TEXT,
    is_active INTEGER DEFAULT 1,
    email_verified INTEGER DEFAULT 0,
    firebase_token VARCHAR(255),
    fcm_token VARCHAR(255),
    onboarding_partner_type VARCHAR(40),
    onboarding_stage VARCHAR(40),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS partners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type VARCHAR(40) DEFAULT 'mechanic',
    business_name VARCHAR(150),
    description TEXT,
    specialties TEXT,
    address TEXT,
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    phone VARCHAR(20),
    whatsapp VARCHAR(20),
    website VARCHAR(255),
    instagram VARCHAR(255),
    facebook VARCHAR(255),
    hourly_rate DECIMAL(10, 2),
    service_fee DECIMAL(10, 2),
    delivery_fee DECIMAL(10, 2),
    is_verified INTEGER DEFAULT 0,
    is_available INTEGER DEFAULT 1,
    is_online INTEGER DEFAULT 0,
    working_hours TEXT,
    payment_methods TEXT,
    service_areas TEXT,
    experience_years INTEGER,
    certifications TEXT,
    insurance_info TEXT,
    warranty_info TEXT,
    emergency_service INTEGER DEFAULT 0,
    home_service INTEGER DEFAULT 0,
    workshop_service INTEGER DEFAULT 0,
    delivery_service INTEGER DEFAULT 0,
    service_radius DECIMAL(10, 2),
    delivery_radius DECIMAL(10, 2),
    vehicle_type VARCHAR(40),
    license_plate VARCHAR(10),
    cnh_number VARCHAR(20),
    cnh_category VARCHAR(5),
    store_categories TEXT,
    has_delivery INTEGER DEFAULT 0,
    min_order_value DECIMAL(10, 2),
    delivery_time_minutes INTEGER,
    rating DECIMAL(3, 2) DEFAULT 0,
    total_reviews INTEGER DEFAULT 0,
    total_services INTEGER DEFAULT 0,
    total_emergencies INTEGER DEFAULT 0,
    total_deliveries INTEGER DEFAULT 0,
    total_sales INTEGER DEFAULT 0,
    approval_status VARCHAR(20) DEFAULT 'pending',
    approved_at TEXT,
    approved_by INTEGER,
    rejection_reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS partner_services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER,
    name VARCHAR(150),
    description TEXT,
    detailed_description TEXT,
    price DECIMAL(10, 2),
    price_type VARCHAR(20),
    min_price DECIMAL(10, 2),
    max_price DECIMAL(10, 2),
    estimated_duration_minutes INTEGER,
    is_available INTEGER DEFAULT 1,
    emergency_service INTEGER DEFAULT 0,
    home_service INTEGER DEFAULT 0,
    workshop_service INTEGER DEFAULT 0,
    category VARCHAR(80),
    subcategory VARCHAR(80),
    tags TEXT,
    specialties TEXT,
    required_tools TEXT,
    required_parts TEXT,
    technical_requirements TEXT,
    warranty_info TEXT,
    warranty_days INTEGER,
    total_orders INTEGER DEFAULT 0,
    completed_orders INTEGER DEFAULT 0,
    cancelled_orders INTEGER DEFAULT 0,
    average_rating DECIMAL(3, 2) DEFAULT 0,
    total_reviews INTEGER DEFAULT 0,
    requires_approval INTEGER DEFAULT 0,
    is_featured INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    service_hours TEXT,
    unavailable_dates TEXT,
    images TEXT,
    before_after_images TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(100),
    description TEXT,
    icon VARCHAR(100),
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(150),
    description TEXT,
    category_id INTEGER,
    base_price DECIMAL(10, 2),
    estimated_duration_minutes INTEGER,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS mechanics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    business_name VARCHAR(255),
    description TEXT,
    specialties TEXT,
    address TEXT,
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    phone VARCHAR(40),
    whatsapp VARCHAR(40),
    hourly_rate DECIMAL(10, 2),
    service_fee DECIMAL(10, 2),
    experience_years INTEGER,
    is_verified INTEGER DEFAULT 0,
    is_available INTEGER DEFAULT 1,
    emergency_service INTEGER DEFAULT 0,
    home_service INTEGER DEFAULT 0,
    workshop_service INTEGER DEFAULT 1,
    rating DECIMAL(3, 2) DEFAULT 0,
    total_reviews INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    partner_id INTEGER,
    service_id INTEGER,
    scheduled_date TEXT,
    status VARCHAR(30) DEFAULT 'pending',
    description TEXT,
    address TEXT,
    total_price DECIMAL(10, 2),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    mechanic_id INTEGER,
    partner_id INTEGER,
    appointment_id INTEGER,
    emergency_request_id INTEGER,
    delivery_order_id INTEGER,
    purchase_order_id INTEGER,
    entity_type VARCHAR(40),
    entity_id INTEGER,
    rating INTEGER,
    comment TEXT,
    is_public INTEGER DEFAULT 1,
    is_verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS emergency_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type VARCHAR(40),
    request_type VARCHAR(40),
    description TEXT,
    photos TEXT,
    vehicle_info TEXT,
    vehicle_plate VARCHAR(10),
    vehicle_model VARCHAR(80),
    vehicle_year VARCHAR(10),
    vehicle_color VARCHAR(40),
    location_type VARCHAR(30),
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    address TEXT,
    landmarks TEXT,
    status VARCHAR(30) DEFAULT 'pending',
    partner_id INTEGER,
    accepted_by INTEGER,
    estimated_price DECIMAL(10, 2),
    final_price DECIMAL(10, 2),
    price_breakdown TEXT,
    accepted_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    estimated_duration_minutes INTEGER,
    actual_duration_minutes INTEGER,
    notes TEXT,
    solution_description TEXT,
    parts_used TEXT,
    warranty_info TEXT,
    urgency VARCHAR(20) DEFAULT 'medium',
    is_urgent INTEGER DEFAULT 0,
    rating INTEGER,
    review_comment TEXT,
    reviewed_at TEXT,
    view_count INTEGER DEFAULT 0,
    response_count INTEGER DEFAULT 0,
    proposal_status VARCHAR(30),
    proposal_selection_deadline TEXT,
    max_proposals INTEGER,
    proposals_received INTEGER DEFAULT 0,
    first_proposal_at TEXT,
    last_proposal_at TEXT,
    search_radius_km DECIMAL(10, 2),
    selected_proposal_id INTEGER,
    cancellation_reason TEXT,
    cancellation_by VARCHAR(40),
    cancelled_at TEXT,
    vehicle_origin_address TEXT,
    vehicle_origin_latitude DECIMAL(10, 8),
    vehicle_origin_longitude DECIMAL(11, 8),
    vehicle_destination_address TEXT,
    vehicle_destination_latitude DECIMAL(10, 8),
    vehicle_destination_longitude DECIMAL(11, 8),
    vehicle_type VARCHAR(40),
    vehicle_notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS tow_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emergency_request_id INTEGER,
    partner_id INTEGER,
    proposed_price DECIMAL(10, 2),
    estimated_time_minutes INTEGER,
    message TEXT,
    tow_truck_type VARCHAR(60),
    tow_capacity_kg INTEGER,
    has_winch INTEGER DEFAULT 0,
    equipment_details TEXT,
    status VARCHAR(30) DEFAULT 'pending',
    expires_at TEXT,
    accepted_at TEXT,
    responded_at TEXT,
    view_count INTEGER DEFAULT 0,
    last_viewed_at TEXT,
    partner_distance_km DECIMAL(10, 2),
    partner_eta_minutes INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS delivery_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    motoboy_id INTEGER,
    type VARCHAR(30),
    items TEXT,
    items_description TEXT,
    pickup_location TEXT,
    pickup_latitude DECIMAL(10, 8),
    pickup_longitude DECIMAL(11, 8),
    pickup_address TEXT,
    pickup_instructions TEXT,
    delivery_location TEXT,
    delivery_latitude DECIMAL(10, 8),
    delivery_longitude DECIMAL(11, 8),
    delivery_address TEXT,
    delivery_instructions TEXT,
    status VARCHAR(30) DEFAULT 'pending',
    delivery_fee DECIMAL(10, 2),
    items_price DECIMAL(10, 2),
    total_price DECIMAL(10, 2),
    price_breakdown TEXT,
    accepted_at TEXT,
    picked_up_at TEXT,
    delivered_at TEXT,
    estimated_delivery_minutes INTEGER,
    actual_delivery_minutes INTEGER,
    fuel_info TEXT,
    parts_info TEXT,
    store_info TEXT,
    urgency VARCHAR(20),
    is_urgent INTEGER DEFAULT 0,
    payment_method VARCHAR(30),
    payment_status VARCHAR(30),
    paid_at TEXT,
    rating INTEGER,
    review_comment TEXT,
    reviewed_at TEXT,
    notes TEXT,
    delivery_proof TEXT,
    tracking_info TEXT,
    distance_km DECIMAL(10, 2),
    view_count INTEGER DEFAULT 0,
    response_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    store_id INTEGER,
    type VARCHAR(30) DEFAULT 'regular',
    items TEXT,
    items_description TEXT,
    total_items_quantity INTEGER,
    subtotal DECIMAL(10, 2),
    delivery_fee DECIMAL(10, 2),
    taxes DECIMAL(10, 2),
    discount DECIMAL(10, 2),
    total_price DECIMAL(10, 2),
    price_breakdown TEXT,
    status VARCHAR(30) DEFAULT 'pending',
    delivery_address TEXT,
    delivery_latitude DECIMAL(10, 8),
    delivery_longitude DECIMAL(11, 8),
    delivery_instructions TEXT,
    delivery_contact_name VARCHAR(150),
    delivery_contact_phone VARCHAR(20),
    has_delivery INTEGER DEFAULT 0,
    estimated_delivery_minutes INTEGER,
    scheduled_delivery_at TEXT,
    delivered_at TEXT,
    actual_delivery_minutes INTEGER,
    delivery_motoboy_id INTEGER,
    payment_method VARCHAR(30),
    payment_status VARCHAR(30) DEFAULT 'pending',
    paid_at TEXT,
    payment_info TEXT,
    urgency VARCHAR(20) DEFAULT 'medium',
    is_urgent INTEGER DEFAULT 0,
    rating INTEGER,
    review_comment TEXT,
    reviewed_at TEXT,
    notes TEXT,
    special_instructions TEXT,
    delivery_proof TEXT,
    invoice_info TEXT,
    view_count INTEGER DEFAULT 0,
    response_count INTEGER DEFAULT 0,
    emergency_request_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER,
    type VARCHAR(40),
    monthly_fee DECIMAL(10, 2),
    start_date TEXT,
    end_date TEXT,
    due_date TEXT,
    next_billing_date TEXT,
    status VARCHAR(30) DEFAULT 'pending_payment',
    payment_method VARCHAR(30),
    payment_gateway VARCHAR(40),
    gateway_subscription_id VARCHAR(120),
    auto_renew INTEGER DEFAULT 1,
    billing_address TEXT,
    notes TEXT,
    failed_attempts INTEGER DEFAULT 0,
    last_payment_attempt TEXT,
    last_successful_payment TEXT,
    cancelled_at TEXT,
    cancellation_reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS subscription_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER,
    partner_id INTEGER,
    action VARCHAR(40),
    amount DECIMAL(10, 2),
    previous_amount DECIMAL(10, 2),
    currency VARCHAR(6) DEFAULT 'BRL',
    payment_id INTEGER,
    gateway_transaction_id VARCHAR(120),
    payment_method VARCHAR(30),
    billing_period_start TEXT,
    billing_period_end TEXT,
    next_billing_date TEXT,
    reason TEXT,
    admin_notes TEXT,
    system_notes TEXT,
    previous_status VARCHAR(30),
    new_status VARCHAR(30),
    performed_by INTEGER,
    performed_by_role VARCHAR(30),
    ip_address VARCHAR(60),
    user_agent TEXT,
    metadata TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS system_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_key VARCHAR(120) UNIQUE,
    setting_value TEXT,
    data_type VARCHAR(20) DEFAULT 'string',
    description TEXT,
    category VARCHAR(40),
    is_public INTEGER DEFAULT 0,
    is_editable INTEGER DEFAULT 1,
    validation_rules TEXT,
    default_value TEXT,
    min_value TEXT,
    max_value TEXT,
    updated_by INTEGER,
    updated_by_role VARCHAR(30),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER,
    name VARCHAR(150),
    description TEXT,
    sku VARCHAR(80),
    barcode VARCHAR(80),
    category VARCHAR(80),
    subcategory VARCHAR(80),
    product_type VARCHAR(40),
    price DECIMAL(10, 2),
    cost_price DECIMAL(10, 2),
    sale_price DECIMAL(10, 2),
    wholesale_price DECIMAL(10, 2),
    stock INTEGER DEFAULT 0,
    min_stock INTEGER DEFAULT 0,
    max_stock INTEGER,
    track_stock INTEGER DEFAULT 1,
    allow_backorder INTEGER DEFAULT 0,
    weight DECIMAL(10, 3),
    length DECIMAL(10, 2),
    width DECIMAL(10, 2),
    height DECIMAL(10, 2),
    images TEXT,
    featured_image VARCHAR(255),
    attributes TEXT,
    specifications TEXT,
    compatibility TEXT,
    slug VARCHAR(180),
    meta_title VARCHAR(180),
    meta_description TEXT,
    tags TEXT,
    is_active INTEGER DEFAULT 1,
    is_featured INTEGER DEFAULT 0,
    is_digital INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    sales_count INTEGER DEFAULT 0,
    rating_average DECIMAL(3, 2) DEFAULT 0,
    rating_count INTEGER DEFAULT 0,
    fuel_type VARCHAR(40),
    fuel_liters DECIMAL(10, 2),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    partner_id INTEGER,
    subscription_id INTEGER,
    purchase_order_id INTEGER,
    delivery_order_id INTEGER,
    emergency_request_id INTEGER,
    amount DECIMAL(10, 2),
    fee DECIMAL(10, 2),
    net_amount DECIMAL(10, 2),
    currency VARCHAR(6) DEFAULT 'BRL',
    method VARCHAR(40),
    payment_method VARCHAR(40),
    status VARCHAR(30) DEFAULT 'pending',
    gateway VARCHAR(40),
    gateway_transaction_id VARCHAR(120),
    gateway_response TEXT,
    metadata TEXT,
    paid_at TEXT,
    refunded_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS revoked_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    user_id INTEGER,
    expires_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type VARCHAR(60),
    title VARCHAR(180),
    message TEXT,
    detailed_message TEXT,
    related_emergency_request_id INTEGER,
    related_delivery_order_id INTEGER,
    related_purchase_order_id INTEGER,
    related_partner_id INTEGER,
    is_read INTEGER DEFAULT 0,
    is_sent INTEGER DEFAULT 0,
    is_delivered INTEGER DEFAULT 0,
    push_enabled INTEGER DEFAULT 1,
    sms_enabled INTEGER DEFAULT 0,
    email_enabled INTEGER DEFAULT 0,
    in_app_enabled INTEGER DEFAULT 1,
    priority VARCHAR(20) DEFAULT 'normal',
    is_urgent INTEGER DEFAULT 0,
    scheduled_at TEXT,
    sent_at TEXT,
    delivered_at TEXT,
    read_at TEXT,
    action_data TEXT,
    metadata TEXT,
    image_url VARCHAR(255),
    sound VARCHAR(80),
    retry_count INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS real_time_tracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emergency_request_id INTEGER,
    delivery_order_id INTEGER,
    partner_id INTEGER,
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    status VARCHAR(30),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS service_modules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module_key VARCHAR(50) NOT NULL UNIQUE,
    service_key VARCHAR(50) NOT NULL,
    partner_type VARCHAR(50) NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    disabled_reason TEXT,
    updated_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS tow_vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER NOT NULL,
    plate VARCHAR(20) NOT NULL,
    make VARCHAR(100) NOT NULL,
    model VARCHAR(100) NOT NULL,
    year INTEGER NOT NULL,
    equipment_type VARCHAR(30) NOT NULL,
    supported_vehicle_classes TEXT NOT NULL,
    max_towed_weight_kg INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    minimum_charge_cents INTEGER NOT NULL,
    included_km DECIMAL(10, 3) NOT NULL,
    price_per_additional_km_cents INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (partner_id, plate)
  )`,

  `CREATE TABLE IF NOT EXISTS tow_vehicle_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tow_vehicle_id INTEGER NOT NULL,
    partner_id INTEGER NOT NULL,
    document_type VARCHAR(60) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    file_url VARCHAR(500) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    file_size INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    expires_at TEXT,
    verified_by INTEGER,
    verified_at TEXT,
    uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
];

let schemaReady = null;

function initSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const statement of SCHEMA) {
        await db.raw(statement);
      }
    })();
  }
  return schemaReady;
}

async function reset() {
  await initSchema();
  for (const table of TABLES) {
    await db(table).del();
  }
}

async function ensureSchema() {
  await initSchema();
  return db;
}

let emailCounter = 0;
function nextEmail(prefix = 'user') {
  emailCounter += 1;
  return `${prefix}.${process.pid}.${emailCounter}@teste.local`;
}

const columnCache = new Map();

/**
 * Descarta chaves que não existem na tabela. Fixtures antigas usavam colunas
 * inexistentes (`document`, `email` em partners, `password_hash` em users) e o
 * SQLite falhava com "has no column named ...". Manter a filtragem deixa as
 * fixtures tolerantes sem mascarar erros de schema real (a coluna só é aceita
 * se existir de fato).
 */
async function filterColumns(table, data) {
  if (!columnCache.has(table)) {
    const info = await db(table).columnInfo();
    columnCache.set(table, new Set(Object.keys(info)));
  }
  const allowed = columnCache.get(table);
  const filtered = {};
  for (const [key, value] of Object.entries(data)) {
    if (allowed.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

async function createUser(overrides = {}) {
  await initSchema();
  const payload = await filterColumns('users', {
    name: overrides.name || 'Usuário Teste',
    email: overrides.email || nextEmail('user'),
    password: overrides.password || '$2a$04$testepasswordhash',
    phone: overrides.phone || '11999999999',
    role: overrides.role || 'user',
    is_active: overrides.is_active === undefined ? 1 : (overrides.is_active ? 1 : 0),
    email_verified: overrides.email_verified === undefined ? 1 : (overrides.email_verified ? 1 : 0),
    ...overrides,
  });
  const [row] = await db('users').insert(payload).returning('*');
  return row;
}

async function createPartner(overrides = {}) {
  await initSchema();
  const userId = overrides.user_id !== undefined ? overrides.user_id : (await createUser({ role: 'partner' })).id;
  const payload = await filterColumns('partners', {
    user_id: userId,
    type: overrides.type || 'gas_station',
    business_name: overrides.business_name || 'Parceiro Teste',
    address: overrides.address || 'Rua de Teste, 100 - São Paulo - SP',
    latitude: overrides.latitude === undefined ? -23.561684 : overrides.latitude,
    longitude: overrides.longitude === undefined ? -46.655981 : overrides.longitude,
    phone: overrides.phone || '1133334444',
    is_verified: overrides.is_verified === undefined ? 1 : (overrides.is_verified ? 1 : 0),
    is_available: overrides.is_available === undefined ? 1 : (overrides.is_available ? 1 : 0),
    is_online: overrides.is_online === undefined ? 0 : (overrides.is_online ? 1 : 0),
    approval_status: overrides.approval_status || 'approved',
    ...overrides,
  });
  const [row] = await db('partners').insert(payload).returning('*');
  return row;
}

async function createActiveSubscription(partnerId, overrides = {}) {
  await initSchema();
  const payload = await filterColumns('subscriptions', {
    partner_id: partnerId,
    type: overrides.type || 'posto_combustivel',
    monthly_fee: overrides.monthly_fee === undefined ? 199.9 : overrides.monthly_fee,
    start_date: overrides.start_date || '2026-01-01',
    due_date: overrides.due_date || '2026-12-01',
    next_billing_date: overrides.next_billing_date || '2026-12-01',
    status: overrides.status || 'active',
    ...overrides,
  });
  const [row] = await db('subscriptions').insert(payload).returning('*');
  return row;
}

async function createEmergencyRequest(overrides = {}) {
  await initSchema();
  const payload = await filterColumns('emergency_requests', {
    user_id: overrides.user_id === undefined ? (await createUser()).id : overrides.user_id,
    type: overrides.type || 'tow',
    request_type: overrides.request_type || 'tow',
    description: overrides.description || 'Carro não liga na Av. Paulista',
    latitude: overrides.latitude === undefined ? -23.561684 : overrides.latitude,
    longitude: overrides.longitude === undefined ? -46.655981 : overrides.longitude,
    address: overrides.address || 'Av. Paulista, 1578 - São Paulo - SP',
    status: overrides.status || 'pending',
    urgency: overrides.urgency || 'medium',
    ...overrides,
  });
  const [row] = await db('emergency_requests').insert(payload).returning('*');
  return row;
}

async function createTowProposal(overrides = {}) {
  await initSchema();
  const emergencyRequestId = overrides.emergency_request_id
    || (await createEmergencyRequest()).id;
  const partnerId = overrides.partner_id
    || (await createPartner({ type: 'tow' })).id;
  const payload = await filterColumns('tow_proposals', {
    emergency_request_id: emergencyRequestId,
    partner_id: partnerId,
    proposed_price: overrides.proposed_price === undefined ? 250 : overrides.proposed_price,
    estimated_time_minutes: overrides.estimated_time_minutes === undefined ? 40 : overrides.estimated_time_minutes,
    message: overrides.message || 'Chego em 40 minutos',
    status: overrides.status || 'pending',
    expires_at: overrides.expires_at || sqliteTimestamp(Date.now() + 15 * 60 * 1000),
    ...overrides,
  });
  const [row] = await db('tow_proposals').insert(payload).returning('*');
  return row;
}

async function createProduct(overrides = {}) {
  await initSchema();
  const storeId = overrides.store_id !== undefined ? overrides.store_id : (await createPartner({ type: 'auto_parts' })).id;
  const payload = await filterColumns('products', {
    store_id: storeId,
    name: overrides.name || 'Produto Teste',
    price: overrides.price === undefined ? 49.9 : overrides.price,
    stock: overrides.stock === undefined ? 10 : overrides.stock,
    track_stock: overrides.track_stock === undefined ? 1 : (overrides.track_stock ? 1 : 0),
    is_active: overrides.is_active === undefined ? 1 : (overrides.is_active ? 1 : 0),
    ...overrides,
  });
  const [row] = await db('products').insert(payload).returning('*');
  return row;
}

async function setSetting(key, value, overrides = {}) {
  await initSchema();
  const existing = await db('system_settings').where({ setting_key: key }).first();
  if (existing) {
    await db('system_settings').where({ setting_key: key }).update({ setting_value: String(value), updated_at: new Date().toISOString() });
    return db('system_settings').where({ setting_key: key }).first();
  }
  const payload = await filterColumns('system_settings', {
    setting_key: key,
    setting_value: String(value),
    data_type: overrides.data_type || 'number',
    category: overrides.category || 'test',
    is_public: overrides.is_public === undefined ? 1 : (overrides.is_public ? 1 : 0),
    ...overrides,
  });
  const [row] = await db('system_settings').insert(payload).returning('*');
  return row;
}

// Cada arquivo de teste recebe sua própria instância em memória; destruí-la ao
// final mantém a suíte sem handles abertos (Jest sai sem `--forceExit`).
if (typeof afterAll === 'function') {
  afterAll(async () => {
    try {
      await db.destroy();
    } catch (error) {
      /* pool já destruído */
    }
  });
}

module.exports = {
  db,
  TABLES,
  initSchema,
  ensureSchema,
  reset,
  sqliteTimestamp,
  sqliteEpochMs,
  createUser,
  createPartner,
  createActiveSubscription,
  createEmergencyRequest,
  createTowProposal,
  createProduct,
  setSetting,
};
