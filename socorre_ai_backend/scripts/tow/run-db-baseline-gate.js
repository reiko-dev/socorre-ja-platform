#!/usr/bin/env node
/**
 * T01 — clean database gate.
 *
 * Proves, against a REAL PostgreSQL in a DISPOSABLE container, that the
 * baseline boots from nothing and is reproducible:
 *
 *   1. guard: refuse anything that is not the disposable loopback test target;
 *   2. start the T00 container (new volume) and wait for health;
 *   3. assert the database is EMPTY (0 tables) — a genuinely new database;
 *   4. migrate from zero            -> exactly the baseline migrations;
 *   5. seed                         -> exactly one administrator;
 *   6. assert the clean-baseline rules (no functional data);
 *   7. schema snapshot (run 1);
 *   8. GUARDED destructive reset, then migrate + seed + assert again;
 *   9. schema snapshot (run 2) and fingerprint comparison with run 1;
 *  10. destroy containers, volume and network; a teardown failure is RED;
 *  11. verify nothing is left behind for this Compose project.
 *
 * Every failure is a RED gate: the process exits non-zero and prints which
 * stage failed. The volume is destroyed even when a stage throws
 * (`runWithEnvironment` guarantee).
 *
 * Usage:
 *   npm run test:db-baseline
 *   node scripts/tow/run-db-baseline-gate.js [--keep-evidence <dir>]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const testEnv = require('./test-env');
const {
  createConnection,
  checkPurpose,
  loadPurposeEnv,
} = require('./db-connection');
const { RESET_CONFIRM_TOKEN, CONFIRM_VAR, describeResetTarget } = require('./db-reset-guard');
const {
  MIGRATIONS_DIR,
  migrateBaseline,
  runSeed,
  assertBaseline,
  collectReport,
  listTables,
} = require('./db-baseline');
const { resetDatabase } = require('./db-reset');
const { disposableAdminCredentials } = require('./disposable-credentials');
const { describeSeedResult } = require('./admin-seed');
const { snapshotSchema, compareSnapshots, formatComparison, fingerprintOf } = require('./schema-snapshot');

const EVIDENCE_DIR = path.resolve(testEnv.BACKEND_DIR, '..', 'docs', 'evidence', 't01');

/**
 * The expected applied migration list is PINNED explicitly, so a smuggled
 * migration (e.g. `004_*.js`) can never be absorbed silently: any directory
 * content that differs from this list trips the gate with the unexpected
 * filename. The directory read is only a cross-check.
 */
const PINNED_MIGRATIONS = Object.freeze([
  '001_baseline_schema.js',
  '002_baseline_settings.js',
  '003_mvp01_tow_foundation.js',
]);

function directoryMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.js')).sort();
}

/**
 * Pure cross-check used by the gate (and unit-tested offline): any file in the
 * directory that is not in the pinned list is named in the thrown error, so a
 * smuggled migration trips the gate instead of being absorbed silently.
 */
function assertPinnedMigrations(pinned, actual) {
  const expected = pinned.slice().sort();
  const found = actual.slice().sort();
  const unexpected = found.filter((file) => !expected.includes(file));
  const missing = expected.filter((file) => !found.includes(file));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      'migrations directory does not match the pinned MVP-01 baseline '
      + `(unexpected: ${unexpected.join(', ') || '(none)'}; missing: ${missing.join(', ') || '(none)'}; `
      + `expected: [${expected.join(', ')}], found: [${found.join(', ')}])`
    );
  }
  return expected;
}

function expectedMigrations() {
  return assertPinnedMigrations(PINNED_MIGRATIONS, directoryMigrations());
}

function assertEmptyDatabase(tables) {
  if (tables.length !== 0) {
    throw new Error(
      `expected a brand new database with 0 tables, found ${tables.length}: ${tables.slice(0, 5).join(', ')}`
    );
  }
}

function assertApplied(applied, expected) {
  const names = applied.slice().sort();
  const want = expected.slice().sort();
  if (names.length !== want.length || names.some((name, index) => name !== want[index])) {
    throw new Error(`expected migrations ${want.join(', ')}, applied ${names.join(', ') || '(none)'}`);
  }
}

/** Prove the Compose project left no container, volume or network behind. */
function assertEnvironmentGone(project) {
  const filters = [['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'],
    ['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'],
    ['network', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']];
  const leftovers = [];
  for (const args of filters) {
    const result = spawnSync('docker', args, { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`docker ${args.join(' ')} failed (status ${result.status}): ${result.stderr || ''}`.trim());
    }
    const lines = String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
    leftovers.push(...lines);
  }
  if (leftovers.length > 0) {
    throw new Error(`the gate left resources behind for project "${project}": ${leftovers.join(', ')}`);
  }
  console.log(`[db-gate] teardown verified: no container/volume/network left for project "${project}"`);
}

/**
 * Start from a TRULY new PostgreSQL: destroy any environment left over from a
 * previous run (container + volume + network), then create it again. Without
 * this the gate could reuse an old volume and stage 2 would not be a real
 * "boots from zero" proof.
 */
function freshUp() {
  testEnv.down();
  testEnv.up();
}

async function runGate() {
  const project = testEnv.resolveComposeProject(testEnv.targetEnv());
  console.log(`[db-gate] compose project: ${project}`);
  console.log('[db-gate] stage 1/9: guard + container up (previous environment destroyed first)');

  return testEnv.runWithEnvironment(async (target) => {
    console.log(`[db-gate] target: ${describeResetTarget({ ...target, purpose: 'test' })}`);

    // The gate IS the explicitly authorized disposable environment, so it
    // authorizes its own destructive reset with the same token an operator
    // would have to type. No other code path sets this variable.
    process.env[CONFIRM_VAR] = RESET_CONFIRM_TOKEN;
    const admin = disposableAdminCredentials('gate');
    Object.assign(process.env, admin);

    const db = createConnection({ purpose: 'test' });
    try {
      console.log('[db-gate] stage 2/9: verify the database is empty');
      const before = await listTables(db);
      assertEmptyDatabase(before);
      console.log('[db-gate] database is empty (0 tables) — new disposable volume confirmed');

      console.log('[db-gate] stage 3/9: migrate from zero');
      const first = await migrateBaseline(db);
      assertApplied(first.applied, expectedMigrations());
      console.log(`[db-gate] migrations applied: ${first.applied.join(', ')} (batch ${first.batch})`);

      console.log('[db-gate] stage 4/9: seed the default administrator');
      const seed = await runSeed(db, process.env);
      if (!seed.created) throw new Error(`expected the administrator to be created, got "${seed.reason}"`);
      console.log(`[db-gate] ${describeSeedResult(seed)}`);

      console.log('[db-gate] stage 5/9: assert the clean baseline');
      const firstReport = await assertBaseline(db, { expectedAdminEmail: admin.ADMIN_EMAIL });
      console.log(
        `[db-gate] baseline OK: ${firstReport.tables.length} tables, ${firstReport.totalRows} row(s), ` +
        `settings=${firstReport.settings.count}`
      );

      console.log('[db-gate] stage 6/9: schema snapshot (run 1)');
      const snapshotOne = await snapshotSchema(db);
      const fingerprintOne = fingerprintOf(snapshotOne);
      console.log(`[db-gate] run 1 fingerprint: ${fingerprintOne}`);

      console.log('[db-gate] stage 7/9: guarded destructive reset + repeat');
      // ONLY the guarded public API: it resolves + authorizes this exact target,
      // builds the connection FROM that authorized target and drops the schema.
      const { dropped } = await resetDatabase({ purpose: 'test' });
      console.log(`[db-gate] guarded reset dropped ${dropped.length} table(s)`);
      const afterReset = await listTables(db);
      assertEmptyDatabase(afterReset);
      const second = await migrateBaseline(db);
      assertApplied(second.applied, expectedMigrations());
      const seedAgain = await runSeed(db, process.env);
      if (!seedAgain.created) throw new Error(`expected the administrator to be created again, got "${seedAgain.reason}"`);
      const secondReport = await assertBaseline(db, { expectedAdminEmail: admin.ADMIN_EMAIL });
      console.log(
        `[db-gate] repeat OK: ${secondReport.tables.length} tables, ${secondReport.totalRows} row(s)`
      );

      console.log('[db-gate] stage 8/9: schema snapshot (run 2) + fingerprint comparison');
      const snapshotTwo = await snapshotSchema(db);
      const fingerprintTwo = fingerprintOf(snapshotTwo);
      console.log(`[db-gate] run 2 fingerprint: ${fingerprintTwo}`);
      const comparison = compareSnapshots(snapshotOne, snapshotTwo);
      if (!comparison.equal) {
        console.log(formatComparison(comparison));
        throw new Error('the schema produced by the second fresh run differs from the first');
      }
      console.log('[db-gate] fingerprints identical: reset+migrate+seed reproduces the same schema');

      // Evidence, written only after the gate is green.
      const evidence = {
        project,
        target: describeResetTarget({ ...target, purpose: 'test' }),
        run1: { fingerprint: fingerprintOne, tables: firstReport.tables.length, rows: firstReport.totalRows },
        run2: { fingerprint: fingerprintTwo, tables: secondReport.tables.length, rows: secondReport.totalRows },
        migrations: first.applied,
        seed: { created: seed.created, id: seed.userId, email: seed.email },
        report: secondReport,
      };
      return evidence;
    } finally {
      await db.destroy();
    }
  }, { up: freshUp });
}

async function main() {
  if (!testEnv.enableOptIn()) {
    throw new Error('TOW_POSTGRES_E2E=0 explicitly disables the PostgreSQL gate');
  }
  const evidenceIndex = process.argv.indexOf('--keep-evidence');
  const evidenceFile = evidenceIndex !== -1
    ? path.resolve(process.argv[evidenceIndex + 1])
    : path.join(EVIDENCE_DIR, 'db-baseline-gate.json');

  // Fail closed before Docker is even touched. The `test` purpose resolves the
  // same disposable target the commands use (`.env.test` when present, harness
  // defaults otherwise) and the guard rules are applied to the result.
  loadPurposeEnv('test');
  const check = checkPurpose('test', {});
  if (!check.safe) {
    throw new Error(`refusing to run the clean database gate: ${check.violations.join('; ')}`);
  }

  const evidence = await runGate();
  assertEnvironmentGone(testEnv.resolveComposeProject(testEnv.targetEnv()));

  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[db-gate] GREEN — evidence written to ${evidenceFile}`);
}

if (require.main === module) {
  main().catch((error) => {
    const teardown = error && error.teardownError ? ` (teardown also failed: ${error.teardownError.message})` : '';
    console.error(`[db-gate] RED — ${error && error.message ? error.message : error}${teardown}`);
    process.exit(1);
  });
}

module.exports = {
  disposableAdminCredentials,
  assertEmptyDatabase,
  assertApplied,
  assertEnvironmentGone,
  runGate,
  PINNED_MIGRATIONS,
  directoryMigrations,
  assertPinnedMigrations,
  expectedMigrations,
};
