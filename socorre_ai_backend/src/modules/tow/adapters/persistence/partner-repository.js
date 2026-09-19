/**
 * MVP-01 EXT — persistence adapter for partner identity (Knex).
 *
 * Implements the `PartnerRepository` port with the minimal `{ id, type }`
 * projection so the application/domain can reason about partner identity
 * (EXT-MVP01-2) without depending on the legacy `Partner` model or on Knex.
 */
'use strict';

function createPartnerRepository(db) {
  if (!db) throw new TypeError('createPartnerRepository requires a knex instance');

  async function findById(id) {
    const row = await db('partners').select('id', 'type').where({ id }).first();
    if (!row) return null;
    return { id: row.id, type: row.type };
  }

  return { findById };
}

module.exports = { createPartnerRepository };
