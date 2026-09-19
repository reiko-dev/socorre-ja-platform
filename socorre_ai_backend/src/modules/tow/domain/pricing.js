/**
 * MVP-01 — TowVehicle pricing value object (canonical units).
 *
 * Money is always integer cents; distance configuration uses `included_km` as
 * a decimal configuration value, never binary floating point as a financial
 * source of truth. The pricing *formula* is owned by MVP-02 (TOW-PRICING-CONTRACT);
 * MVP-01 only persists and validates the canonical tariff shape.
 */
'use strict';

const { validationError } = require('./errors');

function validatePricing(pricing) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
    throw validationError('pricing is required');
  }

  const { minimum_charge_cents, included_km, price_per_additional_km_cents } = pricing;

  if (!Number.isInteger(minimum_charge_cents) || minimum_charge_cents < 0) {
    throw validationError('minimum_charge_cents must be a non-negative integer', {
      field: 'pricing.minimum_charge_cents',
    });
  }
  if (typeof included_km !== 'number' || !Number.isFinite(included_km) || included_km < 0) {
    throw validationError('included_km must be a non-negative number', {
      field: 'pricing.included_km',
    });
  }
  if (!Number.isInteger(price_per_additional_km_cents) || price_per_additional_km_cents < 0) {
    throw validationError('price_per_additional_km_cents must be a non-negative integer', {
      field: 'pricing.price_per_additional_km_cents',
    });
  }

  return { minimum_charge_cents, included_km, price_per_additional_km_cents };
}

module.exports = { validatePricing };
