/**
 * MVP-01 — system clock adapter (the Clock port).
 */
'use strict';

function createSystemClock() {
  return { now: () => new Date() };
}

module.exports = { createSystemClock };
