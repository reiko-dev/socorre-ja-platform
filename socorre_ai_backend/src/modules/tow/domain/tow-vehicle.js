/**
 * MVP-01 — TowVehicle domain invariants.
 *
 * Pure validation/normalization. Persistence, ownership and the one-active
 * invariant are Application/Infrastructure concerns; this module only decides
 * whether an input describes a valid TowVehicle.
 */
'use strict';

const { validationError } = require('./errors');
const { isVehicleClass, isEquipmentType } = require('./vehicle-classes');
const { validatePricing } = require('./pricing');

function requireString(value, field, { max = 255 } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationError(`${field} is required`, { field });
  }
  if (value.length > max) {
    throw validationError(`${field} must be at most ${max} characters`, { field });
  }
  return value.trim();
}

function requireInteger(value, field, { min, max } = {}) {
  if (!Number.isInteger(value)) {
    throw validationError(`${field} must be an integer`, { field });
  }
  if (min !== undefined && value < min) {
    throw validationError(`${field} must be >= ${min}`, { field });
  }
  if (max !== undefined && value > max) {
    throw validationError(`${field} must be <= ${max}`, { field });
  }
  return value;
}

function validateSupportedClasses(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw validationError('supported_vehicle_classes must contain at least one class', {
      field: 'supported_vehicle_classes',
    });
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) {
    throw validationError('supported_vehicle_classes must not contain duplicates', {
      field: 'supported_vehicle_classes',
    });
  }
  for (const vehicleClass of unique) {
    if (!isVehicleClass(vehicleClass)) {
      throw validationError(`unsupported vehicle class "${vehicleClass}"`, {
        field: 'supported_vehicle_classes',
        value: vehicleClass,
      });
    }
  }
  return unique;
}

function validateTowVehicleInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw validationError('vehicle payload is required');
  }
  const equipmentType = input.equipment_type;
  if (!isEquipmentType(equipmentType)) {
    throw validationError(`unsupported equipment_type "${equipmentType}"`, { field: 'equipment_type' });
  }
  return {
    plate: requireString(input.plate, 'plate', { max: 20 }),
    make: requireString(input.make, 'make', { max: 100 }),
    model: requireString(input.model, 'model', { max: 100 }),
    year: requireInteger(input.year, 'year', { min: 1900, max: 2200 }),
    equipment_type: equipmentType,
    supported_vehicle_classes: validateSupportedClasses(input.supported_vehicle_classes),
    max_towed_weight_kg: requireInteger(input.max_towed_weight_kg, 'max_towed_weight_kg', { min: 1 }),
    pricing: validatePricing(input.pricing),
  };
}

/** Partial update: only the provided fields are validated/normalized. */
function validateTowVehiclePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw validationError('vehicle patch is required');
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw validationError('vehicle patch must change at least one field');
  }
  const normalized = {};
  if (patch.plate !== undefined) normalized.plate = requireString(patch.plate, 'plate', { max: 20 });
  if (patch.make !== undefined) normalized.make = requireString(patch.make, 'make', { max: 100 });
  if (patch.model !== undefined) normalized.model = requireString(patch.model, 'model', { max: 100 });
  if (patch.year !== undefined) normalized.year = requireInteger(patch.year, 'year', { min: 1900, max: 2200 });
  if (patch.equipment_type !== undefined) {
    if (!isEquipmentType(patch.equipment_type)) {
      throw validationError(`unsupported equipment_type "${patch.equipment_type}"`, { field: 'equipment_type' });
    }
    normalized.equipment_type = patch.equipment_type;
  }
  if (patch.supported_vehicle_classes !== undefined) {
    normalized.supported_vehicle_classes = validateSupportedClasses(patch.supported_vehicle_classes);
  }
  if (patch.max_towed_weight_kg !== undefined) {
    normalized.max_towed_weight_kg = requireInteger(patch.max_towed_weight_kg, 'max_towed_weight_kg', { min: 1 });
  }
  if (patch.pricing !== undefined) {
    normalized.pricing = validatePricing(patch.pricing);
  }
  return normalized;
}

module.exports = { validateTowVehicleInput, validateTowVehiclePatch, requireString, requireInteger };
