/**
 * MVP-01 — CONC suite against REAL PostgreSQL (opt-in, disposable container).
 *
 * Proves the critical #13 invariants under concurrency:
 *   - two simultaneous activations can never leave TWO active TowVehicles for
 *     one partner (exactly one active is the only accepted outcome);
 *   - repeated module toggles are idempotent (one row, last write wins);
 *   - many parallel vehicle creations for one partner preserve the invariant.
 *
 * Run with the T00/T01 harness:
 *   TOW_POSTGRES_E2E=1 npx jest tests/tow/mvp01/towVehicleConcurrency.e2e.test.js --runInBand
 */
'use strict';

const postgres = require('../../helpers/tow/postgres');

const describePostgres = postgres.isEnabled() ? describe : describe.skip;

const { buildTowServices, TowError } = require('../../../src/modules/tow');

async function seedTowPartner(db, name) {
  const [user] = await db('users').insert({
    name, email: `${name}@concurrency.test`, password: 'hash', role: 'partner', is_active: true,
  }).returning('*');
  const [partner] = await db('partners').insert({
    user_id: user.id, type: 'tow', business_name: name, address: 'Rua CONC', phone: '1130000000',
    approval_status: 'approved',
  }).returning('*');
  return { user, partner };
}

const vehicleInput = (plate) => ({
  plate,
  make: 'Ford',
  model: 'F-4000',
  year: 2020,
  equipment_type: 'flatbed',
  supported_vehicle_classes: ['light_vehicle'],
  max_towed_weight_kg: 4000,
  pricing: { minimum_charge_cents: 15000, included_km: 10, price_per_additional_km_cents: 800 },
});

describePostgres('MVP-01 CONC — real PostgreSQL concurrency', () => {
  let db;
  let services;

  beforeAll(async () => {
    db = postgres.createConnection();
    await postgres.migrateFromScratch(db);
    services = buildTowServices({ db });
  }, 60_000);

  afterAll(async () => {
    if (db) await db.destroy();
  });

  test('two concurrent activations leave exactly one active vehicle', async () => {
    const { partner } = await seedTowPartner(db, 'conc-activate');
    const first = await services.vehicleService.create({ partnerId: partner.id, input: vehicleInput('CONC111') });
    const second = await services.vehicleService.create({ partnerId: partner.id, input: vehicleInput('CONC222') });

    const results = await Promise.allSettled([
      services.vehicleService.activate({ partnerId: partner.id, vehicleId: first.id }),
      services.vehicleService.activate({ partnerId: partner.id, vehicleId: second.id }),
    ]);

    const active = await db('tow_vehicles').where({ partner_id: partner.id, active: true });
    expect(active).toHaveLength(1);
    expect(results).toHaveLength(2);
    // At least one activation succeeded; the invariant above is asserted
    // unconditionally. Rejections may be zero when the two activations are
    // serialized (last write wins), so the mapping is asserted only when a
    // rejection is actually observed HERE; the deterministic injected-failure
    // proof lives in `towActivateConflictMapping.test.js`.
    const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const rejected = results.filter((entry) => entry.status === 'rejected');
    for (const entry of rejected) {
      expect(entry.reason).toBeInstanceOf(TowError);
      expect(entry.reason.code).toBe('conflict');
    }
  });

  test('the partial unique index rejects a second active row (real-PG direct SQL proof)', async () => {
    const { partner } = await seedTowPartner(db, 'conc-direct-sql');
    const first = await services.vehicleService.create({ partnerId: partner.id, input: vehicleInput('SQLP111') });
    const second = await services.vehicleService.create({ partnerId: partner.id, input: vehicleInput('SQLP222') });

    await services.vehicleService.activate({ partnerId: partner.id, vehicleId: first.id });
    await expect(
      db('tow_vehicles').where({ id: second.id }).update({ active: true })
    ).rejects.toThrow();

    const active = await db('tow_vehicles').where({ partner_id: partner.id, active: true });
    expect(active).toHaveLength(1);
    expect(String(active[0].id)).toBe(String(first.id));
  });

  test('repeated identical module toggles keep a single canonical row', async () => {
    await services.moduleService.setEnabled({ enabled: false, reason: 'first disable', adminUserId: null });
    await services.moduleService.setEnabled({ enabled: false, reason: 'second disable', adminUserId: null });
    const rows = await db('service_modules').where({ module_key: 'tow' });
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(false);
    expect(rows[0].disabled_reason).toBe('first disable');

    await services.moduleService.setEnabled({ enabled: true, reason: 're-enable', adminUserId: null });
    const after = await db('service_modules').where({ module_key: 'tow' }).first();
    expect(after.enabled).toBe(true);
    expect(after.disabled_reason).toBeNull();
    expect(await db('service_modules').count('* as count').first().then((row) => Number(row.count))).toBe(1);
  });

  test('parallel vehicle creation never creates a second active vehicle', async () => {
    const { partner } = await seedTowPartner(db, 'conc-create');
    await Promise.all(Array.from({ length: 5 }, (_, index) => (
      services.vehicleService.create({ partnerId: partner.id, input: vehicleInput(`PAR${index}11`) })
    )));
    const active = await db('tow_vehicles').where({ partner_id: partner.id, active: true });
    expect(active).toHaveLength(0);
    const count = await db('tow_vehicles').where({ partner_id: partner.id }).count('* as count').first();
    expect(Number(count.count)).toBe(5);
  });
});
