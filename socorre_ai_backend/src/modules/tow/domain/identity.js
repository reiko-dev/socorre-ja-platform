/**
 * MVP-01 — canonical Tow module identity.
 *
 * The three identifiers are the single source of truth for the module; no
 * other layer may hardcode the literal `'tow'` for module/service/partner
 * identity. UI labels are independent of these stable keys.
 */
'use strict';

const MODULE_KEY = 'tow';
const SERVICE_KEY = 'tow';
const PARTNER_TYPE = 'tow';

module.exports = { MODULE_KEY, SERVICE_KEY, PARTNER_TYPE };
