/**
 * MVP-01 — HTTP middleware helpers (thin).
 */
'use strict';

const { PARTNER_TYPE } = require('../domain');

function forbidden(res, message) {
  return res.status(403).json({ success: false, message, error: { code: 'forbidden' } });
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return forbidden(res, 'Acesso negado. Apenas administradores podem acessar esta rota.');
  }
  return next();
}

function requireTowPartner(req, res, next) {
  if (!req.user || req.user.role !== 'partner'
    || req.user.partner_type !== PARTNER_TYPE
    || req.user.partner_id === null || req.user.partner_id === undefined) {
    return forbidden(res, 'Acesso negado. Apenas parceiros do módulo Tow.');
  }
  return next();
}

module.exports = { requireAdmin, requireTowPartner };
