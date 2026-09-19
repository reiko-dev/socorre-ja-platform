/**
 * MVP-01 — deterministic negative control for the activation conflict mapping.
 *
 * The concurrency e2e can observe zero rejections (the two activations can be
 * serialized), which would make its "rejected must be a conflict" assertion
 * vacuous and leave the `23505/unique -> TowError('conflict')` branch of
 * `vehicle-repository.activate` unexercised. This suite forces a
 * 23505-shaped failure through the REAL service -> REAL repository path using a
 * fake Knex transaction, and asserts the mapped conflict. It runs offline.
 */
'use strict';

const { createVehicleRepository } = require('../../../src/modules/tow/adapters/persistence/vehicle-repository');
const { createVehicleService } = require('../../../src/modules/tow/application/vehicle-service');
const { TowError } = require('../../../src/modules/tow/domain');

const NOW = new Date('2026-06-01T00:00:00.000Z');

function vehicleRow() {
  return {
    id: 7,
    partner_id: 3,
    plate: 'ABC1D23',
    make: 'Ford',
    model: 'F-4000',
    year: 2020,
    equipment_type: 'flatbed',
    supported_vehicle_classes: '["light_vehicle"]',
    max_towed_weight_kg: 4000,
    active: false,
    minimum_charge_cents: 15000,
    included_km: 10,
    price_per_additional_km_cents: 800,
  };
}

function chain(row, onUpdate) {
  const builder = {
    where: () => builder,
    whereNot: () => builder,
    update: onUpdate,
    first: async () => row,
  };
  return builder;
}

/**
 * Fake Knex whose transaction throws `error` on the SECOND update (the real
 * activation first deactivates siblings, then activates the target).
 */
function constraintKnex(error) {
  const row = vehicleRow();
  const db = () => chain(row, async () => 1);
  db.transaction = async (fn) => {
    let updates = 0;
    const trx = () => chain(row, async () => {
      updates += 1;
      if (updates > 1) throw error;
      return 1;
    });
    trx.fn = { now: () => NOW };
    return fn(trx);
  };
  db.fn = { now: () => NOW };
  return db;
}

function buildService(db) {
  const vehicleRepository = createVehicleRepository(db);
  return createVehicleService({
    vehicleRepository,
    documentRepository: { listByVehicle: async () => [] },
    clock: { now: () => NOW },
  });
}

describe('MVP-01 UNIT — activation unique-violation mapping', () => {
  test('a PostgreSQL 23505 through service -> repository maps to conflict', async () => {
    const error = Object.assign(
      new Error('duplicate key value violates unique constraint "tow_vehicles_one_active_per_partner"'),
      { code: '23505' }
    );
    const service = buildService(constraintKnex(error));

    const rejection = await service.activate({ partnerId: 3, vehicleId: 7 }).catch((caught) => caught);
    expect(rejection).toBeInstanceOf(TowError);
    expect(rejection).toMatchObject({ code: 'conflict', httpStatus: 409 });
  });

  test('a SQLite SQLITE_CONSTRAINT through service -> repository maps to conflict', async () => {
    const error = Object.assign(
      new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: tow_vehicles.partner_id, tow_vehicles.plate'),
      { code: 'SQLITE_CONSTRAINT' }
    );
    const service = buildService(constraintKnex(error));

    const rejection = await service.activate({ partnerId: 3, vehicleId: 7 }).catch((caught) => caught);
    expect(rejection).toBeInstanceOf(TowError);
    expect(rejection).toMatchObject({ code: 'conflict', httpStatus: 409 });
  });

  test('a non-unique failure is NOT mapped to conflict (mapping is specific)', async () => {
    const error = new Error('connection terminated unexpectedly');
    const service = buildService(constraintKnex(error));

    const rejection = await service.activate({ partnerId: 3, vehicleId: 7 }).catch((caught) => caught);
    expect(rejection).toBe(error);
    expect(rejection.code).not.toBe('conflict');
  });
});
