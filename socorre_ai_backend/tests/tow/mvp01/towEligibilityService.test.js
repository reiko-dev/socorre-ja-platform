/**
 * MVP-01 — UNIT suite for the application eligibility service.
 *
 * The composition of partner identity + module availability + active vehicle +
 * valid documents + compatibility is owned by the domain policy; this suite
 * proves the service wires the five sources (including the new `PartnerRepository`
 * port of EXT-MVP01-2) and surfaces the canonical error code.
 *
 * RED-first: written before `src/modules/tow/application` exists.
 */
'use strict';

const { createEligibilityService } = require('../../../src/modules/tow/application/eligibility-service');
const domain = require('../../../src/modules/tow/domain');

function fakeRepositories({
  module = { enabled: true },
  partner = { id: 1, type: 'tow' },
  vehicle = null,
  documents = [],
} = {}) {
  return {
    moduleRepository: { getByKey: async () => module },
    partnerRepository: { findById: jest.fn(async () => partner) },
    vehicleRepository: { findActiveByPartner: async () => vehicle },
    documentRepository: { listByVehicle: async () => documents },
    clock: { now: () => new Date('2026-06-01T00:00:00.000Z') },
  };
}

const requested = { class: 'light_vehicle', weight_kg: 1200 };
const vehicle = { active: true, supported_vehicle_classes: ['light_vehicle'], max_towed_weight_kg: 3000 };
const approvedDoc = { document_type: 'vehicle_license', status: 'approved', expires_at: null };

describe('MVP-01 UNIT — eligibility service', () => {
  test('eligible when partner is tow, module, active vehicle, approved document and compatibility hold', async () => {
    const service = createEligibilityService(fakeRepositories({ vehicle, documents: [approvedDoc] }));
    await expect(service.evaluate({ partnerId: 1, requested })).resolves.toMatchObject({ eligible: true, code: null });
  });

  test('loads the partner through the port and rejects a non-tow partner', async () => {
    const repositories = fakeRepositories({
      partner: { id: 7, type: 'mechanic' },
      vehicle,
      documents: [approvedDoc],
    });
    const service = createEligibilityService(repositories);

    await expect(service.evaluate({ partnerId: 7, requested })).resolves.toMatchObject({
      eligible: false,
      code: 'partner_not_operational',
    });
    expect(repositories.partnerRepository.findById).toHaveBeenCalledWith(7);
  });

  test('a missing partner is not eligible', async () => {
    const repositories = fakeRepositories({ partner: null, vehicle, documents: [approvedDoc] });
    const service = createEligibilityService(repositories);

    await expect(service.evaluate({ partnerId: 42, requested })).resolves.toMatchObject({
      eligible: false,
      code: 'partner_not_operational',
    });
  });

  test('a disabled module is reported before the partner type is considered', async () => {
    const repositories = fakeRepositories({
      module: { enabled: false },
      partner: { id: 1, type: 'mechanic' },
      vehicle,
      documents: [approvedDoc],
    });
    const service = createEligibilityService(repositories);

    await expect(service.evaluate({ partnerId: 1, requested })).resolves.toMatchObject({
      eligible: false,
      code: 'service_module_disabled',
    });
  });

  test('mutating partner type tow -> non-tow revokes eligibility immediately without touching the vehicle', async () => {
    let type = 'tow';
    const update = jest.fn();
    const remove = jest.fn();
    const repositories = {
      moduleRepository: { getByKey: async () => ({ enabled: true }) },
      partnerRepository: { findById: jest.fn(async () => ({ id: 1, type })) },
      vehicleRepository: { findActiveByPartner: async () => vehicle, update, remove },
      documentRepository: { listByVehicle: async () => [approvedDoc] },
      clock: { now: () => new Date('2026-06-01T00:00:00.000Z') },
    };
    const service = createEligibilityService(repositories);

    await expect(service.evaluate({ partnerId: 1, requested })).resolves.toMatchObject({ eligible: true });

    type = 'mechanic';
    await expect(service.evaluate({ partnerId: 1, requested })).resolves.toMatchObject({
      eligible: false,
      code: 'partner_not_operational',
    });
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test('disabled module throws service_module_disabled on assert', async () => {
    const service = createEligibilityService(fakeRepositories({ module: { enabled: false }, vehicle, documents: [approvedDoc] }));
    const result = await service.evaluate({ partnerId: 1, requested });
    expect(result).toMatchObject({ eligible: false, code: 'service_module_disabled' });
    await expect(service.assertEligible({ partnerId: 1, requested })).rejects.toBeInstanceOf(domain.TowError);
  });

  test('no active vehicle => vehicle_not_operational', async () => {
    const service = createEligibilityService(fakeRepositories({ documents: [approvedDoc] }));
    await expect(service.evaluate({ partnerId: 1, requested })).resolves.toMatchObject({
      eligible: false, code: 'vehicle_not_operational',
    });
  });

  test('pending document => tow_document_not_approved', async () => {
    const service = createEligibilityService(fakeRepositories({
      vehicle,
      documents: [{ document_type: 'vehicle_license', status: 'pending' }],
    }));
    await expect(service.evaluate({ partnerId: 1, requested })).resolves.toMatchObject({
      eligible: false, code: 'tow_document_not_approved',
    });
  });

  test('incompatible class => vehicle_not_compatible', async () => {
    const service = createEligibilityService(fakeRepositories({ vehicle, documents: [approvedDoc] }));
    await expect(service.evaluate({ partnerId: 1, requested: { class: 'heavy_truck', weight_kg: 9000 } }))
      .resolves.toMatchObject({ eligible: false, code: 'vehicle_not_compatible' });
  });
});
