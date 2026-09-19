/**
 * MVP-01 — application ports.
 *
 * Interfaces only: the application layer depends on these shapes, never on
 * Express, Knex, the filesystem or a provider SDK. Adapters live under
 * `src/modules/tow/adapters/**` and are wired by `composition.js`.
 *
 * @typedef {Object} ModuleRepository
 * @property {(key: string) => Promise<object|null>} getByKey
 * @property {(row: object) => Promise<object>} createDefault
 * @property {(args: { key: string, enabled: boolean, reason: string, updatedBy: number|null }) => Promise<object>} setEnabled
 *
 * @typedef {Object} VehicleRepository
 * @property {(record: object) => Promise<object>} insert
 * @property {(id: number|string) => Promise<object|null>} findById
 * @property {(partnerId: number|string, id: number|string) => Promise<object|null>} findByPartnerAndId
 * @property {(partnerId: number|string) => Promise<object[]>} listByPartner
 * @property {(partnerId: number|string) => Promise<object|null>} findActiveByPartner
 * @property {(id: number|string, patch: object) => Promise<object>} update
 * @property {(args: { partnerId: number|string, vehicleId: number|string }) => Promise<object>} activate
 * @property {(args: { partnerId: number|string, vehicleId: number|string }) => Promise<object>} deactivate
 * @property {(id: number|string) => Promise<number>} remove
 *
 * @typedef {Object} DocumentRepository
 * @property {(record: object) => Promise<object>} insert
 * @property {(id: number|string) => Promise<object|null>} findById
 * @property {(vehicleId: number|string) => Promise<object[]>} listByVehicle
 * @property {(partnerId: number|string) => Promise<object[]>} listByPartner
 * @property {(id: number|string, patch: object) => Promise<object>} updateStatus
 * @property {(id: number|string) => Promise<number>} remove
 * @property {(filters: object) => Promise<object[]>} list
 *
 * @typedef {Object} SettingsRepository
 * @property {(keys: string[]) => Promise<object[]>} getByKeys
 * @property {(rows: object[]) => Promise<number>} upsertMany
 *
 * @typedef {Object} PartnerRepository
 * @property {(id: number|string) => Promise<{ id: number|string, type: string }|null>} findById
 *
 * @typedef {Object} FileStorage
 * @property {(file: { buffer: Buffer, originalName: string, mimeType: string, keyPrefix?: string }) => Promise<{ key: string }>} save
 * @property {(key: string) => Promise<Buffer>} read  Reads the private bytes; rejects with `ENOENT` when absent.
 * @property {(key: string) => Promise<void>} remove
 *
 * @typedef {Object} Clock
 * @property {() => Date} now
 */
'use strict';

const PORT_NAMES = Object.freeze([
  'ModuleRepository',
  'VehicleRepository',
  'DocumentRepository',
  'SettingsRepository',
  'PartnerRepository',
  'FileStorage',
  'Clock',
]);

module.exports = { PORT_NAMES };
