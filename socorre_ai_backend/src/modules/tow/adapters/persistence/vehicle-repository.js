/**
 * MVP-01 — persistence adapter for TowVehicles (Knex).
 *
 * Owns the transactional activation that, together with the PostgreSQL partial
 * unique index, guarantees at most one active TowVehicle per partner.
 */
'use strict';

const { TowError } = require('../../domain');

function parseClasses(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }
  return [];
}

function toDbClasses(value) {
  // Always send JSON text: node-postgres would otherwise serialize a JS array
  // as a PostgreSQL array literal, which is not valid jsonb.
  return JSON.stringify(value);
}

function mapVehicleRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    partner_id: row.partner_id,
    plate: row.plate,
    make: row.make,
    model: row.model,
    year: Number(row.year),
    equipment_type: row.equipment_type,
    supported_vehicle_classes: parseClasses(row.supported_vehicle_classes),
    max_towed_weight_kg: Number(row.max_towed_weight_kg),
    active: row.active === true || row.active === 1 || row.active === 't',
    pricing: {
      minimum_charge_cents: Number(row.minimum_charge_cents),
      included_km: Number(row.included_km),
      price_per_additional_km_cents: Number(row.price_per_additional_km_cents),
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function isUniqueViolation(error) {
  return Boolean(error) && (
    error.code === '23505'
    || /unique constraint|duplicate key|SQLITE_CONSTRAINT/i.test(error.message || '')
  );
}

function toColumns(record) {
  const columns = {};
  if (record.partner_id !== undefined) columns.partner_id = record.partner_id;
  if (record.plate !== undefined) columns.plate = record.plate;
  if (record.make !== undefined) columns.make = record.make;
  if (record.model !== undefined) columns.model = record.model;
  if (record.year !== undefined) columns.year = record.year;
  if (record.equipment_type !== undefined) columns.equipment_type = record.equipment_type;
  if (record.supported_vehicle_classes !== undefined) {
    columns.supported_vehicle_classes = toDbClasses(record.supported_vehicle_classes);
  }
  if (record.max_towed_weight_kg !== undefined) columns.max_towed_weight_kg = record.max_towed_weight_kg;
  if (record.active !== undefined) columns.active = record.active;
  if (record.pricing !== undefined) {
    columns.minimum_charge_cents = record.pricing.minimum_charge_cents;
    columns.included_km = record.pricing.included_km;
    columns.price_per_additional_km_cents = record.pricing.price_per_additional_km_cents;
  }
  return columns;
}

function createVehicleRepository(db) {
  if (!db) throw new TypeError('createVehicleRepository requires a knex instance');

  async function findById(id) {
    return mapVehicleRow(await db('tow_vehicles').where({ id }).first());
  }

  async function findByPartnerAndId(partnerId, id) {
    return mapVehicleRow(await db('tow_vehicles').where({ partner_id: partnerId, id }).first());
  }

  async function listByPartner(partnerId) {
    const rows = await db('tow_vehicles').where({ partner_id: partnerId }).orderBy('id');
    return rows.map(mapVehicleRow);
  }

  async function findActiveByPartner(partnerId) {
    return mapVehicleRow(await db('tow_vehicles').where({ partner_id: partnerId, active: true }).first());
  }

  async function insert(record) {
    try {
      const [created] = await db('tow_vehicles').insert(toColumns(record)).returning('*');
      return mapVehicleRow(created);
    } catch (error) {
      // Client-caused duplicates (`(partner_id, plate)` or the partial active
      // unique) are a contract conflict, never an internal error.
      if (isUniqueViolation(error)) {
        throw new TowError('conflict', 'a TowVehicle with this plate already exists for this partner');
      }
      throw error;
    }
  }

  async function update(id, patch) {
    const columns = toColumns(patch);
    try {
      if (Object.keys(columns).length > 0) {
        await db('tow_vehicles').where({ id }).update({ ...columns, updated_at: db.fn.now() });
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new TowError('conflict', 'a TowVehicle with this plate already exists for this partner');
      }
      throw error;
    }
    return findById(id);
  }

  async function activate({ partnerId, vehicleId }) {
    return db.transaction(async (trx) => {
      await trx('tow_vehicles')
        .where({ partner_id: partnerId })
        .whereNot({ id: vehicleId })
        .update({ active: false, updated_at: trx.fn.now() });
      try {
        await trx('tow_vehicles')
          .where({ partner_id: partnerId, id: vehicleId })
          .update({ active: true, updated_at: trx.fn.now() });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TowError('conflict', 'another TowVehicle is already active for this partner');
        }
        throw error;
      }
      const row = await trx('tow_vehicles').where({ id: vehicleId }).first();
      return mapVehicleRow(row);
    });
  }

  async function deactivate({ partnerId, vehicleId }) {
    await db('tow_vehicles')
      .where({ partner_id: partnerId, id: vehicleId })
      .update({ active: false, updated_at: db.fn.now() });
    return findById(vehicleId);
  }

  async function remove(id) {
    return db('tow_vehicles').where({ id }).del();
  }

  return {
    insert,
    findById,
    findByPartnerAndId,
    listByPartner,
    findActiveByPartner,
    update,
    activate,
    deactivate,
    remove,
  };
}

module.exports = { createVehicleRepository, mapVehicleRow, isUniqueViolation };
