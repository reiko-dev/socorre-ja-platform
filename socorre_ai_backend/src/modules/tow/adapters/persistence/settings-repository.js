/**
 * MVP-01 — persistence adapter for the Tow settings keys.
 *
 * Reuses the shared `system_settings` table; it does not create a parallel
 * settings store.
 */
'use strict';

function createSettingsRepository(db) {
  if (!db) throw new TypeError('createSettingsRepository requires a knex instance');

  async function getByKeys(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return [];
    return db('system_settings').whereIn('setting_key', keys).orderBy('setting_key');
  }

  /**
   * All-or-nothing patch: every key is upserted inside one transaction, so a
   * failure mid-loop rolls the whole patch back instead of leaving a partially
   * applied settings set.
   */
  async function upsertMany(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    return db.transaction(async (trx) => {
      let written = 0;
      for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop
        const existing = await trx('system_settings').where({ setting_key: row.setting_key }).first();
        if (existing) {
          // eslint-disable-next-line no-await-in-loop
          await trx('system_settings').where({ setting_key: row.setting_key }).update(row);
        } else {
          // eslint-disable-next-line no-await-in-loop
          await trx('system_settings').insert(row);
        }
        written += 1;
      }
      return written;
    });
  }

  return { getByKeys, upsertMany };
}

module.exports = { createSettingsRepository };
