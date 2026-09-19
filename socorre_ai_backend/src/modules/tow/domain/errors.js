/**
 * MVP-01 — Tow domain errors.
 *
 * A single error type carries the canonical `error.code` of the composed
 * contract and the HTTP status policy of `TOW-API-CONTRACT.md` §2.8. The HTTP
 * layer is the only place allowed to translate it into a response envelope.
 */
'use strict';

const { MODULE_KEY } = require('./identity');

const ERROR_STATUS = Object.freeze({
  service_module_disabled: 409,
  validation_error: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  partner_not_operational: 409,
  vehicle_not_operational: 409,
  tow_document_required: 409,
  tow_document_not_approved: 409,
  vehicle_not_compatible: 409,
});

const TOW_ERROR_CODES = Object.freeze(Object.keys(ERROR_STATUS));

class TowError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = 'TowError';
    this.code = code;
    this.httpStatus = options.httpStatus || ERROR_STATUS[code] || 500;
    if (options.details && typeof options.details === 'object') {
      this.details = options.details;
    }
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, TowError);
    }
  }
}

function isTowError(value) {
  return value instanceof TowError;
}

function validationError(message, details) {
  return new TowError('validation_error', message, { details });
}

module.exports = {
  ERROR_STATUS,
  TOW_ERROR_CODES,
  TowError,
  isTowError,
  validationError,
  MODULE_KEY,
};
