/**
 * MVP-01 — Tow module availability policy.
 *
 * The single domain decision "may new business start?" consumed by later MVP
 * deliveries. MVP semantics are exactly:
 *
 *   disabled = stop NEW business
 *            + preserve partner/vehicle/document administration
 *            + allow already-ASSIGNED work to drain
 *
 * Advanced SEARCHING/NEGOTIATING shutdown and disable-vs-assignment races are
 * Phase 2 (#33) and are deliberately not implemented here.
 */
'use strict';

const { TowError } = require('./errors');
const { MODULE_KEY } = require('./identity');

const GRACEFUL_DRAIN_CONTRACT = Object.freeze({
  blocksNewBusiness: true,
  preservesAdministration: true,
  drainsAssignedWork: true,
  closesUnassignedRequests: false,
  phase: 'MVP',
});

function isModuleEnabled(moduleStatus) {
  return Boolean(moduleStatus && moduleStatus.enabled === true);
}

function assertModuleEnabled(moduleStatus, message) {
  if (!isModuleEnabled(moduleStatus)) {
    throw new TowError('service_module_disabled', message || 'Tow module is disabled', {
      details: { module_key: MODULE_KEY },
    });
  }
  return true;
}

module.exports = {
  GRACEFUL_DRAIN_CONTRACT,
  isModuleEnabled,
  assertModuleEnabled,
};
