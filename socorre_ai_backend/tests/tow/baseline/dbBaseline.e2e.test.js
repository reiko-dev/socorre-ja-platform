/**
 * T01 — MIGRATION / DATABASE / SEED / SAFETY suites against REAL PostgreSQL.
 *
 * Runs only with the explicit harness opt-in (`TOW_POSTGRES_E2E=1`, the T00
 * disposable Docker container); `npm run test:db-baseline` orchestrates the full
 * container lifecycle. Every destructive call goes through the T00 guard, so
 * this file can never touch anything but the disposable loopback test database.
 *
 * The offline counterparts of these rules are
 * `tests/tow/baseline/dbBaselineSafety.test.js`,
 * `tests/tow/baseline/adminSeed.test.js` and
 * `tests/tow/baseline/schemaSnapshot.test.js`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const postgres = require('../../helpers/tow/postgres');
const {
  MIGRATIONS_DIR,
  REQUIRED_TABLES,
  EXPECTED_SETTINGS_COUNT,
  migrateBaseline,
  runSeed,
  assertBaseline,
  collectReport,
  baselineViolations,
  BaselineAssertionError,
  UnmanagedDatabaseError,
} = require('../../../scripts/tow/db-baseline');
const { resetDatabase, ResetApiMisuseError } = require('../../../scripts/tow/db-reset');
const { checkResetAuthorization, RESET_CONFIRM_TOKEN, CONFIRM_VAR } = require('../../../scripts/tow/db-reset-guard');
const { createConnection, checkPurpose } = require('../../../scripts/tow/db-connection');
const { AdminSeedConfigError } = require('../../../scripts/tow/admin-seed');
const { disposableAdminCredentials } = require('../../../scripts/tow/disposable-credentials');
const { snapshotSchema, compareSnapshots, fingerprintOf } = require('../../../scripts/tow/schema-snapshot');

const describePostgres = postgres.isEnabled() ? describe : describe.skip;
// PINNED explicitly: the exact MVP-01 baseline. The directory read below is a
// cross-check only, so a smuggled `004_*.js` cannot be absorbed silently.
const BASELINE_MIGRATIONS = Object.freeze([
  '001_baseline_schema.js',
  '002_baseline_settings.js',
  '003_mvp01_tow_foundation.js',
]);

/** Disposable credentials: generated per run, never committed. */
function disposableAdmin() {
  return disposableAdminCredentials('baseline-e2e');
}

/**
 * The destructive reset of this suite. ONLY the guarded public API is used:
 * `resetDatabase()` resolves + authorizes the disposable harness target and
 * builds its own connection from that authorized target. The suite IS the
 * explicitly authorized container, so it passes the same consent token an
 * operator would have to type.
 */
function guardedReset() {
  return resetDatabase({ purpose: 'test', confirm: RESET_CONFIRM_TOKEN });
}

async function count(db, table) {
  const result = await db.raw(`SELECT COUNT(*)::int AS count FROM "${table}"`);
  return result.rows[0].count;
}

describePostgres('T01 PostgreSQL — clean baseline', () => {
  let db;
  let admin;
  let firstApplied = [];
  let firstSnapshot = null;

  beforeAll(async () => {
    db = postgres.createConnection();
    admin = disposableAdmin();
    // Destructive bootstrap goes through the SAME guarded public reset the
    // operator command uses (never a raw drop primitive).
    await guardedReset();
    const result = await migrateBaseline(db);
    firstApplied = result.applied;
    firstSnapshot = await snapshotSchema(db);
  }, 60_000);

  afterAll(async () => {
    if (db) await db.destroy();
  });

  describe('MIGRATION — boots from a truly empty database', () => {
    test('applies exactly the baseline migrations from zero', () => {
      expect(firstApplied.slice().sort()).toEqual(BASELINE_MIGRATIONS.slice().sort());
    });

    test('the migrations directory matches the pinned baseline exactly (no smuggled migration)', () => {
      const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.js')).sort();
      const unexpected = files.filter((file) => !BASELINE_MIGRATIONS.includes(file));
      if (unexpected.length > 0) {
        throw new Error(
          `unexpected migration file(s) outside the pinned MVP-01 baseline: ${unexpected.join(', ')}`
        );
      }
      expect(files).toEqual(BASELINE_MIGRATIONS.slice().sort());
      expect(files.some((file) => /015|migrate_existing_data/.test(file))).toBe(false);
    });

    test('creates every table the application needs', async () => {
      const tables = await postgres.listTables(db);
      for (const table of REQUIRED_TABLES) {
        expect({ table, present: tables.includes(table) }).toEqual({ table, present: true });
      }
      expect(tables).toEqual(expect.arrayContaining(['knex_migrations', 'knex_migrations_lock']));
    });

    test('running migrate again applies nothing (idempotent)', async () => {
      const { applied } = await migrateBaseline(db);
      expect(applied).toEqual([]);
    });

    test('a reset + migrate reproduces the same schema fingerprint', async () => {
      const { dropped } = await guardedReset();
      expect(dropped.length).toBeGreaterThan(0);
      expect(await postgres.listTables(db)).toEqual([]);

      const { applied } = await migrateBaseline(db);
      expect(applied.slice().sort()).toEqual(BASELINE_MIGRATIONS.slice().sort());

      const secondSnapshot = await snapshotSchema(db);
      const comparison = compareSnapshots(firstSnapshot, secondSnapshot);
      if (!comparison.equal) {
        throw new Error(`schema changed between fresh runs: ${JSON.stringify(comparison.changes, null, 2)}`);
      }
      expect(fingerprintOf(secondSnapshot)).toBe(fingerprintOf(firstSnapshot));
    }, 60_000);

    test('does not depend on legacy data: no INSERT of functional rows in the schema migration', () => {
      const source = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_baseline_schema.js'), 'utf8');
      expect(source).not.toMatch(/\.insert\(/);
      expect(source).not.toMatch(/\.del\(\)/);
      expect(source).not.toMatch(/\.update\(/);
    });

    test('an unmanaged database is refused by migrate (pre-T01 upgrade path is the guarded reset)', async () => {
      // Reproduce the legacy signature inside the disposable container: tables
      // but no `knex_migrations`.
      await guardedReset();
      await db.raw('CREATE TABLE legacy_unmanaged_fixture (id serial PRIMARY KEY)');
      await expect(migrateBaseline(db)).rejects.toThrow(UnmanagedDatabaseError);
      await expect(migrateBaseline(db)).rejects.toThrow(/not created by this baseline/);
      // Nothing was migrated: the only table is still the fixture.
      expect(await postgres.listTables(db)).toEqual(['legacy_unmanaged_fixture']);
      // The documented recovery path (guarded reset) restores a clean state.
      await guardedReset();
      const { applied } = await migrateBaseline(db);
      expect(applied.slice().sort()).toEqual(BASELINE_MIGRATIONS.slice().sort());
      expect(await postgres.listTables(db)).not.toContain('legacy_unmanaged_fixture');
    }, 60_000);
  });

  describe('DATABASE — the constraints and indexes are really applied', () => {
    let userId;
    let walletId;
    let requestId;
    let partnerId;

    beforeAll(async () => {
      const seed = await runSeed(db, admin);
      userId = seed.userId;
      [{ id: walletId }] = await db('wallets').insert({ user_id: userId }).returning('id');
      [{ id: requestId }] = await db('emergency_requests').insert({
        user_id: userId,
        type: 'mechanical',
        description: 'baseline constraint fixture',
        location_type: 'roadside',
        latitude: -23.5,
        longitude: -46.6,
        address: 'fixture street',
      }).returning('id');
      [{ id: partnerId }] = await db('partners').insert({
        user_id: userId,
        type: 'tow',
        business_name: 'fixture tow',
        address: 'fixture street',
        phone: '0000000000',
      }).returning('id');
    }, 60_000);

    test('foreign keys reject invalid references', async () => {
      await expect(
        db('wallet_transactions').insert({
          wallet_id: walletId,
          type: 'adjustment',
          direction: 'credit',
          amount: 1,
          balance_before: 0,
          balance_after: 1,
          dispute_id: 987654321,
        })
      ).rejects.toThrow(/wallet_transactions_dispute_id_foreign/);

      await expect(
        db('payments').insert({
          user_id: 987654321,
          amount: 10,
          method: 'pix',
          gateway: 'fixture',
        })
      ).rejects.toThrow(/payments_user_id_foreign/);
    });

    test('the dispute reference added by T01 is a real foreign key', async () => {
      const result = await db.raw(
        "SELECT COUNT(*)::int AS count FROM pg_constraint WHERE conname = 'wallet_transactions_dispute_id_foreign'"
      );
      expect(result.rows[0].count).toBe(1);
      // A NULL dispute is still allowed (the column is optional).
      const [{ id }] = await db('wallet_transactions').insert({
        wallet_id: walletId,
        type: 'adjustment',
        direction: 'credit',
        amount: 1,
        balance_before: 0,
        balance_after: 1,
        dispute_id: null,
      }).returning('id');
      expect(id).toBeGreaterThan(0);
    });

    test('unique constraints are really applied', async () => {
      await expect(
        db('users').insert({ name: 'dup', email: admin.ADMIN_EMAIL.toUpperCase(), password: 'x', role: 'admin' })
      ).rejects.toThrow(/users_email_lower_unique|users_email_unique/);

      await expect(
        db('user_documents').insert([
          { user_id: userId, document_type: 'cnh', filename: 'a', original_name: 'a', file_path: '/a', mime_type: 'image/png', file_size: 1 },
          { user_id: userId, document_type: 'cnh', filename: 'b', original_name: 'b', file_path: '/b', mime_type: 'image/png', file_size: 1 },
        ])
      ).rejects.toThrow(/user_documents_user_id_document_type_unique/);

      await expect(
        db('wallets').insert({ user_id: userId })
      ).rejects.toThrow(/wallets_user_id_unique/);
    });

    test('the case-insensitive e-mail index really blocks a duplicate', async () => {
      const result = await db.raw(
        "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='users_email_lower_unique'"
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].indexdef).toMatch(/lower\(\(email\)::text\)|lower\(email\)/);
    });

    test('the partial unique of tow_proposals allows one pending proposal per partner', async () => {
      const base = {
        emergency_request_id: requestId,
        partner_id: partnerId,
        proposed_price: 100,
        estimated_time_minutes: 30,
        expires_at: new Date(Date.now() + 60_000),
      };
      await db('tow_proposals').insert({ ...base, status: 'pending' });
      await expect(
        db('tow_proposals').insert({ ...base, status: 'pending' })
      ).rejects.toThrow(/tow_proposals_one_pending_per_partner/);
      // A non-pending proposal for the same pair is allowed.
      const [{ id }] = await db('tow_proposals').insert({ ...base, status: 'rejected' }).returning('id');
      expect(id).toBeGreaterThan(0);
    });

    test('check constraints and NOT NULL are really applied', async () => {
      await expect(
        db('emergency_requests').insert({
          user_id: userId,
          type: 'not-a-real-type',
          description: 'x',
          location_type: 'roadside',
          latitude: 0,
          longitude: 0,
          address: 'x',
        })
      ).rejects.toThrow(/emergency_requests_type_check/);

      await expect(
        db('users').insert({ name: null, email: 'null-name@example.test', password: 'x', role: 'admin' })
      ).rejects.toThrow(/null value in column "name"/);

      await expect(
        db('payments').insert({ user_id: userId, amount: 1, method: 'bitcoin', gateway: 'fixture' })
      ).rejects.toThrow(/payments_method_check/);
    });

    test('the expected indexes exist', async () => {
      const expected = [
        'users_email_lower_unique',
        'users_fcm_token_index',
        'products_search_index',
        'reviews_user_entity_unique',
        'tow_proposals_one_pending_per_partner',
        'wallet_transactions_dispute_id_index',
        'system_settings_setting_key_unique',
        'wallets_user_id_unique',
      ];
      const result = await db.raw(
        "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY(?)",
        [expected]
      );
      const found = result.rows.map((row) => row.indexname);
      expect(found.sort()).toEqual(expected.slice().sort());
    });

    test('the redundant indexes removed by T01 are gone', async () => {
      const removed = [
        'products_sku_index',
        'system_settings_setting_key_index',
        'wallets_user_id_index',
        'wallets_partner_id_index',
        'user_documents_user_id_document_type_index',
      ];
      const result = await db.raw(
        "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY(?)",
        [removed]
      );
      expect(result.rows).toEqual([]);
      // The unique constraints that replace them are still there.
      const uniques = await db.raw(
        "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY(?)",
        [['products_sku_unique', 'wallets_user_id_unique', 'wallets_partner_id_unique', 'user_documents_user_id_document_type_unique']]
      );
      expect(uniques.rows).toHaveLength(4);
    });
  });

  describe('SEED — exactly one administrator, no functional data', () => {
    test('a fresh migrate + seed produces the clean baseline', async () => {
      await guardedReset();
      await migrateBaseline(db);
      const seed = await runSeed(db, admin);
      expect(seed.created).toBe(true);

      const report = await assertBaseline(db, { expectedAdminEmail: admin.ADMIN_EMAIL });
      expect(report.counts.users).toBe(1);
      expect(report.admin.role).toBe('admin');
      expect(report.admin.email).toBe(admin.ADMIN_EMAIL);
      expect(report.settings.count).toBe(EXPECTED_SETTINGS_COUNT);
      expect(baselineViolations(report, { expectedAdminEmail: admin.ADMIN_EMAIL })).toEqual([]);
    }, 60_000);

    test('the seeded administrator can log in with the configured password (bcrypt cost 12)', async () => {
      const bcrypt = require('bcryptjs');
      const row = await db('users').whereRaw('LOWER(email) = ?', [admin.ADMIN_EMAIL]).first();
      expect(row.password).toMatch(/^\$2[aby]\$12\$/);
      await expect(bcrypt.compare(admin.ADMIN_PASSWORD, row.password)).resolves.toBe(true);
      await expect(bcrypt.compare('wrong-password-123456', row.password)).resolves.toBe(false);
    });

    test('re-running the seed creates no duplicate and changes nothing', async () => {
      const before = await db('users').select('id', 'email', 'password').orderBy('id');
      const second = await runSeed(db, { ...admin, ADMIN_PASSWORD: 'another-disposable-password-1' });
      expect(second.created).toBe(false);
      const after = await db('users').select('id', 'email', 'password').orderBy('id');
      expect(after).toEqual(before);
      expect(await count(db, 'users')).toBe(1);
    });

    test('no functional table has rows', async () => {
      const report = await collectReport(db);
      for (const table of REQUIRED_TABLES) {
        // `users` (admin), `system_settings` (structural defaults) and
        // `service_modules` (structural module registry: exactly one row) are
        // configuration, not functional data.
        if (table === 'users' || table === 'system_settings' || table === 'service_modules') continue;
        expect({ table, count: report.counts[table] }).toEqual({ table, count: 0 });
      }
    });

    test('the seed refuses to run without credentials, before touching the database', async () => {
      await expect(runSeed(db, {})).rejects.toThrow(AdminSeedConfigError);
      expect(await count(db, 'users')).toBe(1);
    });

    test('the assertion catches a dirty baseline (negative control)', async () => {
      const [{ id: categoryId }] = await db('categories').insert({ name: 'should-not-be-here' }).returning('id');
      expect(categoryId).toBeGreaterThan(0);
      await expect(assertBaseline(db)).rejects.toThrow(BaselineAssertionError);
      await db('categories').del();
      await expect(assertBaseline(db)).resolves.toBeTruthy();
    });

    test('the assertion rejects any second user, even a non-admin one', async () => {
      const [{ id: intruderId }] = await db('users').insert({
        name: 'intruder',
        email: 'intruder@example.test',
        password: 'not-a-real-hash',
        role: 'user',
      }).returning('id');
      await expect(assertBaseline(db, { expectedAdminEmail: admin.ADMIN_EMAIL }))
        .rejects.toThrow(/"users" must contain exactly 1 row/);
      await db('users').where({ id: intruderId }).del();
      await expect(assertBaseline(db, { expectedAdminEmail: admin.ADMIN_EMAIL })).resolves.toBeTruthy();
    });
  });

  describe('SAFETY — the commands refuse anything but the disposable target', () => {
    test('the harness target passes every rule', () => {
      const result = checkResetAuthorization(process.env, { purpose: 'test', requireConfirmation: false });
      expect(result.violations).toEqual([]);
      expect(result.safe).toBe(true);
      // The non-destructive commands use exactly this decision.
      expect(checkPurpose('test').safe).toBe(true);
    });

    test('the destructive reset is refused without the consent token', () => {
      const env = { ...process.env };
      delete env[CONFIRM_VAR];
      const result = checkResetAuthorization(env, { purpose: 'test' });
      expect(result.safe).toBe(false);
      expect(result.violations.join('\n')).toMatch(/DB_RESET_CONFIRM/);
    });

    test('the consent token authorizes only the disposable target', () => {
      const result = checkResetAuthorization(
        { ...process.env, [CONFIRM_VAR]: RESET_CONFIRM_TOKEN },
        { purpose: 'test' }
      );
      expect(result.safe).toBe(true);
    });

    test('an incompatible DATABASE_URL is rejected by the runner', () => {
      expect(() => createConnection({
        purpose: 'test',
        env: { ...process.env, DATABASE_URL: 'postgresql://user:pw@production.example.com:5432/socorre' },
      })).toThrow(/DATABASE_URL\/PostgreSQL must not be set/);
    });

    test('a production-sounding database name is rejected', () => {
      expect(() => createConnection({
        purpose: 'test',
        env: { ...process.env, DB_NAME_TEST: 'socorre_ai_production' },
      })).toThrow(/forbidden hint/);
    });

    test('the gate compose file mounts no host volume (data lives in tmpfs)', () => {
      const compose = fs.readFileSync(path.join(postgres.MIGRATIONS_DIR, '..', '..', 'docker-compose.test.yml'), 'utf8');
      expect(compose).toMatch(/tmpfs:/);
      expect(compose).toMatch(/\/var\/lib\/postgresql\/data/);
      // No bind mount of a host directory and no named volume for the data dir.
      expect(compose).not.toMatch(/^\s{6,}-\s+\.\//m);
      expect(compose).not.toMatch(/volumes:\s*\n\s+-/);
    });

    test('RESET-DIRECT-1 (live) the guarded reset without consent leaves the schema intact', async () => {
      const env = { ...process.env };
      delete env[CONFIRM_VAR];
      const before = await postgres.listTables(db);
      expect(before.length).toBeGreaterThan(0);
      await expect(resetDatabase({ purpose: 'test', env })).rejects.toThrow(/DB_RESET_CONFIRM must be exactly/);
      // Nothing was dropped: the exact same tables are still there.
      expect(await postgres.listTables(db)).toEqual(before);
      expect(await postgres.countRows(db, 'users')).toBe(1);
    });

    test('RESET-DIRECT-7 (live) an arbitrary Knex connection cannot be passed to the guarded reset', async () => {
      const before = await postgres.listTables(db);
      await expect(resetDatabase(db)).rejects.toThrow(ResetApiMisuseError);
      await expect(resetDatabase(db)).rejects.toThrow(/does not accept a database connection/);
      expect(await postgres.listTables(db)).toEqual(before);
      expect(await postgres.countRows(db, 'users')).toBe(1);
    });

    test('RESET-DIRECT-7 (live) a production-like target cannot reuse the disposable authorization', async () => {
      const before = await postgres.listTables(db);
      // Same consent token, different target: the guard refuses before any
      // connection is opened.
      await expect(resetDatabase({
        purpose: 'test',
        confirm: RESET_CONFIRM_TOKEN,
        env: { ...process.env, DB_NAME_TEST: 'socorre_ai_production' },
      })).rejects.toThrow(/forbidden hint/);
      await expect(resetDatabase({
        purpose: 'test',
        confirm: RESET_CONFIRM_TOKEN,
        env: { ...process.env, DB_HOST: '10.0.0.7' },
      })).rejects.toThrow(/DB_HOST must be loopback/);
      expect(await postgres.listTables(db)).toEqual(before);
    });

    test('RESET-DIRECT-8 (live) the authorized disposable target resets normally', async () => {
      const { dropped } = await guardedReset();
      expect(dropped).toContain('users');
      expect(await postgres.listTables(db)).toEqual([]);
      // Restore the seeded baseline for the FRESHNESS suite.
      await migrateBaseline(db);
      await runSeed(db, admin);
      expect(await postgres.countRows(db, 'users')).toBe(1);
    }, 60_000);
  });

  describe('FRESHNESS — the whole lifecycle is repeatable', () => {
    test('reset + migrate + seed + assert reproduces the first run', async () => {
      await guardedReset();
      const { applied } = await migrateBaseline(db);
      expect(applied.slice().sort()).toEqual(BASELINE_MIGRATIONS.slice().sort());
      const seed = await runSeed(db, admin);
      expect(seed.created).toBe(true);
      const report = await assertBaseline(db, { expectedAdminEmail: admin.ADMIN_EMAIL });

      const snapshot = await snapshotSchema(db);
      expect(fingerprintOf(snapshot)).toBe(fingerprintOf(firstSnapshot));
      expect(report.counts.users).toBe(1);
      expect(report.settings.count).toBe(EXPECTED_SETTINGS_COUNT);
    }, 60_000);
  });
});
