#!/usr/bin/env node
/**
 * T01 — baseline lifecycle: migrate, seed, assert, report.
 *
 * `migrate` runs `database/migrations` (the clean baseline) against a database
 * that must be empty or already managed by this baseline. An UNMANAGED database
 * (tables but no `knex_migrations`) is refused by the single shared rule
 * `baselineEligibility()` — every public migrate path reaches it through
 * `migrateBaseline()` — and is directed to the guarded destructive reset.
 *
 * `seed` creates exactly one row: the default administrator from the
 * environment (`ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME`). No demo user,
 * no partner, no request, no order, no payment.
 *
 * `assert` is the machine-checkable definition of "clean baseline". It fails
 * when a table is missing, when there is more than one user, when the seeded
 * user is not an administrator, when a functional table is not empty, or when
 * the structural settings rows are missing. It is used by the clean-database
 * gate, by the Jest suites and by operators (`npm run db:assert`).
 *
 * Usage:
 *   node scripts/tow/db-baseline.js [--purpose test|dev] [--migrate] [--seed] [--assert]
 *                                   [--report <file.json>] [--json]
 *   (no action flag = --migrate --seed --assert)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { BACKEND_DIR, createConnection, resolvePurpose, loadPurposeEnv } = require('./db-connection');
const { resolveAdminCredentials, seedAdmin, describeSeedResult } = require('./admin-seed');
const { SETTINGS } = require('../../database/migrations/002_baseline_settings');

const MIGRATIONS_DIR = path.resolve(BACKEND_DIR, 'database', 'migrations');
const SEEDS_DIR = path.resolve(BACKEND_DIR, 'database', 'seeds');

/** Tables the baseline MUST create (the schema the application boots on). */
const REQUIRED_TABLES = [
  'appointments',
  'categories',
  'chat_messages',
  'commissions',
  'delivery_orders',
  'disputes',
  'emergency_requests',
  'mechanics',
  'notifications',
  'partner_documents',
  'partner_services',
  'partners',
  'payments',
  'products',
  'purchase_orders',
  'real_time_tracking',
  'reviews',
  'revoked_tokens',
  'service_modules',
  'services',
  'subscription_history',
  'subscriptions',
  'system_settings',
  'tow_proposals',
  'tow_vehicle_documents',
  'tow_vehicles',
  'user_documents',
  'users',
  'wallet_transactions',
  'wallets',
];

/** Bookkeeping tables owned by Knex, not by the application. */
const INFRASTRUCTURE_TABLES = ['knex_migrations', 'knex_migrations_lock'];

/**
 * Tables allowed to hold rows on a freshly seeded baseline:
 *   - `users`           -> exactly the default administrator;
 *   - `system_settings` -> structural default configuration inserted by
 *                          migration 002 (not functional data);
 *   - `service_modules` -> the structural Tow module registry row seeded by
 *                          migration 003 (`tow`/`tow`/`tow`, enabled). It is
 *                          configuration, not functional business data: it
 *                          creates no user/partner/request/order/payment.
 */
const ALLOWED_NON_EMPTY_TABLES = ['users', 'system_settings', 'service_modules'];

const EXPECTED_ADMIN_COUNT = 1;
const EXPECTED_SETTINGS_COUNT = SETTINGS.length;

async function listTables(db) {
  const result = await db.raw(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
  );
  return result.rows.map((row) => row.tablename);
}

/** Row count of every table in `public` (single query per table, read-only). */
async function countAllTables(db) {
  const tables = await listTables(db);
  const counts = {};
  for (const table of tables) {
    // eslint-disable-next-line no-await-in-loop
    const result = await db.raw(`SELECT COUNT(*)::int AS count FROM "${table.replace(/"/g, '""')}"`);
    counts[table] = result.rows[0].count;
  }
  return { tables, counts };
}

async function collectReport(db) {
  const { tables, counts } = await countAllTables(db);
  const adminRow = counts.users > 0
    ? await db('users').select('id', 'email', 'role', 'is_active').orderBy('id').first()
    : null;
  const settingsKeys = counts.system_settings > 0
    ? await db('system_settings').orderBy('setting_key').pluck('setting_key')
    : [];
  return {
    tables,
    counts,
    admin: adminRow
      ? { id: adminRow.id, email: adminRow.email, role: adminRow.role, isActive: adminRow.is_active === true }
      : null,
    settings: { count: counts.system_settings || 0, keys: settingsKeys },
    totalRows: Object.values(counts).reduce((sum, value) => sum + value, 0),
  };
}

/**
 * Every reason a database is NOT a clean baseline, as a list of strings.
 * Pure function over a report: the same rules are asserted by the gate, the
 * Jest suites and `--assert`.
 */
function baselineViolations(report, expectations = {}) {
  const expectedAdminCount = expectations.expectedAdminCount ?? EXPECTED_ADMIN_COUNT;
  const expectedSettingsCount = expectations.expectedSettingsCount ?? EXPECTED_SETTINGS_COUNT;
  const expectedAdminEmail = expectations.expectedAdminEmail
    ? String(expectations.expectedAdminEmail).trim().toLowerCase()
    : null;
  const violations = [];

  for (const table of REQUIRED_TABLES) {
    if (!report.tables.includes(table)) violations.push(`required table "${table}" is missing`);
  }

  const userCount = report.counts.users ?? 0;
  if (userCount !== expectedAdminCount) {
    violations.push(`"users" must contain exactly ${expectedAdminCount} row(s) (the default administrator), found ${userCount}`);
  }
  if (report.admin) {
    if (report.admin.role !== 'admin') {
      violations.push(`the seeded user "${report.admin.email}" has role "${report.admin.role}" instead of "admin"`);
    }
    if (report.admin.isActive !== true) {
      violations.push(`the seeded administrator "${report.admin.email}" is not active`);
    }
    if (expectedAdminEmail && String(report.admin.email).toLowerCase() !== expectedAdminEmail) {
      violations.push(`the seeded administrator is "${report.admin.email}" but ADMIN_EMAIL is "${expectedAdminEmail}"`);
    }
  } else if (expectedAdminCount > 0) {
    violations.push('no administrator was seeded');
  }

  const settingsCount = report.settings.count;
  if (settingsCount !== expectedSettingsCount) {
    violations.push(`"system_settings" must contain the ${expectedSettingsCount} structural defaults, found ${settingsCount}`);
  } else {
    const present = new Set(report.settings.keys);
    const missing = SETTINGS.map((row) => row.setting_key).filter((key) => !present.has(key));
    if (missing.length > 0) violations.push(`"system_settings" is missing keys: ${missing.join(', ')}`);
  }

  // The module registry is structural: exactly the canonical Tow row. This
  // keeps the "no functional data" guarantee sharp while allowing the module
  // configuration row (migration 003) to exist.
  if (report.counts.service_modules !== undefined && report.counts.service_modules !== 1) {
    violations.push(
      `"service_modules" must contain exactly 1 row (the canonical Tow module), found ${report.counts.service_modules}`
    );
  }

  for (const table of report.tables) {
    if (ALLOWED_NON_EMPTY_TABLES.includes(table)) continue;
    if (INFRASTRUCTURE_TABLES.includes(table)) continue;
    const count = report.counts[table] ?? 0;
    if (count !== 0) {
      violations.push(`table "${table}" is not empty (${count} row(s)): the baseline seeds no functional data`);
    }
  }

  return violations;
}

class BaselineAssertionError extends Error {
  constructor(violations) {
    super(`database is not a clean baseline:\n  - ${violations.join('\n  - ')}`);
    this.name = 'BaselineAssertionError';
    this.code = 'BASELINE_ASSERTION_FAILED';
    this.violations = violations;
  }
}

/**
 * An unmanaged database (tables but no `knex_migrations`) is the signature of a
 * pre-T01 database built by the archived chain. T01 policy is
 * `pre-T01 DB -> authorized reset -> clean baseline`, never an incremental
 * upgrade, so every public migrate path must refuse it and point the operator at
 * the guarded reset.
 */
class UnmanagedDatabaseError extends Error {
  constructor(tables) {
    super(
      `database contains ${tables.length} table(s) but no "knex_migrations": it was not created by this ` +
      'baseline. The documented T01 upgrade path is an authorized destructive reset, not an incremental ' +
      'migration: DB_RESET_CONFIRM=I_UNDERSTAND_DESTRUCTIVE_RESET npm run db:reset -- --purpose <dev|test>'
    );
    this.name = 'UnmanagedDatabaseError';
    this.code = 'UNMANAGED_DATABASE';
    this.tables = tables;
  }
}

/**
 * THE baseline-eligibility rule, shared by every public migrate path
 * (`db:migrate`, `db-baseline --migrate`, the clean-database gate and the e2e
 * suites all reach it through `migrateBaseline`), so no command can diverge.
 *
 * @param {string[]} tables tables currently present in `public`
 * @returns {{ eligible: boolean, managed: boolean, reason: 'empty'|'managed'|'unmanaged' }}
 */
function baselineEligibility(tables) {
  const list = Array.isArray(tables) ? tables.filter((table) => typeof table === 'string') : [];
  if (list.length === 0) return { eligible: true, managed: false, reason: 'empty' };
  if (!list.includes('knex_migrations')) return { eligible: false, managed: false, reason: 'unmanaged' };
  return { eligible: true, managed: true, reason: 'managed' };
}

/** Refuse an unmanaged database BEFORE Knex is allowed to run a migration. */
async function assertBaselineEligible(db) {
  const tables = await listTables(db);
  const eligibility = baselineEligibility(tables);
  if (!eligibility.eligible) throw new UnmanagedDatabaseError(tables);
  return { ...eligibility, tables };
}

/** Migrate from an empty database; returns `{ batch, applied }`. */
async function migrateBaseline(db) {
  await assertBaselineEligible(db);
  const [batch, applied] = await db.migrate.latest({ directory: MIGRATIONS_DIR });
  return { batch, applied };
}

/** Run the administrator seed (idempotent). */
async function runSeed(db, env = process.env) {
  return seedAdmin(db, resolveAdminCredentials(env));
}

/** Collect the report and throw `BaselineAssertionError` when it is not clean. */
async function assertBaseline(db, expectations = {}) {
  const report = await collectReport(db);
  const violations = baselineViolations(report, expectations);
  if (violations.length > 0) throw new BaselineAssertionError(violations);
  return report;
}

function parseArgs(argv) {
  const options = {
    purpose: resolvePurpose(argv),
    migrate: false,
    seed: false,
    assert: false,
    json: argv.includes('--json'),
    report: null,
  };
  const reportIndex = argv.indexOf('--report');
  if (reportIndex !== -1) options.report = argv[reportIndex + 1];
  options.migrate = argv.includes('--migrate');
  options.seed = argv.includes('--seed');
  options.assert = argv.includes('--assert');
  if (!options.migrate && !options.seed && !options.assert) {
    options.migrate = true;
    options.seed = true;
    options.assert = true;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  loadPurposeEnv(options.purpose);
  const db = createConnection({ purpose: options.purpose });
  const summary = { purpose: options.purpose, migrated: null, seed: null, report: null };

  try {
    if (options.migrate) {
      const { batch, applied } = await migrateBaseline(db);
      summary.migrated = { batch, applied };
      console.log(`[db] migrations applied: ${applied.length} (batch ${batch})`);
      for (const name of applied) console.log(`[db]   + ${name}`);
    }
    if (options.seed) {
      const result = await runSeed(db, process.env);
      summary.seed = result;
      console.log(`[db] ${describeSeedResult(result)}`);
    }
    if (options.assert) {
      const report = await assertBaseline(db, {
        expectedAdminEmail: process.env.ADMIN_EMAIL,
      });
      summary.report = report;
      console.log(
        `[db] baseline OK: ${report.tables.length} tables, ${report.totalRows} row(s) total, ` +
        `admin=${report.admin ? report.admin.email : 'none'}, settings=${report.settings.count}`
      );
    }
    if (options.report) {
      const report = summary.report || await collectReport(db);
      summary.report = report;
      fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`[db] report written to ${options.report}`);
    }
    if (options.json) console.log(JSON.stringify(summary, null, 2));
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[db] ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  MIGRATIONS_DIR,
  SEEDS_DIR,
  REQUIRED_TABLES,
  INFRASTRUCTURE_TABLES,
  ALLOWED_NON_EMPTY_TABLES,
  EXPECTED_ADMIN_COUNT,
  EXPECTED_SETTINGS_COUNT,
  BaselineAssertionError,
  UnmanagedDatabaseError,
  listTables,
  countAllTables,
  collectReport,
  baselineViolations,
  baselineEligibility,
  assertBaselineEligible,
  migrateBaseline,
  runSeed,
  assertBaseline,
};
