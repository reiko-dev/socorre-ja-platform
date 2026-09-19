/**
 * MVP-01 — typed Tow settings controller (thin).
 */
'use strict';

const { handle } = require('./error-mapper');

function createSettingsController({ settingsService }) {
  return {
    get: handle(async (req, res) => {
      res.json({ success: true, data: await settingsService.get() });
    }),

    patch: handle(async (req, res) => {
      const settings = await settingsService.patch(req.body || {}, {
        adminUserId: req.user ? req.user.id : null,
      });
      res.json({ success: true, data: settings });
    }),
  };
}

module.exports = { createSettingsController };
