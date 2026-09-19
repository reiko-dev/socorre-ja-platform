/**
 * MVP-01 — centralized class/capacity compatibility policy.
 *
 * Prevents an invalid TowVehicle from accepting a service. The rule is the
 * normative one from `TOW-SERVICE-SPECIFICATION.md` §6:
 *
 *   requested.class ∈ vehicle.supported_vehicle_classes
 *   AND requested.weight_kg <= vehicle.max_towed_weight_kg
 *   AND weight_kg is mandatory for medium_truck / heavy_truck
 *
 * Kept pure so matching (MVP-03) cannot re-implement it.
 */
'use strict';

const { isVehicleClass, requiresWeight } = require('./vehicle-classes');

function isFinitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isCompatible(vehicle, requested) {
  if (!vehicle || vehicle.active !== true) {
    return { compatible: false, code: 'vehicle_not_operational', reasons: ['vehicle_not_active'] };
  }

  const request = requested || {};
  const reasons = [];

  if (!isVehicleClass(request.class)) {
    reasons.push('invalid_requested_class');
  } else if (!Array.isArray(vehicle.supported_vehicle_classes)
    || !vehicle.supported_vehicle_classes.includes(request.class)) {
    reasons.push('class_not_supported');
  }

  if (requiresWeight(request.class) && !isFinitePositive(request.weight_kg)) {
    reasons.push('weight_required');
  }

  if (isFinitePositive(request.weight_kg)
    && Number.isFinite(vehicle.max_towed_weight_kg)
    && request.weight_kg > vehicle.max_towed_weight_kg) {
    reasons.push('weight_exceeds_capacity');
  }

  if (reasons.length > 0) {
    return { compatible: false, code: 'vehicle_not_compatible', reasons };
  }
  return { compatible: true, code: null, reasons: [] };
}

module.exports = { isCompatible };
