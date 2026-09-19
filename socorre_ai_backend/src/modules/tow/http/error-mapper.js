/**
 * MVP-01 — HTTP error mapping for the Tow module.
 *
 * The only place a domain error becomes an HTTP response. Uses the canonical
 * envelope `{success:false, message, error:{code, details?}}`.
 */
'use strict';

const { isTowError } = require('../domain');

function sendError(res, error) {
  if (isTowError(error)) {
    const body = {
      success: false,
      message: error.message,
      error: { code: error.code },
    };
    if (error.details) body.error.details = error.details;
    return res.status(error.httpStatus).json(body);
  }
  // Never leak SQL/constraint/stack details to the client.
  console.error('Tow module unexpected error:', error && error.message ? error.message : error);
  return res.status(500).json({
    success: false,
    message: 'Erro interno do servidor',
    error: { code: 'internal_error' },
  });
}

/** Wrap an async controller so a rejected promise is mapped, never unhandled. */
function handle(fn) {
  return (req, res, next) => {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === 'function') result.catch((error) => sendError(res, error));
    } catch (error) {
      sendError(res, error);
    }
  };
}

module.exports = { sendError, handle };
