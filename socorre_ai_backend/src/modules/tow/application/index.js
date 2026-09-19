/**
 * MVP-01 — application barrel.
 */
'use strict';

const { createModuleService } = require('./module-service');
const { createVehicleService } = require('./vehicle-service');
const { createDocumentService } = require('./document-service');
const { createSettingsService } = require('./settings-service');
const { createEligibilityService } = require('./eligibility-service');

module.exports = {
  createModuleService,
  createVehicleService,
  createDocumentService,
  createSettingsService,
  createEligibilityService,
};
