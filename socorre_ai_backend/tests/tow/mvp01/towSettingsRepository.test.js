/**
 * MVP-01 — UNIT suite for the transactional Tow settings upsert.
 *
 * MMVP-6: `settings-repository.upsertMany` must apply the whole patch or
 * nothing. The fake Knex below models the only property that matters here:
 * writes done through the transaction's `trx` are STAGED and become visible
 * only when the transaction callback resolves; writes done through `db`
 * directly land in the committed store immediately. A partial (buggy) upsert
 * therefore leaves rows behind on failure, while the transactional one does
 * not. No real database is used.
 */
'use strict';

const { createSettingsRepository } = require('../../../src/modules/tow/adapters/persistence/settings-repository');
const { createSettingsService } = require('../../../src/modules/tow/application/settings-service');

function createFakeKnex({ failOnKey = null } = {}) {
  const committed = new Map();
  const state = { transactions: 0 };

  function builderFor(store) {
    const builder = {
      _key: undefined,
      _keys: null,
      where(criteria = {}) {
        builder._key = criteria.setting_key;
        return builder;
      },
      whereIn(field, keys) {
        builder._keys = keys;
        return builder;
      },
      orderBy() {
        return builder;
      },
      async first() {
        if (builder._key === undefined) return null;
        return store.get(builder._key) || null;
      },
      async insert(row) {
        if (failOnKey && row.setting_key === failOnKey) {
          throw new Error(`injected settings failure on ${row.setting_key}`);
        }
        store.set(row.setting_key, row);
        return [row];
      },
      async update(row) {
        store.set(row.setting_key, row);
        return 1;
      },
      then(resolve, reject) {
        let rows = Array.from(store.values());
        if (Array.isArray(builder._keys)) {
          rows = rows.filter((row) => builder._keys.includes(row.setting_key));
        }
        rows.sort((a, b) => a.setting_key.localeCompare(b.setting_key));
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return builder;
  }

  const db = () => builderFor(committed);
  db.transaction = async (fn) => {
    state.transactions += 1;
    const staging = new Map(committed);
    const result = await fn(() => builderFor(staging));
    committed.clear();
    for (const [key, value] of staging) committed.set(key, value);
    return result;
  };
  db.fn = { now: () => new Date('2026-06-01T00:00:00.000Z') };

  return { db, committed, state };
}

function row(key, value) {
  return { setting_key: key, setting_value: String(value) };
}

describe('MVP-01 UNIT — settings upsert is transactional', () => {
  test('a successful patch applies every key inside one transaction', async () => {
    const { db, committed, state } = createFakeKnex();
    const repository = createSettingsRepository(db);

    const written = await repository.upsertMany([
      row('tow_initial_radius_km', 20),
      row('tow_proposal_expiry_minutes', 25),
    ]);

    expect(written).toBe(2);
    expect(state.transactions).toBe(1);
    expect(committed.size).toBe(2);
    expect(committed.get('tow_initial_radius_km').setting_value).toBe('20');
    expect(committed.get('tow_proposal_expiry_minutes').setting_value).toBe('25');
  });

  test('a mid-loop failure rolls the whole patch back (new keys)', async () => {
    const { db, committed } = createFakeKnex({ failOnKey: 'tow_proposal_expiry_minutes' });
    const repository = createSettingsRepository(db);

    await expect(repository.upsertMany([
      row('tow_initial_radius_km', 20),
      row('tow_proposal_expiry_minutes', 25),
    ])).rejects.toThrow(/injected settings failure/);

    expect(committed.size).toBe(0);
  });

  test('a mid-loop failure does not clobber an existing value', async () => {
    const { db, committed } = createFakeKnex({ failOnKey: 'tow_proposal_expiry_minutes' });
    committed.set('tow_initial_radius_km', row('tow_initial_radius_km', 15));
    const repository = createSettingsRepository(db);

    await expect(repository.upsertMany([
      row('tow_initial_radius_km', 20),
      row('tow_proposal_expiry_minutes', 25),
    ])).rejects.toThrow(/injected settings failure/);

    expect(committed.size).toBe(1);
    expect(committed.get('tow_initial_radius_km').setting_value).toBe('15');
  });

  test('an empty patch is a no-op and opens no transaction', async () => {
    const { db, state } = createFakeKnex();
    const repository = createSettingsRepository(db);

    await expect(repository.upsertMany([])).resolves.toBe(0);
    expect(state.transactions).toBe(0);
  });

  test('the settings service applies and reads back a two-key patch', async () => {
    const { db } = createFakeKnex();
    const repository = createSettingsRepository(db);
    const service = createSettingsService({
      settingsRepository: repository,
      clock: { now: () => new Date('2026-06-01T00:00:00.000Z') },
    });

    const merged = await service.patch({ tow_initial_radius_km: 20, tow_proposal_expiry_minutes: 25 });
    expect(merged.tow_initial_radius_km).toBe(20);
    expect(merged.tow_proposal_expiry_minutes).toBe(25);

    const read = await service.get();
    expect(read.tow_initial_radius_km).toBe(20);
    expect(read.tow_proposal_expiry_minutes).toBe(25);
  });
});
