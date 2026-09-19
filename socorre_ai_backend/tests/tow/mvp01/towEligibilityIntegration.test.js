/**
 * MVP-01 EXT — eligibility through the composition root + real persistence.
 *
 * EXT-MVP01-2: the central eligibility seam must consult partner identity. This
 * suite wires `buildTowServices` against the real (SQLite) persistence adapters
 * and proves:
 *   - a tow partner with an active TowVehicle and an approved document is
 *     eligible;
 *   - a `tow -> non-tow` type mutation makes eligibility immediately false;
 *   - the mutation does NOT delete or mutate the TowVehicle/registration row.
 *
 * RED-first: written before the partner port is wired.
 */
'use strict';

jest.mock('../../../src/config/database', () => require('../../helpers/testDb').db);

const testDb = require('../../helpers/testDb');
const { buildTowServices } = require('../../../src/modules/tow/composition');

const requested = { class: 'light_vehicle', weight_kg: 1200 };

describe('MVP-01 EXT — eligibility via composition + persistence', () => {
  let services;

  beforeAll(async () => {
    await testDb.reset();
    services = buildTowServices({ db: testDb.db });
  });

  afterAll(async () => {
    await testDb.reset();
  });

  async function seedTowPartnerWithVehicle(plate) {
    const user = await testDb.createUser({ role: 'partner' });
    const partner = await testDb.createPartner({ user_id: user.id, type: 'tow' });

    const vehicle = await services.vehicleRepository.insert({
      partner_id: partner.id,
      plate,
      make: 'Ford',
      model: 'F-4000',
      year: 2020,
      equipment_type: 'flatbed',
      supported_vehicle_classes: ['light_vehicle'],
      max_towed_weight_kg: 4000,
      active: true,
      pricing: { minimum_charge_cents: 15000, included_km: 10, price_per_additional_km_cents: 800 },
    });

    await services.documentRepository.insert({
      tow_vehicle_id: vehicle.id,
      partner_id: partner.id,
      document_type: 'vehicle_license',
      filename: 'stored-key',
      original_name: 'crlv.jpg',
      file_path: 'stored-key',
      file_url: 'stored-key',
      mime_type: 'image/jpeg',
      file_size: 1,
      status: 'approved',
    });

    return { partner, vehicle };
  }

  test('a tow partner with an active vehicle and approved document is eligible', async () => {
    await testDb.db('service_modules').insert({
      module_key: 'tow',
      service_key: 'tow',
      partner_type: 'tow',
      enabled: 1,
    });

    const { partner } = await seedTowPartnerWithVehicle('ELIG123');
    await expect(services.eligibilityService.evaluate({ partnerId: partner.id, requested }))
      .resolves.toMatchObject({ eligible: true, code: null });
  });

  test('mutating the partner type tow -> non-tow revokes eligibility without touching the vehicle', async () => {
    await testDb.db('service_modules').del();
    await testDb.db('service_modules').insert({
      module_key: 'tow',
      service_key: 'tow',
      partner_type: 'tow',
      enabled: 1,
    });

    const { partner, vehicle } = await seedTowPartnerWithVehicle('ELIG456');

    await expect(services.eligibilityService.evaluate({ partnerId: partner.id, requested }))
      .resolves.toMatchObject({ eligible: true });

    const before = await services.vehicleRepository.findById(vehicle.id);
    await testDb.db('partners').where({ id: partner.id }).update({ type: 'mechanic' });

    await expect(services.eligibilityService.evaluate({ partnerId: partner.id, requested }))
      .resolves.toMatchObject({ eligible: false, code: 'partner_not_operational' });

    const after = await services.vehicleRepository.findById(vehicle.id);
    expect(after).toEqual(before);
    expect(after.active).toBe(true);
  });
});
