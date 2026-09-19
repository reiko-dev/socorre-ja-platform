/**
 * MVP-01 — persistence adapter for TowVehicle documents (Knex).
 */
'use strict';

function mapDocumentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    vehicle_id: row.tow_vehicle_id,
    tow_vehicle_id: row.tow_vehicle_id,
    partner_id: row.partner_id,
    document_type: row.document_type,
    filename: row.filename,
    original_name: row.original_name,
    file_path: row.file_path,
    file_url: row.file_url || row.file_path,
    mime_type: row.mime_type,
    file_size: Number(row.file_size),
    status: row.status,
    rejection_reason: row.rejection_reason ?? null,
    expires_at: row.expires_at ?? null,
    verified_by: row.verified_by ?? null,
    verified_at: row.verified_at ?? null,
    uploaded_at: row.uploaded_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createDocumentRepository(db) {
  if (!db) throw new TypeError('createDocumentRepository requires a knex instance');

  async function findById(id) {
    return mapDocumentRow(await db('tow_vehicle_documents').where({ id }).first());
  }

  async function listByVehicle(vehicleId) {
    const rows = await db('tow_vehicle_documents').where({ tow_vehicle_id: vehicleId }).orderBy('id');
    return rows.map(mapDocumentRow);
  }

  async function listByPartner(partnerId) {
    const rows = await db('tow_vehicle_documents').where({ partner_id: partnerId }).orderBy('id');
    return rows.map(mapDocumentRow);
  }

  async function insert(record) {
    const [created] = await db('tow_vehicle_documents').insert({
      tow_vehicle_id: record.tow_vehicle_id,
      partner_id: record.partner_id,
      document_type: record.document_type,
      filename: record.filename,
      original_name: record.original_name,
      file_path: record.file_path,
      file_url: record.file_url,
      mime_type: record.mime_type,
      file_size: record.file_size,
      status: record.status || 'pending',
      expires_at: record.expires_at || null,
    }).returning('*');
    return mapDocumentRow(created);
  }

  async function updateStatus(id, patch) {
    const columns = {};
    if (patch.status !== undefined) columns.status = patch.status;
    if (patch.rejection_reason !== undefined) columns.rejection_reason = patch.rejection_reason;
    if (patch.verified_by !== undefined) columns.verified_by = patch.verified_by;
    if (patch.verified_at !== undefined) columns.verified_at = patch.verified_at;
    if (Object.keys(columns).length > 0) {
      await db('tow_vehicle_documents').where({ id }).update({ ...columns, updated_at: db.fn.now() });
    }
    return findById(id);
  }

  async function remove(id) {
    return db('tow_vehicle_documents').where({ id }).del();
  }

  async function list(filters = {}) {
    const query = db('tow_vehicle_documents');
    if (filters.status) query.where('status', filters.status);
    if (filters.partner_id) query.where('partner_id', filters.partner_id);
    if (filters.vehicle_id) query.where('tow_vehicle_id', filters.vehicle_id);
    if (Number.isInteger(filters.limit)) query.limit(filters.limit);
    if (Number.isInteger(filters.offset)) query.offset(filters.offset);
    const rows = await query.orderBy('id');
    return rows.map(mapDocumentRow);
  }

  return { insert, findById, listByVehicle, listByPartner, updateStatus, remove, list };
}

module.exports = { createDocumentRepository, mapDocumentRow };
