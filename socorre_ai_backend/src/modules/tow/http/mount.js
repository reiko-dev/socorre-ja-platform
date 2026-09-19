/**
 * MVP-01 — Tow module HTTP mount.
 */
'use strict';

const multer = require('multer');
const { buildTowServices } = require('../composition');
const { createTowRouter, createAdminTowRouter } = require('./routes');

function defaultUploadMiddleware() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
  }).single('file');
}

function createTowModule(options = {}) {
  const services = buildTowServices(options);
  const uploadMiddleware = options.uploadMiddleware || defaultUploadMiddleware();
  return {
    services,
    publicRouter: createTowRouter({ services, uploadMiddleware }),
    adminRouter: createAdminTowRouter({ services }),
  };
}

module.exports = { createTowModule };
