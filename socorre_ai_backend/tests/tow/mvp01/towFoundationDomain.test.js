/**
 * MVP-01 — UNIT suite for the Tow domain (pure, no I/O).
 *
 * Covers the #13 required behaviors that live in the domain layer:
 *   - canonical module identity and the service_module_disabled policy;
 *   - graceful-drain contract exposed for later MVP deliveries;
 *   - typed/validated MVP settings (matching radius, proposal expiry);
 *   - TowVehicle invariants and canonical per-vehicle pricing (cents/meters);
 *   - vehicle document status/validity policy;
 *   - centralized compatibility policy (class + capacity);
 *   - operational eligibility composition
 *     (module + active vehicle + valid documents + compatibility).
 *
 * RED-first: this file is written before `src/modules/tow/domain` exists.
 */
'use strict';

const domain = require('../../../src/modules/tow/domain');

describe('MVP-01 UNIT — Tow domain', () => {
  describe('canonical module identity', () => {
    test('module_key, service_key and partner_type are all "tow"', () => {
      expect(domain.MODULE_KEY).toBe('tow');
      expect(domain.SERVICE_KEY).toBe('tow');
      expect(domain.PARTNER_TYPE).toBe('tow');
    });

    test('availability policy answers "new business allowed"', () => {
      expect(domain.isModuleEnabled({ enabled: true })).toBe(true);
      expect(domain.isModuleEnabled({ enabled: false })).toBe(false);
      expect(domain.isModuleEnabled(null)).toBe(false);
    });

    test('disabled module throws the canonical service_module_disabled error', () => {
      expect(() => domain.assertModuleEnabled({ enabled: false })).toThrow(domain.TowError);
      try {
        domain.assertModuleEnabled({ enabled: false });
        throw new Error('expected assertModuleEnabled to throw');
      } catch (error) {
        expect(error.code).toBe('service_module_disabled');
        expect(error.httpStatus).toBe(409);
        expect(domain.TOW_ERROR_CODES).toContain('service_module_disabled');
      }
    });

    test('graceful-drain contract matches the MVP semantics', () => {
      expect(domain.GRACEFUL_DRAIN_CONTRACT).toMatchObject({
        blocksNewBusiness: true,
        preservesAdministration: true,
        drainsAssignedWork: true,
        closesUnassignedRequests: false,
        phase: 'MVP',
      });
    });
  });

  describe('typed MVP settings', () => {
    test('defaults are complete and typed', () => {
      const defaults = domain.DEFAULT_TOW_SETTINGS;
      expect(defaults.tow_initial_radius_km).toBeGreaterThan(0);
      expect(defaults.tow_max_radius_km).toBeGreaterThanOrEqual(defaults.tow_initial_radius_km);
      expect(Number.isInteger(defaults.tow_proposal_expiry_minutes)).toBe(true);
    });

    test('a valid partial patch merges over the current settings', () => {
      const result = domain.validateSettingsPatch({ tow_proposal_expiry_minutes: 20 });
      expect(result.tow_proposal_expiry_minutes).toBe(20);
      expect(result.tow_initial_radius_km).toBe(domain.DEFAULT_TOW_SETTINGS.tow_initial_radius_km);
    });

    test('unknown keys, empty patches and wrong types are rejected as validation_error', () => {
      for (const patch of [
        {},
        { not_a_setting: 1 },
        { tow_initial_radius_km: '15' },
        { tow_proposal_expiry_minutes: 0 },
        { tow_max_radius_km: 0 },
        { tow_initial_radius_km: 101 },
      ]) {
        expect(() => domain.validateSettingsPatch(patch)).toThrow(domain.TowError);
        try {
          domain.validateSettingsPatch(patch);
        } catch (error) {
          expect(error.code).toBe('validation_error');
          expect(error.httpStatus).toBe(422);
        }
      }
    });

    test('cross-field invariant initial radius <= max radius is enforced', () => {
      expect(() => domain.validateSettingsPatch(
        { tow_initial_radius_km: 80 },
        { tow_max_radius_km: 50 }
      )).toThrow(/tow_initial_radius_km/);
    });
  });

  describe('TowVehicle invariants and canonical pricing', () => {
    const valid = () => ({
      plate: 'ABC1D23',
      make: 'Ford',
      model: 'F-4000',
      year: 2020,
      equipment_type: 'flatbed',
      supported_vehicle_classes: ['motorcycle', 'light_vehicle'],
      max_towed_weight_kg: 4000,
      pricing: { minimum_charge_cents: 15000, included_km: 10, price_per_additional_km_cents: 800 },
    });

    test('a valid input is normalized without inventing fields', () => {
      const normalized = domain.validateTowVehicleInput(valid());
      expect(normalized.pricing).toEqual({ minimum_charge_cents: 15000, included_km: 10, price_per_additional_km_cents: 800 });
      expect(normalized.supported_vehicle_classes).toEqual(['motorcycle', 'light_vehicle']);
    });

    test('rejects invalid class/equipment/weight/year/plate and empty or duplicate classes', () => {
      const mutations = [
        { supported_vehicle_classes: [] },
        { supported_vehicle_classes: ['light_vehicle', 'light_vehicle'] },
        { supported_vehicle_classes: ['spaceship'] },
        { equipment_type: 'teleporter' },
        { max_towed_weight_kg: 0 },
        { year: 1800 },
        { plate: '' },
      ];
      for (const mutation of mutations) {
        expect(() => domain.validateTowVehicleInput({ ...valid(), ...mutation })).toThrow(domain.TowError);
      }
    });

    test('pricing must be non-negative integer cents, never floats', () => {
      for (const pricing of [
        { minimum_charge_cents: -1, included_km: 1, price_per_additional_km_cents: 1 },
        { minimum_charge_cents: 15.5, included_km: 1, price_per_additional_km_cents: 1 },
        { minimum_charge_cents: 1, included_km: -1, price_per_additional_km_cents: 1 },
        { minimum_charge_cents: 1, included_km: 1, price_per_additional_km_cents: '2' },
        null,
      ]) {
        expect(() => domain.validatePricing(pricing)).toThrow(domain.TowError);
      }
    });
  });

  describe('document policy', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const approved = { document_type: 'vehicle_license', status: 'approved', expires_at: null };
    const expiring = { document_type: 'vehicle_license', status: 'approved', expires_at: '2026-05-31T00:00:00.000Z' };
    const future = { document_type: 'vehicle_license', status: 'approved', expires_at: '2026-12-31T00:00:00.000Z' };

    test('statuses are the canonical four', () => {
      expect(domain.DOCUMENT_STATUSES).toEqual(['pending', 'approved', 'rejected', 'expired']);
      expect(domain.REQUIRED_DOCUMENT_TYPES).toContain('vehicle_license');
    });

    test('approved and (not expired | future expiry) is valid; expired is not', () => {
      expect(domain.isDocumentValid(approved, now)).toBe(true);
      expect(domain.isDocumentValid(future, now)).toBe(true);
      expect(domain.isDocumentValid(expiring, now)).toBe(false);
      expect(domain.effectiveDocumentStatus(expiring, now)).toBe('expired');
    });

    test('empty expires_at means no expiry (still valid)', () => {
      expect(domain.isDocumentValid({ ...approved, expires_at: '' }, now)).toBe(true);
      expect(domain.isDocumentValid({ ...approved, expires_at: undefined }, now)).toBe(true);
    });

    test('a non-empty unparseable expires_at is never treated as never-expiring', () => {
      const invalid = { document_type: 'vehicle_license', status: 'approved', expires_at: 'garbage' };
      expect(domain.effectiveDocumentStatus(invalid, now)).toBe('expired');
      expect(domain.isDocumentValid(invalid, now)).toBe(false);
      expect(domain.areRequiredDocumentsSatisfied([invalid], now)).toBe(false);
      expect(domain.summarizeDocumentStatus([invalid], now)).toBe('expired');
    });

    test('pending/rejected never satisfy the requirement', () => {
      expect(domain.isDocumentValid({ document_type: 'vehicle_license', status: 'pending' }, now)).toBe(false);
      expect(domain.isDocumentValid({ document_type: 'vehicle_license', status: 'rejected' }, now)).toBe(false);
      expect(domain.areRequiredDocumentsSatisfied([{ document_type: 'vehicle_license', status: 'pending' }], now)).toBe(false);
    });

    test('at least one approved, valid required document satisfies the vehicle', () => {
      expect(domain.areRequiredDocumentsSatisfied([approved], now)).toBe(true);
      expect(domain.summarizeDocumentStatus([approved], now)).toBe('approved');
      expect(domain.summarizeDocumentStatus([], now)).toBe('pending');
      expect(domain.summarizeDocumentStatus([{ document_type: 'vehicle_license', status: 'rejected' }], now)).toBe('rejected');
      expect(domain.summarizeDocumentStatus([expiring], now)).toBe('expired');
    });
  });

  describe('centralized compatibility policy', () => {
    const vehicle = {
      active: true,
      supported_vehicle_classes: ['motorcycle', 'light_vehicle'],
      max_towed_weight_kg: 3000,
    };

    test('accepts a supported class within capacity', () => {
      expect(domain.isCompatible(vehicle, { class: 'light_vehicle', weight_kg: 1500 }).compatible).toBe(true);
      expect(domain.isCompatible(vehicle, { class: 'motorcycle' }).compatible).toBe(true);
    });

    test('rejects an unsupported class with vehicle_not_compatible', () => {
      const result = domain.isCompatible(vehicle, { class: 'heavy_truck', weight_kg: 9000 });
      expect(result.compatible).toBe(false);
      expect(result.code).toBe('vehicle_not_compatible');
    });

    test('rejects a supported class above the towed-weight capacity', () => {
      const result = domain.isCompatible({ ...vehicle, supported_vehicle_classes: ['light_vehicle'] }, { class: 'light_vehicle', weight_kg: 5000 });
      expect(result.compatible).toBe(false);
      expect(result.code).toBe('vehicle_not_compatible');
    });

    test('requires weight/PBT for medium_truck and heavy_truck', () => {
      const heavy = { active: true, supported_vehicle_classes: ['heavy_truck'], max_towed_weight_kg: 20000 };
      expect(domain.isCompatible(heavy, { class: 'heavy_truck' }).compatible).toBe(false);
      expect(domain.isCompatible(heavy, { class: 'heavy_truck', weight_kg: 12000 }).compatible).toBe(true);
    });
  });

  describe('operational eligibility composition', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const enabled = { enabled: true };
    const partner = { id: 1, type: 'tow' };
    const vehicle = { active: true, supported_vehicle_classes: ['light_vehicle'], max_towed_weight_kg: 3000 };
    const documents = [{ document_type: 'vehicle_license', status: 'approved', expires_at: null }];
    const requested = { class: 'light_vehicle', weight_kg: 1200 };

    test('all conditions satisfied => eligible', () => {
      const result = domain.evaluateEligibility({ partner, moduleStatus: enabled, vehicle, documents, requested, now });
      expect(result).toMatchObject({ eligible: true, code: null });
    });

    test('a non-tow partner is not eligible (partner_not_operational)', () => {
      const result = domain.evaluateEligibility({
        partner: { id: 1, type: 'mechanic' }, moduleStatus: enabled, vehicle, documents, requested, now,
      });
      expect(result).toMatchObject({ eligible: false, code: 'partner_not_operational' });
    });

    test('a missing partner is not eligible (partner_not_operational)', () => {
      const result = domain.evaluateEligibility({
        partner: null, moduleStatus: enabled, vehicle, documents, requested, now,
      });
      expect(result).toMatchObject({ eligible: false, code: 'partner_not_operational' });
    });

    test('a disabled module is reported even for a non-tow partner', () => {
      const result = domain.evaluateEligibility({
        partner: { id: 1, type: 'mechanic' },
        moduleStatus: { enabled: false },
        vehicle,
        documents,
        requested,
        now,
      });
      expect(result).toMatchObject({ eligible: false, code: 'service_module_disabled' });
    });

    test('disabled module short-circuits with service_module_disabled', () => {
      const result = domain.evaluateEligibility({ partner, moduleStatus: { enabled: false }, vehicle, documents, requested, now });
      expect(result).toMatchObject({ eligible: false, code: 'service_module_disabled' });
    });

    test('no active vehicle => vehicle_not_operational', () => {
      const result = domain.evaluateEligibility({ partner, moduleStatus: enabled, vehicle: { ...vehicle, active: false }, documents, requested, now });
      expect(result).toMatchObject({ eligible: false, code: 'vehicle_not_operational' });
    });

    test('missing required document => tow_document_required', () => {
      const result = domain.evaluateEligibility({ partner, moduleStatus: enabled, vehicle, documents: [], requested, now });
      expect(result).toMatchObject({ eligible: false, code: 'tow_document_required' });
    });

    test('pending/rejected/expired document => tow_document_not_approved', () => {
      for (const doc of [
        { document_type: 'vehicle_license', status: 'pending' },
        { document_type: 'vehicle_license', status: 'rejected' },
        { document_type: 'vehicle_license', status: 'approved', expires_at: '2026-01-01T00:00:00.000Z' },
      ]) {
        const result = domain.evaluateEligibility({ partner, moduleStatus: enabled, vehicle, documents: [doc], requested, now });
        expect(result.eligible).toBe(false);
        expect(result.code).toBe('tow_document_not_approved');
      }
    });

    test('incompatible vehicle => vehicle_not_compatible', () => {
      const result = domain.evaluateEligibility({ partner, moduleStatus: enabled, vehicle, documents, requested: { class: 'heavy_truck', weight_kg: 9000 }, now });
      expect(result).toMatchObject({ eligible: false, code: 'vehicle_not_compatible' });
    });
  });
});
