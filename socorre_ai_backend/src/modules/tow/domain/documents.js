/**
 * MVP-01 — TowVehicle document policy.
 *
 * Canonical statuses, required document types and the validity rule used by
 * operational eligibility. A document is valid only when approved AND not past
 * its `expires_at`; an expired approval is treated as `expired`.
 */
'use strict';

const DOCUMENT_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'expired']);

const ALLOWED_DOCUMENT_TYPES = Object.freeze([
  'vehicle_license',
  'tow_authorization',
  'other_supported_type',
]);

/** At minimum the vehicle license (CRLV) must be approved and valid. */
const REQUIRED_DOCUMENT_TYPES = Object.freeze(['vehicle_license']);

/**
 * Pure expiry normalization:
 *   - `null`/`undefined`/`''` mean "no expiry" and return `null`;
 *   - an unparseable non-empty value returns `NaN`, which the policy below
 *     treats as NOT valid (never as "never-expiring"). Silently treating a
 *     malformed date as no expiry would keep a bad document eligible forever.
 */
function toEpoch(value) {
  if (value === null || value === undefined || value === '') return null;
  const epoch = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(epoch) ? epoch : NaN;
}

function referenceEpoch(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  return Date.now();
}

/** The status a document presents for eligibility at `now`. */
function effectiveDocumentStatus(document, now) {
  if (!document) return null;
  if (document.status === 'approved') {
    const expires = toEpoch(document.expires_at);
    if (expires === null) return document.status;
    // A non-empty but unparseable `expires_at` (NaN) is an invalid document,
    // not a never-expiring one.
    if (!Number.isFinite(expires)) return 'expired';
    if (expires <= referenceEpoch(now)) return 'expired';
  }
  return document.status;
}

function isDocumentValid(document, now) {
  return effectiveDocumentStatus(document, now) === 'approved';
}

function areRequiredDocumentsSatisfied(documents, now) {
  const list = Array.isArray(documents) ? documents : [];
  return REQUIRED_DOCUMENT_TYPES.every((type) => list.some(
    (document) => document.document_type === type && isDocumentValid(document, now)
  ));
}

function summarizeDocumentStatus(documents, now) {
  const list = Array.isArray(documents) ? documents : [];
  if (areRequiredDocumentsSatisfied(list, now)) return 'approved';

  const required = list.filter((document) => REQUIRED_DOCUMENT_TYPES.includes(document.document_type));
  if (required.length === 0) return 'pending';

  const statuses = required.map((document) => effectiveDocumentStatus(document, now));
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('expired')) return 'expired';
  if (statuses.includes('rejected')) return 'rejected';
  return 'pending';
}

module.exports = {
  DOCUMENT_STATUSES,
  ALLOWED_DOCUMENT_TYPES,
  REQUIRED_DOCUMENT_TYPES,
  effectiveDocumentStatus,
  isDocumentValid,
  areRequiredDocumentsSatisfied,
  summarizeDocumentStatus,
};
