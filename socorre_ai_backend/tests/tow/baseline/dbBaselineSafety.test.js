/**
 * T01 — SAFETY suite: the destructive reset can only ever reach a disposable
 * dev/test database.
 *
 * These tests are offline (no Docker, no PostgreSQL): they prove the decision
 * logic of `scripts/tow/db-reset-guard.js`, which is what `db:reset`,
 * `db:migrate`, `db:seed` and the clean-database gate all consult before doing
 * anything.
 *
 * The `RESET-DIRECT-1..8` block additionally proves the ARCHITECTURE of the
 * guarded public reset (external review P1, PR #32): the destructive primitive
 * is private, the connection is built FROM the authorized target, an arbitrary
 * `Knex` object can never be passed in, and no DROP happens before
 * authorization. It uses the module-level `createConnectionForTarget` seam as a
 * spy; no real connection is ever opened.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Spy seam: the guarded reset must ask THIS factory for its connection, and it
// must only do so after the target was authorized. Everything else is real.
jest.mock('../../../scripts/tow/db-connection', () => {
  const actual = jest.requireActual('../../../scripts/tow/db-connection');
  return { ...actual, createConnectionForTarget: jest.fn() };
});

const {
  RESET_CONFIRM_TOKEN,
  CONFIRM_VAR,
  ALLOWED_DATABASE_NAMES,
  checkResetAuthorization,
  assertResetAuthorized,
  describeResetTarget,
  isAllowedDatabaseName,
} = require('../../../scripts/tow/db-reset-guard');
const dbConnection = require('../../../scripts/tow/db-connection');
const { checkPurpose, createConnection } = dbConnection;
const dbReset = require('../../../scripts/tow/db-reset');
const { resetDatabase, ResetApiMisuseError } = dbReset;
const {
  UnmanagedDatabaseError,
  baselineEligibility,
  assertBaselineEligible,
  migrateBaseline,
} = require('../../../scripts/tow/db-baseline');
const {
  PINNED_MIGRATIONS,
  directoryMigrations,
  assertPinnedMigrations,
  expectedMigrations,
} = require('../../../scripts/tow/run-db-baseline-gate');

const BACKEND_DIR = path.resolve(__dirname, '..', '..', '..');

/** A fully authorized disposable TEST target. */
function safeTestEnv(overrides = {}) {
  const env = {
    TOW_POSTGRES_E2E: '1',
    NODE_ENV: 'test',
    DB_HOST: '127.0.0.1',
    DB_PORT: '55432',
    DB_NAME_TEST: 'socorre_ai_tow_test',
    DB_USER: 'tow_test',
    DB_PASSWORD: 'tow_test_password',
    [CONFIRM_VAR]: RESET_CONFIRM_TOKEN,
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

/** A fully authorized local DEVELOPMENT target. */
function safeDevEnv(overrides = {}) {
  return safeTestEnv({
    TOW_POSTGRES_E2E: undefined,
    NODE_ENV: 'development',
    DB_NAME_TEST: undefined,
    DB_NAME: 'socorre_ai_dev',
    DB_PORT: '5432',
    DB_USER: 'socorre_dev',
    ...overrides,
  });
}

function expectUnsafe(result, matcher) {
  expect(result.safe).toBe(false);
  expect(result.violations.join('\n')).toMatch(matcher);
}

describe('T01 SAFETY — destructive reset guard', () => {
  describe('authorized targets', () => {
    test('accepts the disposable Docker test target with explicit consent', () => {
      const result = checkResetAuthorization(safeTestEnv(), { purpose: 'test' });
      expect(result.violations).toEqual([]);
      expect(result.safe).toBe(true);
      expect(result.target.database).toBe('socorre_ai_tow_test');
      expect(result.target.confirmed).toBe(true);
    });

    test('accepts the local development database ending in _dev', () => {
      const result = checkResetAuthorization(safeDevEnv(), { purpose: 'dev' });
      expect(result.violations).toEqual([]);
      expect(result.safe).toBe(true);
      expect(result.target.database).toBe('socorre_ai_dev');
    });

    test('accepts every allowlisted database name', () => {
      for (const name of ALLOWED_DATABASE_NAMES) {
        expect(isAllowedDatabaseName(name)).toBe(true);
      }
    });

    test('describeResetTarget never prints the password', () => {
      const target = checkResetAuthorization(
        safeTestEnv({ DB_PASSWORD: 'super-secret-password' }),
        { purpose: 'test' }
      ).target;
      const description = describeResetTarget(target);
      expect(description).not.toContain('super-secret-password');
      expect(description).toContain('socorre_ai_tow_test');
    });
  });

  describe('missing or wrong consent', () => {
    test('refuses when DB_RESET_CONFIRM is absent', () => {
      const result = checkResetAuthorization(safeTestEnv({ [CONFIRM_VAR]: undefined }), { purpose: 'test' });
      expectUnsafe(result, /DB_RESET_CONFIRM must be exactly/);
    });

    test('refuses a generic confirmation value', () => {
      for (const value of ['yes', 'true', '1', 'I_UNDERSTAND', 'confirm', RESET_CONFIRM_TOKEN.toLowerCase()]) {
        const result = checkResetAuthorization(safeTestEnv({ [CONFIRM_VAR]: value }), { purpose: 'test' });
        expectUnsafe(result, /DB_RESET_CONFIRM must be exactly/);
      }
    });

    test('the token is not the legacy E2E row-reset confirmation', () => {
      expect(RESET_CONFIRM_TOKEN).not.toBe('I_UNDERSTAND');
      expect(RESET_CONFIRM_TOKEN).toBe('I_UNDERSTAND_DESTRUCTIVE_RESET');
    });

    test('assertResetAuthorized throws with the documented error code', () => {
      expect(() => assertResetAuthorized(safeTestEnv({ [CONFIRM_VAR]: undefined }), { purpose: 'test' }))
        .toThrow(/Refusing to reset/);
      try {
        assertResetAuthorized(safeTestEnv({ [CONFIRM_VAR]: undefined }), { purpose: 'test' });
        throw new Error('expected the guard to throw');
      } catch (error) {
        expect(error.code).toBe('UNSAFE_RESET_TARGET');
        expect(Array.isArray(error.violations)).toBe(true);
      }
    });

    test('createConnection requires consent for the destructive purpose', () => {
      expect(() => createConnection({
        purpose: 'test',
        destructive: true,
        env: safeTestEnv({ [CONFIRM_VAR]: undefined }),
      })).toThrow(/Refusing to use a database/);
      // ... and refuses an unsafe target even for the non-destructive purpose.
      expect(() => createConnection({
        purpose: 'test',
        env: safeTestEnv({ [CONFIRM_VAR]: undefined, DB_NAME_TEST: 'socorre_ai_production' }),
      })).toThrow(/Refusing to use a database/);
      expect(checkPurpose('test', { env: safeTestEnv({ [CONFIRM_VAR]: undefined }) }).safe).toBe(true);
    });
  });

  describe('production can never be reached', () => {
    test('refuses NODE_ENV=production even with the token', () => {
      const result = checkResetAuthorization(safeTestEnv({ NODE_ENV: 'production' }), { purpose: 'test' });
      expectUnsafe(result, /NODE_ENV=production/);
    });

    test('refuses a production-sounding database name', () => {
      for (const name of ['socorre_ai_prod', 'socorre_ai_production_test', 'socorre_live_test', 'vps_test', 'homolog_test', 'staging_test']) {
        const result = checkResetAuthorization(safeTestEnv({ DB_NAME_TEST: name }), { purpose: 'test' });
        expectUnsafe(result, /forbidden hint/);
      }
    });

    test('refuses a database without the _dev/_test suffix', () => {
      const result = checkResetAuthorization(safeTestEnv({ DB_NAME_TEST: 'socorre_ai' }), { purpose: 'test' });
      expectUnsafe(result, /not an allowed dev\/test database/);
    });

    test('refuses DATABASE_URL, which may point anywhere', () => {
      const result = checkResetAuthorization(
        safeTestEnv({ DATABASE_URL: 'postgresql://user:pw@prod.example.com:5432/socorre' }),
        { purpose: 'test' }
      );
      expectUnsafe(result, /DATABASE_URL\/PostgreSQL must not be set/);
    });

    test('refuses the PostgreSQL service variable as well', () => {
      const result = checkResetAuthorization(
        safeTestEnv({ PostgreSQL: 'postgresql://user:pw@prod.example.com:5432/socorre' }),
        { purpose: 'test' }
      );
      expectUnsafe(result, /DATABASE_URL\/PostgreSQL must not be set/);
    });

    test('refuses remote and wildcard hosts', () => {
      for (const host of ['0.0.0.0', '::', '*', 'db.example.com', '10.0.0.7', 'postgres.internal']) {
        const result = checkResetAuthorization(safeTestEnv({ DB_HOST: host }), { purpose: 'test' });
        expectUnsafe(result, /DB_HOST/);
      }
    });

    test('refuses privileged users', () => {
      for (const user of ['postgres', 'root', 'prod_admin', 'superuser', 'admin']) {
        const result = checkResetAuthorization(safeTestEnv({ DB_USER: user }), { purpose: 'test' });
        expectUnsafe(result, /privileged/);
      }
    });

    test('refuses an implicit target (no explicit host/port/database/user)', () => {
      const result = checkResetAuthorization(
        safeTestEnv({ DB_HOST: undefined, DB_PORT: undefined, DB_NAME_TEST: undefined, DB_USER: undefined }),
        { purpose: 'test' }
      );
      expectUnsafe(result, /must be set explicitly/);
    });

    test('refuses an unknown purpose', () => {
      const result = checkResetAuthorization(safeTestEnv(), { purpose: 'production' });
      expectUnsafe(result, /unknown reset purpose/);
    });

    test('the dev path also refuses production hints and remote hosts', () => {
      expectUnsafe(
        checkResetAuthorization(safeDevEnv({ DB_NAME: 'socorre_ai_prod' }), { purpose: 'dev' }),
        /forbidden hint/
      );
      expectUnsafe(
        checkResetAuthorization(safeDevEnv({ DB_HOST: '10.1.2.3' }), { purpose: 'dev' }),
        /DB_HOST must be loopback/
      );
      expectUnsafe(
        checkResetAuthorization(safeDevEnv({ NODE_ENV: 'production' }), { purpose: 'dev' }),
        /NODE_ENV=production/
      );
      expectUnsafe(
        checkResetAuthorization(safeDevEnv({ DATABASE_URL: 'postgresql://u:p@h/db' }), { purpose: 'dev' }),
        /DATABASE_URL\/PostgreSQL must not be set/
      );
    });
  });

  describe('harness rules still apply to the test purpose', () => {
    test('refuses without the explicit TOW_POSTGRES_E2E opt-in', () => {
      const result = checkResetAuthorization(safeTestEnv({ TOW_POSTGRES_E2E: '0' }), { purpose: 'test' });
      expectUnsafe(result, /TOW_POSTGRES_E2E is not "1"/);
    });

    test('refuses a test database without the _test suffix even when allowlisted elsewhere', () => {
      const result = checkResetAuthorization(safeTestEnv({ DB_NAME_TEST: 'socorre_ai_dev' }), { purpose: 'test' });
      expectUnsafe(result, /DB_NAME_TEST must end with "_test"/);
    });
  });

  describe('non-destructive commands (migrate/seed/assert)', () => {
    test('do not require the destructive consent token', () => {
      const result = checkResetAuthorization(safeTestEnv({ [CONFIRM_VAR]: undefined }), {
        purpose: 'test',
        requireConfirmation: false,
      });
      expect(result.violations).toEqual([]);
      expect(result.safe).toBe(true);
    });

    test('still refuse every unsafe target', () => {
      expectUnsafe(
        checkResetAuthorization(safeTestEnv({ [CONFIRM_VAR]: undefined, DB_NAME_TEST: 'socorre_ai_prod' }), {
          purpose: 'test',
          requireConfirmation: false,
        }),
        /forbidden hint/
      );
      expectUnsafe(
        checkResetAuthorization(safeTestEnv({ [CONFIRM_VAR]: undefined, TOW_POSTGRES_E2E: '0' }), {
          purpose: 'test',
          requireConfirmation: false,
        }),
        /TOW_POSTGRES_E2E is not "1"/
      );
    });

    test('checkPurpose exposes the same decision used by the CLI commands', () => {
      expect(checkPurpose('test', { env: safeTestEnv({ [CONFIRM_VAR]: undefined }) }).safe).toBe(true);
      expect(checkPurpose('test', { env: safeTestEnv({ [CONFIRM_VAR]: undefined, NODE_ENV: 'production' }) }).safe).toBe(false);
      expect(checkPurpose('test', { env: safeTestEnv(), destructive: true }).safe).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------------- *
 * RESET-DIRECT — the exact bypass found by the external review (PR #32):
 * `resetDatabase(db)` dropped the schema of an arbitrary Knex object with no
 * authorization bound to that connection.
 * ------------------------------------------------------------------------- */

/** The disposable catalog used by the fake connection. */
const FIXTURE_TABLES = ['knex_migrations', 'system_settings', 'users'];

/**
 * A faithful-enough disposable database double: it tracks the catalog and every
 * statement, so a test can prove that NO destructive statement was issued.
 */
function disposableDatabaseFixture(tables = FIXTURE_TABLES) {
  const state = { tables: tables.slice(), statements: [] };
  return {
    state,
    raw: jest.fn(async (sql) => {
      state.statements.push(sql);
      if (/DROP\s+SCHEMA/i.test(sql)) {
        state.tables = [];
        return { rows: [] };
      }
      if (/pg_tables/i.test(sql)) {
        return { rows: state.tables.map((tablename) => ({ tablename })) };
      }
      return { rows: [] };
    }),
    destroy: jest.fn(async () => {}),
    transaction: jest.fn(),
    migrate: { latest: jest.fn() },
    schema: {},
  };
}

/** Every DROP/CREATE SCHEMA statement the fake connection received. */
function destructiveStatements(db) {
  return db.state.statements.filter((sql) => /DROP\s+SCHEMA|CREATE\s+SCHEMA/i.test(sql));
}

/** A real Knex instance shape (used to prove it cannot be passed in). */
function knexLikeObject(tables = ['production_users']) {
  const db = disposableDatabaseFixture(tables);
  db.client = { config: { connection: { host: '10.0.0.7', database: 'production' } } };
  return db;
}

/**
 * A real Knex instance is CALLABLE (`knex('table')`), which is how the live e2e
 * suite caught a first version of the misuse check: the "received function"
 * branch fired before the connection branch. This double reproduces that shape.
 */
function callableKnexLikeObject(tables = ['production_users']) {
  const db = disposableDatabaseFixture(tables);
  const callable = function knexDouble() { return db; };
  Object.assign(callable, db);
  return callable;
}

function armConnectionFactory(tables = FIXTURE_TABLES) {
  const db = disposableDatabaseFixture(tables);
  // Clear the call log so each scenario proves its own factory usage.
  dbConnection.createConnectionForTarget.mockClear();
  dbConnection.createConnectionForTarget.mockReturnValue(db);
  return db;
}

/**
 * The reset must refuse the environment BEFORE any connection exists: the
 * factory is not called, no SQL is issued, the catalog is untouched and the
 * connection (had it been created) is never destroyed.
 */
async function expectResetRefused(env, matcher, options = {}) {
  const db = armConnectionFactory();
  await expect(resetDatabase({ purpose: 'test', env, ...options })).rejects.toThrow(matcher);
  expect(dbConnection.createConnectionForTarget).not.toHaveBeenCalled();
  expect(db.raw).not.toHaveBeenCalled();
  expect(db.destroy).not.toHaveBeenCalled();
  expect(destructiveStatements(db)).toEqual([]);
  expect(db.state.tables).toEqual(FIXTURE_TABLES);
  return db;
}

describe('T01 SAFETY — RESET-DIRECT: the guarded public reset', () => {
  beforeEach(() => {
    dbConnection.createConnectionForTarget.mockReset();
  });

  describe('RESET-DIRECT-1 — no destructive consent, no DROP', () => {
    test('refuses without DB_RESET_CONFIRM and never opens a connection', async () => {
      await expectResetRefused(safeTestEnv({ [CONFIRM_VAR]: undefined }), /DB_RESET_CONFIRM must be exactly/);
    });

    test('refuses every near-miss consent value', async () => {
      for (const value of ['yes', 'true', '1', 'I_UNDERSTAND', 'confirm', RESET_CONFIRM_TOKEN.toLowerCase()]) {
        await expectResetRefused(safeTestEnv({ [CONFIRM_VAR]: value }), /DB_RESET_CONFIRM must be exactly/);
      }
    });

    test('the schema/tables are still intact after the refusal', async () => {
      const db = await expectResetRefused(safeTestEnv({ [CONFIRM_VAR]: undefined }), /Refusing to reset/);
      // The catalog the fixture exposes is exactly what a `pg_tables` read would
      // have returned before the refused reset: nothing was dropped.
      expect(db.state.tables).toEqual(FIXTURE_TABLES);
      expect(db.state.statements).toEqual([]);
    });
  });

  describe('RESET-DIRECT-2 — production-like targets are refused', () => {
    test('refuses NODE_ENV=production even with the token', async () => {
      await expectResetRefused(safeTestEnv({ NODE_ENV: 'production' }), /NODE_ENV=production/);
    });

    test('refuses every production-sounding database name', async () => {
      for (const name of [
        'socorre_ai_prod', 'socorre_ai_production', 'socorre_live_test', 'socorre_ai_vps_test',
        'socorre_ai_staging_test', 'socorre_ai_homolog_test', 'main_test', 'master_test',
      ]) {
        await expectResetRefused(safeTestEnv({ DB_NAME_TEST: name }), /forbidden hint/);
      }
    });

    test('the dev path refuses production-like targets too', async () => {
      const db = armConnectionFactory();
      await expect(resetDatabase({ purpose: 'dev', env: safeDevEnv({ NODE_ENV: 'production' }) }))
        .rejects.toThrow(/NODE_ENV=production/);
      await expect(resetDatabase({ purpose: 'dev', env: safeDevEnv({ DB_NAME: 'socorre_ai_prod' }) }))
        .rejects.toThrow(/forbidden hint/);
      expect(dbConnection.createConnectionForTarget).not.toHaveBeenCalled();
      expect(db.state.tables).toEqual(FIXTURE_TABLES);
    });
  });

  describe('RESET-DIRECT-3 — remote hosts are refused', () => {
    test('refuses every non-loopback host', async () => {
      for (const host of ['db.example.com', '10.0.0.7', 'postgres.internal', '192.168.1.20', 'prod-db.local']) {
        await expectResetRefused(safeTestEnv({ DB_HOST: host }), /DB_HOST must be loopback/);
      }
    });
  });

  describe('RESET-DIRECT-4 — wildcard bind addresses are refused', () => {
    test('refuses 0.0.0.0, :: and *', async () => {
      for (const host of ['0.0.0.0', '::', '*']) {
        await expectResetRefused(safeTestEnv({ DB_HOST: host }), /wildcard/);
      }
    });
  });

  describe('RESET-DIRECT-5 — privileged users are refused', () => {
    test('refuses postgres, root, admin, superuser and production-looking users', async () => {
      for (const user of ['postgres', 'root', 'admin', 'superuser', 'prod_admin', 'production_user']) {
        await expectResetRefused(safeTestEnv({ DB_USER: user }), /privileged/);
      }
    });
  });

  describe('RESET-DIRECT-6 — connection URLs are refused', () => {
    test('refuses DATABASE_URL and PostgreSQL, which may point anywhere', async () => {
      await expectResetRefused(
        safeTestEnv({ DATABASE_URL: 'postgresql://user:pw@prod.example.com:5432/socorre' }),
        /DATABASE_URL\/PostgreSQL must not be set/
      );
      await expectResetRefused(
        safeTestEnv({ PostgreSQL: 'postgresql://user:pw@prod.example.com:5432/socorre' }),
        /DATABASE_URL\/PostgreSQL must not be set/
      );
    });
  });

  describe('RESET-DIRECT-7 — authorization is bound to the destroyed target', () => {
    test('an arbitrary Knex object cannot be passed to the public reset', async () => {
      const foreign = knexLikeObject();
      await expect(resetDatabase(foreign)).rejects.toThrow(ResetApiMisuseError);
      await expect(resetDatabase(foreign)).rejects.toThrow(/does not accept a database connection/);
      expect(dbConnection.createConnectionForTarget).not.toHaveBeenCalled();
      expect(foreign.raw).not.toHaveBeenCalled();
      expect(foreign.state.tables).toEqual(['production_users']);
      expect(destructiveStatements(foreign)).toEqual([]);
    });

    test('a connection-shaped option object is refused as well', async () => {
      const foreign = knexLikeObject();
      await expect(resetDatabase({ purpose: 'test', env: safeTestEnv(), db: foreign }))
        .rejects.toThrow(/unknown reset option\(s\): db/);
      await expect(resetDatabase(null)).rejects.toThrow(ResetApiMisuseError);
      await expect(resetDatabase('postgresql://prod/db')).rejects.toThrow(ResetApiMisuseError);
      expect(foreign.state.tables).toEqual(['production_users']);
    });

    test('a CALLABLE Knex double (the real shape) gets the connection diagnosis', async () => {
      const foreign = callableKnexLikeObject();
      expect(typeof foreign).toBe('function');
      await expect(resetDatabase(foreign)).rejects.toThrow(ResetApiMisuseError);
      await expect(resetDatabase(foreign)).rejects.toThrow(/does not accept a database connection/);
      expect(dbConnection.createConnectionForTarget).not.toHaveBeenCalled();
      expect(foreign.raw).not.toHaveBeenCalled();
      expect(foreign.state.tables).toEqual(['production_users']);
      expect(destructiveStatements(foreign)).toEqual([]);
    });

    test('the destructive primitive is NOT exported and no export reaches it', async () => {
      expect(Object.keys(dbReset).sort()).toEqual(['ResetApiMisuseError', 'resetDatabase']);
      expect(dbReset.dropPublicSchema).toBeUndefined();
      for (const [name, value] of Object.entries(dbReset)) {
        if (typeof value !== 'function' || name === 'ResetApiMisuseError') continue;
        expect(name).not.toMatch(/drop|raw|schema|destroy|connection/i);
        const foreign = knexLikeObject();
        await expect(Promise.resolve(value(foreign))).rejects.toThrow(ResetApiMisuseError);
        expect(foreign.state.tables).toEqual(['production_users']);
        expect(destructiveStatements(foreign)).toEqual([]);
      }
    });

    test('the only DROP SCHEMA of scripts/tow lives in the private db-reset primitive', () => {
      const dir = path.join(BACKEND_DIR, 'scripts', 'tow');
      const offenders = fs.readdirSync(dir)
        .filter((file) => file.endsWith('.js'))
        .filter((file) => fs.readFileSync(path.join(dir, file), 'utf8').includes('DROP SCHEMA'));
      expect(offenders).toEqual(['db-reset.js']);
      // ... and in that file it is inside the private function, not an export.
      const source = fs.readFileSync(path.join(dir, 'db-reset.js'), 'utf8');
      expect(source).toMatch(/async function dropPublicSchema\(db\)/);
      expect(source).not.toMatch(/module\.exports[\s\S]*dropPublicSchema/);
    });

    test('the connection is built from the authorized target, never from the caller', async () => {
      const env = safeTestEnv();
      const authorized = assertResetAuthorized(env, { purpose: 'test' });
      const db = armConnectionFactory();
      const result = await resetDatabase({ purpose: 'test', env });

      expect(dbConnection.createConnectionForTarget).toHaveBeenCalledTimes(1);
      const [passedTarget] = dbConnection.createConnectionForTarget.mock.calls[0];
      expect(passedTarget).toEqual(authorized);
      expect(passedTarget.database).toBe('socorre_ai_tow_test');
      expect(result.target).toBe(describeResetTarget(authorized));

      // A different authorized target produces a different connection input:
      // there is no cached authorization that could be replayed.
      const secondDb = armConnectionFactory();
      await resetDatabase({ purpose: 'test', env: safeTestEnv({ DB_NAME_TEST: 'another_disposable_test' }) });
      expect(dbConnection.createConnectionForTarget).toHaveBeenLastCalledWith(
        expect.objectContaining({ database: 'another_disposable_test' })
      );
      expect(secondDb.state.tables).toEqual([]);
      expect(db.state.tables).toEqual([]);
    });
  });

  describe('RESET-DIRECT-8 — the authorized disposable target resets normally', () => {
    test('drops and recreates the schema on the authorized target only', async () => {
      const db = armConnectionFactory();
      const result = await resetDatabase({ purpose: 'test', env: safeTestEnv() });

      expect(result.dryRun).toBe(false);
      expect(result.dropped).toEqual(FIXTURE_TABLES);
      expect(result.target).toBe(describeResetTarget(assertResetAuthorized(safeTestEnv(), { purpose: 'test' })));
      expect(db.state.tables).toEqual([]);
      expect(db.state.statements).toEqual([
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
        'DROP SCHEMA IF EXISTS public CASCADE',
        'CREATE SCHEMA public',
      ]);
      expect(db.destroy).toHaveBeenCalledTimes(1);
      expect(dbConnection.createConnectionForTarget).toHaveBeenCalledTimes(1);
    });

    test('the authorized dev target resets normally as well', async () => {
      const db = armConnectionFactory();
      const result = await resetDatabase({ purpose: 'dev', env: safeDevEnv() });
      expect(result.dropped).toEqual(FIXTURE_TABLES);
      expect(db.state.tables).toEqual([]);
      expect(db.destroy).toHaveBeenCalledTimes(1);
    });

    test('--dry-run needs no token but still requires an authorized target', async () => {
      const db = armConnectionFactory(['users']);
      const result = await resetDatabase({
        purpose: 'test',
        env: safeTestEnv({ [CONFIRM_VAR]: undefined }),
        dryRun: true,
      });
      expect(result).toMatchObject({ dryRun: true, tables: ['users'], dropped: [] });
      expect(destructiveStatements(db)).toEqual([]);
      expect(db.state.tables).toEqual(['users']);
      expect(db.destroy).toHaveBeenCalledTimes(1);

      // An unsafe target is refused even for the read-only dry-run.
      await expectResetRefused(
        safeTestEnv({ [CONFIRM_VAR]: undefined, DB_HOST: '10.0.0.7' }),
        /DB_HOST must be loopback/,
        { dryRun: true }
      );
    });
  });
});

/* ------------------------------------------------------------------------- *
 * The unmanaged-database rule is centralized (external review: migration
 * escape-hatch audit).
 * ------------------------------------------------------------------------- */

describe('T01 SAFETY — baseline eligibility is centralized', () => {
  test('empty and managed databases are eligible; an unmanaged one is not', () => {
    expect(baselineEligibility([])).toEqual({ eligible: true, managed: false, reason: 'empty' });
    expect(baselineEligibility(['knex_migrations', 'users'])).toEqual({ eligible: true, managed: true, reason: 'managed' });
    expect(baselineEligibility(['users', 'partners'])).toEqual({ eligible: false, managed: false, reason: 'unmanaged' });
    expect(baselineEligibility(undefined)).toEqual({ eligible: true, managed: false, reason: 'empty' });
  });

  test('migrateBaseline refuses an unmanaged database before Knex runs a migration', async () => {
    const db = {
      raw: jest.fn(async () => ({ rows: [{ tablename: 'legacy_users' }, { tablename: 'legacy_orders' }] })),
      migrate: { latest: jest.fn() },
    };
    await expect(migrateBaseline(db)).rejects.toThrow(UnmanagedDatabaseError);
    await expect(migrateBaseline(db)).rejects.toThrow(/not created by this baseline/);
    await expect(migrateBaseline(db)).rejects.toThrow(/db:reset/);
    expect(db.migrate.latest).not.toHaveBeenCalled();
  });

  test('migrateBaseline accepts an empty database and an already-managed one', async () => {
    for (const tables of [[], ['knex_migrations']]) {
      const latest = jest.fn(async () => [3, ['001_baseline_schema.js']]);
      const db = {
        raw: jest.fn(async () => ({ rows: tables.map((tablename) => ({ tablename })) })),
        migrate: { latest },
      };
      await expect(migrateBaseline(db)).resolves.toEqual({ batch: 3, applied: ['001_baseline_schema.js'] });
      expect(latest).toHaveBeenCalledTimes(1);
    }
  });

  test('assertBaselineEligible reports the shared decision', async () => {
    const db = { raw: jest.fn(async () => ({ rows: [{ tablename: 'knex_migrations' }] })) };
    await expect(assertBaselineEligible(db)).resolves.toEqual({
      eligible: true,
      managed: true,
      reason: 'managed',
      tables: ['knex_migrations'],
    });
  });

  test('db:migrate has no --allow-existing escape hatch any more', () => {
    const source = fs.readFileSync(path.join(BACKEND_DIR, 'scripts', 'tow', 'db-migrate.js'), 'utf8');
    expect(source).not.toMatch(/allowExisting\s*=/);
    expect(source).not.toMatch(/or pass --allow-existing/);
    expect(source).toMatch(/--allow-existing was removed/);
  });
});

/* ------------------------------------------------------------------------- *
 * MMVP-3 — the migration scope is PINNED: the directory is only a
 * cross-check, so a smuggled migration fails loudly instead of being absorbed.
 * ------------------------------------------------------------------------- */

describe('T01 SAFETY — the migration scope is pinned (no silent drift)', () => {
  test('the exact 3 MVP-01 migrations are pinned', () => {
    expect(PINNED_MIGRATIONS).toEqual([
      '001_baseline_schema.js',
      '002_baseline_settings.js',
      '003_mvp01_tow_foundation.js',
    ]);
  });

  test('the real migrations directory matches the pinned list', () => {
    expect(directoryMigrations()).toEqual(PINNED_MIGRATIONS.slice().sort());
    expect(expectedMigrations()).toEqual(PINNED_MIGRATIONS.slice().sort());
  });

  test('an extra migration file FAILS LOUDLY and names the unexpected file', () => {
    const smuggled = [...PINNED_MIGRATIONS, '004_smuggled_scope.js'].sort();
    expect(() => assertPinnedMigrations(PINNED_MIGRATIONS, smuggled)).toThrow(/unexpected/);
    expect(() => assertPinnedMigrations(PINNED_MIGRATIONS, smuggled)).toThrow(/004_smuggled_scope\.js/);
  });

  test('a missing migration file also fails loudly', () => {
    expect(() => assertPinnedMigrations(PINNED_MIGRATIONS, PINNED_MIGRATIONS.slice(0, -1)))
      .toThrow(/missing: 003_mvp01_tow_foundation\.js/);
  });
});
