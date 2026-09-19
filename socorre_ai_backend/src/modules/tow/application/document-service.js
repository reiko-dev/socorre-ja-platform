/**
 * MVP-01 — TowVehicle document application service.
 *
 * Upload persists bytes through the FileStorage port and records only metadata;
 * approval/rejection is admin-only and drives operational eligibility through
 * the domain document policy.
 */
'use strict';

const {
  TowError,
  validationError,
  ALLOWED_DOCUMENT_TYPES,
  DOCUMENT_STATUSES,
} = require('../domain');

const ALLOWED_MIME_TYPES = Object.freeze(['image/jpeg', 'image/jpg', 'image/png', 'application/pdf']);
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Normalize the optional `expires_at` before persistence:
 *   - `undefined`/`null`/`''` => no expiry (`null`);
 *   - anything else must parse to a valid date, otherwise it is rejected as a
 *     `validation_error` (422) so garbage is never stored and the domain never
 *     has to guess.
 */
function normalizeExpiresAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const acceptableType = value instanceof Date
    || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
  const epoch = acceptableType
    ? (value instanceof Date ? value.getTime() : new Date(value).getTime())
    : NaN;
  if (!Number.isFinite(epoch)) {
    throw validationError('expires_at must be a valid date', { field: 'expires_at' });
  }
  return value instanceof Date ? value : new Date(epoch);
}

function createDocumentService({ documentRepository, vehicleRepository, storage, clock }) {
  if (!documentRepository) throw new TypeError('createDocumentService requires a documentRepository port');
  if (!vehicleRepository) throw new TypeError('createDocumentService requires a vehicleRepository port');
  if (!storage) throw new TypeError('createDocumentService requires a storage port');
  if (!clock) throw new TypeError('createDocumentService requires a clock port');

  async function requireOwnedVehicle(partnerId, vehicleId) {
    const vehicle = await vehicleRepository.findByPartnerAndId(partnerId, vehicleId);
    if (!vehicle) throw new TowError('not_found', 'TowVehicle not found');
    return vehicle;
  }

  async function requireDocument(documentId) {
    const document = await documentRepository.findById(documentId);
    if (!document) throw new TowError('not_found', 'TowVehicle document not found');
    return document;
  }

  async function upload({ partnerId, vehicleId, file, documentType, expiresAt = null }) {
    await requireOwnedVehicle(partnerId, vehicleId);
    if (!ALLOWED_DOCUMENT_TYPES.includes(documentType)) {
      throw validationError(`unsupported document_type "${documentType}"`, { field: 'document_type' });
    }
    if (!file || !file.buffer) {
      throw validationError('file is required', { field: 'file' });
    }
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw validationError('file must be JPEG, PNG or PDF', { field: 'file' });
    }
    if (Number.isFinite(file.size) && file.size > MAX_FILE_SIZE_BYTES) {
      throw validationError('file must be at most 5MB', { field: 'file' });
    }
    const normalizedExpiresAt = normalizeExpiresAt(expiresAt);

    const saved = await storage.save({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      keyPrefix: `tow-vehicles/${vehicleId}`,
    });

    // `file_url` is persisted as the internal storage key; the public DTO
    // computes the authenticated download path per response context. It is
    // never a public `/uploads/...` URL or an absolute filesystem path.
    return documentRepository.insert({
      tow_vehicle_id: vehicleId,
      partner_id: partnerId,
      document_type: documentType,
      filename: saved.key,
      original_name: file.originalname,
      file_path: saved.key,
      file_url: saved.key,
      mime_type: file.mimetype,
      file_size: file.size,
      status: 'pending',
      expires_at: normalizedExpiresAt,
    });
  }

  async function listForVehicle({ partnerId, vehicleId }) {
    await requireOwnedVehicle(partnerId, vehicleId);
    return documentRepository.listByVehicle(vehicleId);
  }

  async function remove({ partnerId, vehicleId, documentId }) {
    await requireOwnedVehicle(partnerId, vehicleId);
    const document = await requireDocument(documentId);
    if (String(document.tow_vehicle_id) !== String(vehicleId)) {
      throw new TowError('not_found', 'TowVehicle document not found');
    }
    await documentRepository.remove(document.id);
    // Best-effort orphan cleanup AFTER the row is gone: a storage failure must
    // never fail the delete, and the stored path is never logged or exposed
    // outside the storage port.
    try {
      await storage.remove(document.file_path);
    } catch (error) {
      /* best effort: the metadata row is already deleted */
    }
    return { id: document.id, deleted: true };
  }

  async function listAll(filters = {}) {
    return documentRepository.list(filters);
  }

  async function getById(documentId) {
    return requireDocument(documentId);
  }

  /**
   * Read the private bytes for an already-resolved document through the
   * FileStorage port. A missing object is a `not_found`, never an internal
   * error and never a filesystem path leak.
   */
  async function readBytes(document) {
    let buffer;
    try {
      buffer = await storage.read(document.file_path);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new TowError('not_found', 'TowVehicle document not found');
      }
      throw error;
    }
    return {
      buffer,
      mimeType: document.mime_type || 'application/octet-stream',
      filename: document.original_name || 'document',
      document,
    };
  }

  async function readForAdmin({ documentId }) {
    const document = await requireDocument(documentId);
    return readBytes(document);
  }

  async function readForVehicle({ partnerId, vehicleId, documentId }) {
    await requireOwnedVehicle(partnerId, vehicleId);
    const document = await requireDocument(documentId);
    if (String(document.tow_vehicle_id) !== String(vehicleId)) {
      throw new TowError('not_found', 'TowVehicle document not found');
    }
    return readBytes(document);
  }

  async function approve({ documentId, adminUserId = null }) {
    const document = await requireDocument(documentId);
    if (document.status === 'approved') return document; // idempotent
    return documentRepository.updateStatus(document.id, {
      status: 'approved',
      rejection_reason: null,
      verified_by: adminUserId,
      verified_at: clock.now(),
    });
  }

  async function reject({ documentId, reason, adminUserId = null }) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw validationError('reason is required', { field: 'reason' });
    }
    const document = await requireDocument(documentId);
    return documentRepository.updateStatus(document.id, {
      status: 'rejected',
      rejection_reason: reason.trim(),
      verified_by: adminUserId,
      verified_at: clock.now(),
    });
  }

  return {
    upload,
    listForVehicle,
    remove,
    listAll,
    getById,
    readForAdmin,
    readForVehicle,
    approve,
    reject,
    DOCUMENT_STATUSES,
  };
}

module.exports = { createDocumentService, ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES };
