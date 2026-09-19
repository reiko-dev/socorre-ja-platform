/**
 * MVP-01 — typed Tow settings (MVP subset only).
 *
 * Only the settings the six MVP deliveries need are declared here:
 *   - the single configurable matching radius (MVP-03);
 *   - the proposal expiry (MVP-04).
 *
 * Per-vehicle pricing lives on the TowVehicle (not a global setting). Phase-2
 * financial/no-show/payout/counteroffer settings are intentionally absent and
 * owned by #33 and later MVP deliveries.
 */
'use strict';

const { validationError } = require('./errors');

const TOW_SETTING_DEFINITIONS = Object.freeze([
  Object.freeze({ key: 'tow_initial_radius_km', type: 'number', exclusiveMin: 0, max: 100, default: 15 }),
  Object.freeze({ key: 'tow_max_radius_km', type: 'number', exclusiveMin: 0, max: 100, default: 50 }),
  Object.freeze({ key: 'tow_proposal_expiry_minutes', type: 'integer', min: 1, max: 1440, default: 10 }),
]);

const SETTING_KEYS = Object.freeze(TOW_SETTING_DEFINITIONS.map((definition) => definition.key));

const DEFAULT_TOW_SETTINGS = Object.freeze(
  TOW_SETTING_DEFINITIONS.reduce((settings, definition) => {
    settings[definition.key] = definition.default;
    return settings;
  }, {})
);

function validateSettingValue(definition, value) {
  if (definition.type === 'integer') {
    if (!Number.isInteger(value)) {
      throw validationError(`${definition.key} must be an integer`, { field: definition.key });
    }
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw validationError(`${definition.key} must be a number`, { field: definition.key });
  }
  if (definition.min !== undefined && value < definition.min) {
    throw validationError(`${definition.key} must be >= ${definition.min}`, { field: definition.key });
  }
  if (definition.exclusiveMin !== undefined && value <= definition.exclusiveMin) {
    throw validationError(`${definition.key} must be > ${definition.exclusiveMin}`, { field: definition.key });
  }
  if (definition.max !== undefined && value > definition.max) {
    throw validationError(`${definition.key} must be <= ${definition.max}`, { field: definition.key });
  }
  return value;
}

/**
 * Validate a partial patch and merge it over `base`, enforcing cross-field
 * invariants on the resulting complete set.
 */
function validateSettingsPatch(patch, base = DEFAULT_TOW_SETTINGS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw validationError('settings patch must be an object');
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw validationError('settings patch must change at least one setting');
  }
  const unknown = keys.filter((key) => !SETTING_KEYS.includes(key));
  if (unknown.length > 0) {
    throw validationError(`unknown Tow setting(s): ${unknown.join(', ')}`, { fields: unknown });
  }

  const merged = { ...base };
  for (const definition of TOW_SETTING_DEFINITIONS) {
    if (Object.prototype.hasOwnProperty.call(patch, definition.key)) {
      merged[definition.key] = validateSettingValue(definition, patch[definition.key]);
    }
  }

  if (merged.tow_initial_radius_km > merged.tow_max_radius_km) {
    throw validationError('tow_initial_radius_km must be <= tow_max_radius_km', {
      field: 'tow_initial_radius_km',
    });
  }
  return merged;
}

module.exports = {
  TOW_SETTING_DEFINITIONS,
  SETTING_KEYS,
  DEFAULT_TOW_SETTINGS,
  validateSettingValue,
  validateSettingsPatch,
};
