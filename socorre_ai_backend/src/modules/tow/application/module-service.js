/**
 * MVP-01 — Tow module application service.
 *
 * Owns the persisted module registry and the idempotent toggle. The domain's
 * availability policy remains the only decision "may new business start?".
 */
'use strict';

const {
  MODULE_KEY,
  SERVICE_KEY,
  PARTNER_TYPE,
  TowError,
  validationError,
  assertModuleEnabled,
  GRACEFUL_DRAIN_CONTRACT,
} = require('../domain');

function createModuleService({ moduleRepository }) {
  if (!moduleRepository) throw new TypeError('createModuleService requires a moduleRepository port');

  async function getStatus() {
    const existing = await moduleRepository.getByKey(MODULE_KEY);
    if (existing) return existing;
    return moduleRepository.createDefault({
      module_key: MODULE_KEY,
      service_key: SERVICE_KEY,
      partner_type: PARTNER_TYPE,
      enabled: true,
    });
  }

  async function setEnabled({ enabled, reason, adminUserId = null } = {}) {
    if (typeof enabled !== 'boolean') {
      throw validationError('enabled must be a boolean', { field: 'enabled' });
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw validationError('reason is required', { field: 'reason' });
    }

    const current = await getStatus();
    // Idempotent: a repeated toggle never rewrites metadata nor duplicates rows.
    if (current.enabled === enabled) return current;

    return moduleRepository.setEnabled({
      key: MODULE_KEY,
      enabled,
      reason: reason.trim(),
      updatedBy: adminUserId,
    });
  }

  async function assertNewBusinessAllowed() {
    const status = await getStatus();
    assertModuleEnabled(status);
    return status;
  }

  async function requireById(id) {
    const status = await getStatus();
    if (String(status.id) !== String(id)) throw new TowError('not_found', 'Tow module not found');
    return status;
  }

  return {
    getStatus,
    setEnabled,
    assertNewBusinessAllowed,
    requireById,
    gracefulDrainContract: () => GRACEFUL_DRAIN_CONTRACT,
  };
}

module.exports = { createModuleService };
