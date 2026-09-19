/**
 * MVP-01 — Tow domain barrel.
 *
 * Pure domain: identity, errors, vocabularies, policies and invariants. No
 * Express, Knex, filesystem or provider import is allowed in this directory
 * (enforced by `tests/tow/mvp01/towArchitectureBoundary.test.js`).
 */
'use strict';

const identity = require('./identity');
const errors = require('./errors');
const vehicleClasses = require('./vehicle-classes');
const pricing = require('./pricing');
const towVehicle = require('./tow-vehicle');
const documents = require('./documents');
const availability = require('./availability');
const compatibility = require('./compatibility');
const eligibility = require('./eligibility');
const settings = require('./settings');

module.exports = {
  ...identity,
  ...errors,
  ...vehicleClasses,
  ...pricing,
  ...towVehicle,
  ...documents,
  ...availability,
  ...compatibility,
  ...eligibility,
  ...settings,
};
