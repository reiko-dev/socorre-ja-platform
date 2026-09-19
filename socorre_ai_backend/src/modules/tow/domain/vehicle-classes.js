/**
 * MVP-01 — canonical vehicle classes and tow equipment types.
 *
 * These vocabularies are domain constants; they are not read from the database
 * or from any provider.
 */
'use strict';

const VEHICLE_CLASSES = Object.freeze([
  'motorcycle',
  'light_vehicle',
  'medium_truck',
  'heavy_truck',
]);

const EQUIPMENT_TYPES = Object.freeze(['flatbed', 'wheel_lift', 'heavy_wrecker']);

/** For medium/heavy trucks the transported weight (PBT) is mandatory. */
const WEIGHT_REQUIRED_CLASSES = Object.freeze(['medium_truck', 'heavy_truck']);

function isVehicleClass(value) {
  return VEHICLE_CLASSES.includes(value);
}

function isEquipmentType(value) {
  return EQUIPMENT_TYPES.includes(value);
}

function requiresWeight(vehicleClass) {
  return WEIGHT_REQUIRED_CLASSES.includes(vehicleClass);
}

module.exports = {
  VEHICLE_CLASSES,
  EQUIPMENT_TYPES,
  WEIGHT_REQUIRED_CLASSES,
  isVehicleClass,
  isEquipmentType,
  requiresWeight,
};
