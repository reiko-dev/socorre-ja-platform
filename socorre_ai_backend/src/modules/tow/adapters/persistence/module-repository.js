/**
 * MVP-01 — persistence adapter for the Tow module registry (Knex/PostgreSQL).
 */
'use strict';

function mapModuleRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    module_key: row.module_key,
    service_key: row.service_key,
    partner_type: row.partner_type,
    enabled: row.enabled === true || row.enabled === 1 || row.enabled === 't',
    disabled_reason: row.disabled_reason ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createModuleRepository(db) {
  if (!db) throw new TypeError('createModuleRepository requires a knex instance');

  async function getByKey(key) {
    return mapModuleRow(await db('service_modules').where({ module_key: key }).first());
  }

  async function createDefault(row) {
    try {
      const [created] = await db('service_modules')
        .insert({
          module_key: row.module_key,
          service_key: row.service_key,
          partner_type: row.partner_type,
          enabled: row.enabled !== false,
        })
        .returning('*');
      return mapModuleRow(created);
    } catch (error) {
      // Idempotent under a race: the unique module_key makes the loser re-read.
      const existing = await getByKey(row.module_key);
      if (existing) return existing;
      throw error;
    }
  }

  async function setEnabled({ key, enabled, reason, updatedBy = null }) {
    await db('service_modules')
      .where({ module_key: key })
      .update({
        enabled,
        disabled_reason: enabled ? null : reason,
        updated_by: updatedBy,
        updated_at: db.fn.now(),
      });
    return getByKey(key);
  }

  return { getByKey, createDefault, setEnabled };
}

module.exports = { createModuleRepository };
