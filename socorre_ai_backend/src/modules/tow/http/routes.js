/**
 * MVP-01 — Tow routers (thin controllers + authz middleware).
 *
 * Mounted by `src/app.js` at `/api/tow` (partner/customer) and
 * `/api/admin/tow` (admin), matching the contract `servers: [/api]` and the
 * T00 probe expectation of `/api/tow/*` / `/api/admin/tow/*`.
 */
'use strict';

const express = require('express');
const { auth } = require('../../../middleware/auth');
const { requireAdmin, requireTowPartner } = require('./middleware');
const { createModuleController } = require('./module-controller');
const { createVehicleController } = require('./vehicle-controller');
const { createDocumentController } = require('./document-controller');
const { createSettingsController } = require('./settings-controller');

function createTowRouter({ services, uploadMiddleware }) {
  const router = express.Router();
  const moduleController = createModuleController({ moduleService: services.moduleService });
  const vehicleController = createVehicleController({ vehicleService: services.vehicleService });
  const documentController = createDocumentController({ documentService: services.documentService });

  router.get('/module-status', moduleController.getPublicStatus);

  router.get('/vehicles', auth, requireTowPartner, vehicleController.list);
  router.post('/vehicles', auth, requireTowPartner, vehicleController.create);
  router.get('/vehicles/:vehicleId', auth, requireTowPartner, vehicleController.get);
  router.patch('/vehicles/:vehicleId', auth, requireTowPartner, vehicleController.update);
  router.delete('/vehicles/:vehicleId', auth, requireTowPartner, vehicleController.remove);
  router.post('/vehicles/:vehicleId/activate', auth, requireTowPartner, vehicleController.activate);
  router.post('/vehicles/:vehicleId/deactivate', auth, requireTowPartner, vehicleController.deactivate);

  router.get('/vehicles/:vehicleId/documents', auth, requireTowPartner, documentController.listForVehicle);
  router.post('/vehicles/:vehicleId/documents', auth, requireTowPartner, uploadMiddleware, documentController.upload);
  router.delete('/vehicles/:vehicleId/documents/:documentId', auth, requireTowPartner, documentController.remove);
  // Authenticated byte transport (EXT-MVP01-1). Documented as a candidate for a
  // future contract revision; the frozen OpenAPI is not silently changed.
  router.get('/vehicles/:vehicleId/documents/:documentId/download', auth, requireTowPartner, documentController.download);

  return router;
}

function createAdminTowRouter({ services }) {
  const router = express.Router();
  const moduleController = createModuleController({ moduleService: services.moduleService });
  const documentController = createDocumentController({ documentService: services.documentService });
  const settingsController = createSettingsController({ settingsService: services.settingsService });

  router.get('/module', auth, requireAdmin, moduleController.adminGet);
  router.patch('/module', auth, requireAdmin, moduleController.adminToggle);

  router.get('/settings', auth, requireAdmin, settingsController.get);
  router.patch('/settings', auth, requireAdmin, settingsController.patch);

  router.get('/vehicle-documents', auth, requireAdmin, documentController.adminList);
  router.get('/vehicle-documents/:documentId', auth, requireAdmin, documentController.adminGet);
  router.post('/vehicle-documents/:documentId/approve', auth, requireAdmin, documentController.adminApprove);
  router.post('/vehicle-documents/:documentId/reject', auth, requireAdmin, documentController.adminReject);
  // Authenticated byte transport (EXT-MVP01-1); candidate for a future contract
  // revision, not part of the frozen OpenAPI.
  router.get('/vehicle-documents/:documentId/download', auth, requireAdmin, documentController.adminDownload);

  return router;
}

module.exports = { createTowRouter, createAdminTowRouter };
