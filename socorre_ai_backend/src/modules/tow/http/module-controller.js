/**
 * MVP-01 — Tow module controller (thin).
 */
'use strict';

const { handle } = require('./error-mapper');
const { serializeModule, serializeAdminModule } = require('./serialize');

function createModuleController({ moduleService }) {
  return {
    getPublicStatus: handle(async (req, res) => {
      const status = await moduleService.getStatus();
      res.json({ success: true, data: serializeModule(status) });
    }),

    adminGet: handle(async (req, res) => {
      const status = await moduleService.getStatus();
      res.json({ success: true, data: serializeAdminModule(status) });
    }),

    adminToggle: handle(async (req, res) => {
      const { enabled, reason } = req.body || {};
      const status = await moduleService.setEnabled({
        enabled,
        reason,
        adminUserId: req.user ? req.user.id : null,
      });
      res.json({ success: true, data: serializeAdminModule(status) });
    }),
  };
}

module.exports = { createModuleController };
