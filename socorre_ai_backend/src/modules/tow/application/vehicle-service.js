/**
 * MVP-01 — TowVehicle application service.
 *
 * Partner-owned vehicle lifecycle. The single-active invariant is enforced at
 * the database (partial unique index) and by the transactional repository
 * `activate`; this service only validates, checks ownership and composes the
 * derived document status.
 */
'use strict';

const {
  TowError,
  validateTowVehicleInput,
  validateTowVehiclePatch,
  summarizeDocumentStatus,
} = require('../domain');

function createVehicleService({ vehicleRepository, documentRepository, clock }) {
  if (!vehicleRepository) throw new TypeError('createVehicleService requires a vehicleRepository port');
  if (!documentRepository) throw new TypeError('createVehicleService requires a documentRepository port');
  if (!clock) throw new TypeError('createVehicleService requires a clock port');

  async function requireOwned(partnerId, vehicleId) {
    const vehicle = await vehicleRepository.findByPartnerAndId(partnerId, vehicleId);
    if (!vehicle) throw new TowError('not_found', 'TowVehicle not found');
    return vehicle;
  }

  async function withDocumentStatus(vehicle) {
    const documents = await documentRepository.listByVehicle(vehicle.id);
    return { ...vehicle, document_status: summarizeDocumentStatus(documents, clock.now()) };
  }

  async function create({ partnerId, input }) {
    const normalized = validateTowVehicleInput(input);
    return vehicleRepository.insert({
      partner_id: partnerId,
      ...normalized,
      active: false,
    });
  }

  async function list(partnerId) {
    const vehicles = await vehicleRepository.listByPartner(partnerId);
    const result = [];
    for (const vehicle of vehicles) {
      // eslint-disable-next-line no-await-in-loop
      result.push(await withDocumentStatus(vehicle));
    }
    return result;
  }

  async function get({ partnerId, vehicleId }) {
    return withDocumentStatus(await requireOwned(partnerId, vehicleId));
  }

  async function update({ partnerId, vehicleId, patch }) {
    const normalized = validateTowVehiclePatch(patch);
    const vehicle = await requireOwned(partnerId, vehicleId);
    return withDocumentStatus(await vehicleRepository.update(vehicle.id, normalized));
  }

  async function activate({ partnerId, vehicleId }) {
    const vehicle = await requireOwned(partnerId, vehicleId);
    const activated = await vehicleRepository.activate({ partnerId, vehicleId: vehicle.id });
    return withDocumentStatus(activated);
  }

  async function deactivate({ partnerId, vehicleId }) {
    const vehicle = await requireOwned(partnerId, vehicleId);
    const deactivated = await vehicleRepository.deactivate({ partnerId, vehicleId: vehicle.id });
    return withDocumentStatus(deactivated);
  }

  async function remove({ partnerId, vehicleId }) {
    const vehicle = await requireOwned(partnerId, vehicleId);
    await vehicleRepository.remove(vehicle.id);
    return { id: vehicle.id, deleted: true };
  }

  return { create, list, get, update, activate, deactivate, remove };
}

module.exports = { createVehicleService };
