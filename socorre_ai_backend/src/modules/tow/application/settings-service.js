/**
 * MVP-01 — typed Tow settings application service.
 *
 * Reads the canonical keys from the settings repository and validates every
 * patch against the domain schema. Controllers never read a setting by loose
 * string key as a business rule.
 */
'use strict';

const {
  SETTING_KEYS,
  TOW_SETTING_DEFINITIONS,
  DEFAULT_TOW_SETTINGS,
  validateSettingsPatch,
} = require('../domain');

const DEFINITION_BY_KEY = Object.freeze(
  TOW_SETTING_DEFINITIONS.reduce((map, definition) => {
    map[definition.key] = definition;
    return map;
  }, {})
);

function parseStoredValue(definition, rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return definition.default;
  if (definition.type === 'integer') {
    const parsed = Number(rawValue);
    return Number.isInteger(parsed) ? parsed : definition.default;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : definition.default;
}

function createSettingsService({ settingsRepository, clock }) {
  if (!settingsRepository) throw new TypeError('createSettingsService requires a settingsRepository port');

  async function get() {
    const rows = await settingsRepository.getByKeys(SETTING_KEYS);
    const values = { ...DEFAULT_TOW_SETTINGS };
    for (const row of rows) {
      const definition = DEFINITION_BY_KEY[row.setting_key];
      if (definition) values[definition.key] = parseStoredValue(definition, row.setting_value);
    }
    return values;
  }

  async function patch(patch, { adminUserId = null } = {}) {
    const current = await get();
    const merged = validateSettingsPatch(patch, current);
    const changedKeys = SETTING_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
    if (changedKeys.length > 0) {
      await settingsRepository.upsertMany(changedKeys.map((key) => {
        return {
          setting_key: key,
          setting_value: String(merged[key]),
          data_type: 'number',
          category: 'guincho',
          is_public: false,
          is_editable: true,
          description: `Tow MVP setting: ${key}`,
          updated_by: adminUserId,
          updated_at: clock.now(),
        };
      }));
    }
    return merged;
  }

  return { get, patch, keys: () => [...SETTING_KEYS] };
}

module.exports = { createSettingsService };
