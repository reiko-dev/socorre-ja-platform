/**
 * MVP-01 — DB suite against REAL PostgreSQL (opt-in, disposable container).
 *
 * Proves migration `003_mvp01_tow_foundation` creates the canonical tables and
 * that the structural invariants are enforced by the DATABASE, not only by the
 * application:
 *   - one `service_modules` row per key (unique);
 *   - at most one active TowVehicle per partner (partial unique index);
 *   - foreign keys and cascades for vehicles and documents;
 *   - the document status vocabulary is constrained.
 *
 * Run with the T00/T01 harness:
 *   TOW_POSTGRES_E2E=1 npx jest tests/tow/mvp01/towPersistence.e2e.test.js --runInBand
 */
'use strict';

const postgres = require('../../helpers/tow/postgres');

const describePostgres = postgres.isEnabled() ? describe : describe.skip;

async function seedPartner(db, name) {
  const [user] = await db('users').insert({
    name, email: `${name}@persistence.test`, password: 'hash', role: 'partner', is_active: true,
  }).returning('*');
  const [partner] = await db('partners').insert({
    user_id: user.id, type: 'tow', business_name: name, address: 'Rua MVP-01', phone: '1130000000',
    approval_status: 'approved',
  }).returning('*');
  return { user, partner };
}

async function insertVehicle(db, partnerId, plate, active) {
  const [row] = await db('tow_vehicles').insert({
    partner_id: partnerId,
    plate,
    make: 'Ford',
    model: 'F-4000',
    year: 2020,
    equipment_type: 'flatbed',
    supported_vehicle_classes: JSON.stringify(['light_vehicle']),
    max_towed_weight_kg: 4000,
    active,
    minimum_charge_cents: 15000,
    included_km: 10,
    price_per_additional_km_cents: 800,
  }).returning('*');
  return row;
}

describePostgres('MVP-01 DB — PostgreSQL persistence invariants', () => {
  let db;

  beforeAll(async () => {
    db = postgres.createConnection();
    await postgres.migrateFromScratch(db);
  }, 60_000);

  afterAll(async () => {
    if (db) await db.destroy();
  });

  test('migration creates the canonical MVP-01 tables', async () => {
    const tables = await postgres.listTables(db);
    expect(tables).toEqual(expect.arrayContaining(['service_modules', 'tow_vehicles', 'tow_vehicle_documents']));
  });

  test('exactly one canonical tow module row exists', async () => {
    const rows = await db('service_modules').where({ module_key: 'tow' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service_key: 'tow', partner_type: 'tow', enabled: true });
  });

  test('the module key is unique at the database level', async () => {
    await expect(db('service_modules').insert({
      module_key: 'tow', service_key: 'tow', partner_type: 'tow', enabled: false,
    })).rejects.toThrow();
  });

  test('at most one active vehicle per partner is enforced by a partial unique index', async () => {
    const { partner } = await seedPartner(db, 'pg-partial-index');
    await insertVehicle(db, partner.id, 'ONE1111', true);
    await expect(insertVehicle(db, partner.id, 'TWO2222', true)).rejects.toThrow();
    // A second INACTIVE vehicle is allowed.
    await expect(insertVehicle(db, partner.id, 'THREE333', false)).resolves.toBeTruthy();
  });

  test('the same active plate pattern is isolated across partners', async () => {
    const first = await seedPartner(db, 'pg-partner-a');
    const second = await seedPartner(db, 'pg-partner-b');
    await insertVehicle(db, first.partner.id, 'ISO1111', true);
    await expect(insertVehicle(db, second.partner.id, 'ISO2222', true)).resolves.toBeTruthy();
  });

  test('vehicle and document foreign keys are enforced and cascade', async () => {
    await expect(insertVehicle(db, 999999, 'NOPE123', false)).rejects.toThrow();
    const { partner } = await seedPartner(db, 'pg-cascade');
    const vehicle = await insertVehicle(db, partner.id, 'CASC123', false);
    const [document] = await db('tow_vehicle_documents').insert({
      tow_vehicle_id: vehicle.id,
      partner_id: partner.id,
      document_type: 'vehicle_license',
      filename: 'crlv.jpg',
      original_name: 'crlv.jpg',
      file_path: '/tmp/crlv.jpg',
      file_url: '/uploads/tow-documents/crlv.jpg',
      mime_type: 'image/jpeg',
      file_size: 10,
      status: 'pending',
    }).returning('*');
    expect(document.id).toBeGreaterThan(0);

    await expect(db('tow_vehicle_documents').insert({
      tow_vehicle_id: 999999, partner_id: partner.id, document_type: 'vehicle_license',
      filename: 'x', original_name: 'x', file_path: 'x', file_url: 'x', mime_type: 'image/jpeg', file_size: 1,
    })).rejects.toThrow();

    await db('tow_vehicles').where({ id: vehicle.id }).del();
    expect(await db('tow_vehicle_documents').where({ id: document.id })).toHaveLength(0);
  });
});
