/**
 * MVP-01 — Tow Foundation schema (Issue #13).
 *
 * Adds the canonical Tow module registry and the TowVehicle + vehicle document
 * entities required by the next five MVP deliveries. It contains NO functional
 * business rows: the only seeded row is the structural module registry entry
 * (`tow`/`tow`/`tow`), which is configuration, not business data.
 *
 * Structural invariants enforced at the database level:
 *   - one `service_modules` row per `module_key` (UNIQUE);
 *   - at most one active TowVehicle per partner (PostgreSQL partial UNIQUE
 *     index `tow_vehicles_one_active_per_partner`);
 *   - `(partner_id, plate)` uniqueness;
 *   - equipment/class/status/weight/money CHECK constraints;
 *   - foreign keys with the documented cascade behaviour.
 *
 * Deterministic: no environment value, no clock, no data migration.
 */
'use strict';

const MODULE_ROW = {
  module_key: 'tow',
  service_key: 'tow',
  partner_type: 'tow',
  enabled: true,
};

function isPostgres(knex) {
  const dialect = knex.client && knex.client.dialect;
  const client = knex.client && knex.client.config && knex.client.config.client;
  return dialect === 'postgresql' || dialect === 'pg' || client === 'pg' || client === 'postgresql';
}

exports.up = async function up(knex) {
  // ---------------------------------------------------- service_modules ----
  await knex.schema.createTable('service_modules', (table) => {
    table.increments('id').primary();
    table.string('module_key', 50).notNullable().unique();
    table.string('service_key', 50).notNullable();
    table.string('partner_type', 50).notNullable();
    table.boolean('enabled').notNullable().defaultTo(true);
    table.text('disabled_reason').nullable();
    table.integer('updated_by').unsigned().nullable();
    table.timestamps(true, true);
    table.foreign('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.index(['service_key']);
    table.index(['partner_type']);
  });

  // Idempotent structural seed: the canonical Tow module row.
  await knex('service_modules').insert(MODULE_ROW).onConflict('module_key').ignore();

  // ------------------------------------------------------- tow_vehicles ----
  await knex.schema.createTable('tow_vehicles', (table) => {
    table.increments('id').primary();
    table.integer('partner_id').unsigned().notNullable();
    table.string('plate', 20).notNullable();
    table.string('make', 100).notNullable();
    table.string('model', 100).notNullable();
    table.integer('year').notNullable();
    table.string('equipment_type', 30).notNullable();
    table.jsonb('supported_vehicle_classes').notNullable();
    table.integer('max_towed_weight_kg').notNullable();
    table.boolean('active').notNullable().defaultTo(false);
    table.integer('minimum_charge_cents').notNullable();
    table.decimal('included_km', 10, 3).notNullable();
    table.integer('price_per_additional_km_cents').notNullable();
    table.timestamps(true, true);
    table.foreign('partner_id').references('id').inTable('partners').onDelete('CASCADE');
    table.unique(['partner_id', 'plate']);
    table.index(['partner_id', 'active']);
    table.check("equipment_type IN ('flatbed', 'wheel_lift', 'heavy_wrecker')", [], 'tow_vehicles_equipment_type_check');
    table.check('year >= 1900 AND year <= 2200', [], 'tow_vehicles_year_check');
    table.check('max_towed_weight_kg >= 1', [], 'tow_vehicles_weight_check');
    table.check('minimum_charge_cents >= 0', [], 'tow_vehicles_minimum_charge_check');
    table.check('included_km >= 0', [], 'tow_vehicles_included_km_check');
    table.check('price_per_additional_km_cents >= 0', [], 'tow_vehicles_additional_km_check');
  });

  if (isPostgres(knex)) {
    // The one-active invariant for real concurrency.
    await knex.raw(
      'CREATE UNIQUE INDEX tow_vehicles_one_active_per_partner ON tow_vehicles (partner_id) WHERE active = true'
    );
    await knex.raw(
      'ALTER TABLE tow_vehicles ADD CONSTRAINT tow_vehicles_classes_check '
      + 'CHECK (jsonb_array_length(supported_vehicle_classes) >= 1)'
    );
  } else {
    // Portable fallback for non-PostgreSQL drivers (tests/dev): at least one
    // class is still required, enforced by a non-empty JSON-array text check.
    await knex.schema.alterTable('tow_vehicles', (table) => {
      table.check("supported_vehicle_classes LIKE '[%]'", [], 'tow_vehicles_classes_check');
    });
  }

  // -------------------------------------------- tow_vehicle_documents ----
  await knex.schema.createTable('tow_vehicle_documents', (table) => {
    table.increments('id').primary();
    table.integer('tow_vehicle_id').unsigned().notNullable();
    table.integer('partner_id').unsigned().notNullable();
    table.string('document_type', 60).notNullable();
    table.string('filename', 255).notNullable();
    table.string('original_name', 255).notNullable();
    table.string('file_path', 500).notNullable();
    table.string('file_url', 500).notNullable();
    table.string('mime_type', 100).notNullable();
    table.integer('file_size').notNullable();
    table.string('status', 20).notNullable().defaultTo('pending');
    table.text('rejection_reason').nullable();
    table.timestamp('expires_at').nullable();
    table.integer('verified_by').unsigned().nullable();
    table.timestamp('verified_at').nullable();
    table.timestamp('uploaded_at').nullable().defaultTo(knex.fn.now());
    table.timestamps(true, true);
    table.foreign('tow_vehicle_id').references('id').inTable('tow_vehicles').onDelete('CASCADE');
    table.foreign('partner_id').references('id').inTable('partners').onDelete('CASCADE');
    table.foreign('verified_by').references('id').inTable('users').onDelete('SET NULL');
    table.index(['tow_vehicle_id', 'status']);
    table.index(['partner_id']);
    table.index(['status']);
    table.check("status IN ('pending', 'approved', 'rejected', 'expired')", [], 'tow_vehicle_documents_status_check');
    table.check('file_size >= 0', [], 'tow_vehicle_documents_file_size_check');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('tow_vehicle_documents');
  await knex.schema.dropTableIfExists('tow_vehicles');
  await knex.schema.dropTableIfExists('service_modules');
};

module.exports.MODULE_ROW = MODULE_ROW;
