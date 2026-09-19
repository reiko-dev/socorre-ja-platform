/**
 * MVP-01 — TowVehicle controller (thin).
 */
'use strict';

const { handle } = require('./error-mapper');
const { serializeVehicle } = require('./serialize');

function createVehicleController({ vehicleService }) {
  const partnerIdOf = (req) => req.user.partner_id;

  return {
    list: handle(async (req, res) => {
      const vehicles = await vehicleService.list(partnerIdOf(req));
      res.json({ success: true, data: { items: vehicles.map(serializeVehicle) } });
    }),

    create: handle(async (req, res) => {
      const vehicle = await vehicleService.create({ partnerId: partnerIdOf(req), input: req.body });
      res.status(201).json({ success: true, data: serializeVehicle(vehicle) });
    }),

    get: handle(async (req, res) => {
      const vehicle = await vehicleService.get({ partnerId: partnerIdOf(req), vehicleId: req.params.vehicleId });
      res.json({ success: true, data: serializeVehicle(vehicle) });
    }),

    update: handle(async (req, res) => {
      const vehicle = await vehicleService.update({
        partnerId: partnerIdOf(req),
        vehicleId: req.params.vehicleId,
        patch: req.body,
      });
      res.json({ success: true, data: serializeVehicle(vehicle) });
    }),

    activate: handle(async (req, res) => {
      const vehicle = await vehicleService.activate({ partnerId: partnerIdOf(req), vehicleId: req.params.vehicleId });
      res.json({ success: true, data: serializeVehicle(vehicle) });
    }),

    deactivate: handle(async (req, res) => {
      const vehicle = await vehicleService.deactivate({ partnerId: partnerIdOf(req), vehicleId: req.params.vehicleId });
      res.json({ success: true, data: serializeVehicle(vehicle) });
    }),

    remove: handle(async (req, res) => {
      const result = await vehicleService.remove({ partnerId: partnerIdOf(req), vehicleId: req.params.vehicleId });
      res.json({ success: true, data: result });
    }),
  };
}

module.exports = { createVehicleController };
