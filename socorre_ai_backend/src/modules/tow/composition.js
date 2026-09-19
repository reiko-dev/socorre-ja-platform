/**
 * MVP-01 — module composition root.
 *
 * Builds the application services from the infrastructure adapters. This is the
 * only place the pure layers meet Knex, the filesystem and the system clock,
 * which keeps Domain/Application free of infrastructure imports.
 */
'use strict';

const {
  createModuleService,
  createVehicleService,
  createDocumentService,
  createSettingsService,
  createEligibilityService,
} = require('./application');
const { createModuleRepository } = require('./adapters/persistence/module-repository');
const { createVehicleRepository } = require('./adapters/persistence/vehicle-repository');
const { createDocumentRepository } = require('./adapters/persistence/document-repository');
const { createSettingsRepository } = require('./adapters/persistence/settings-repository');
const { createPartnerRepository } = require('./adapters/persistence/partner-repository');
const { createLocalFileStorage } = require('./adapters/storage/local-file-storage');
const { createSystemClock } = require('./adapters/clock/system-clock');

function buildTowServices(options = {}) {
  // eslint-disable-next-line global-require
  const db = options.db || require('../../config/database');
  const clock = options.clock || createSystemClock();
  const storage = options.storage || createLocalFileStorage();

  const moduleRepository = createModuleRepository(db);
  const vehicleRepository = createVehicleRepository(db);
  const documentRepository = createDocumentRepository(db);
  const settingsRepository = createSettingsRepository(db);
  const partnerRepository = createPartnerRepository(db);

  return {
    db,
    clock,
    storage,
    moduleRepository,
    vehicleRepository,
    documentRepository,
    settingsRepository,
    partnerRepository,
    moduleService: createModuleService({ moduleRepository }),
    vehicleService: createVehicleService({ vehicleRepository, documentRepository, clock }),
    documentService: createDocumentService({ documentRepository, vehicleRepository, storage, clock }),
    settingsService: createSettingsService({ settingsRepository, clock }),
    eligibilityService: createEligibilityService({
      moduleRepository,
      vehicleRepository,
      documentRepository,
      partnerRepository,
      clock,
    }),
  };
}

module.exports = { buildTowServices };
