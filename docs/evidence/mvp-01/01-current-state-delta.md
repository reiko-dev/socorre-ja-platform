# MVP-01 — Current-State Delta (required first deliverable)

> Issue: #13 · Epic: #10 · Delivery: MVP-01 — Tow Foundation
> Branch: `feature/mvp-01-tow-foundation`
> Execution base: `c8e40d71dd23c32a76050c05518353b6d030753f`
> Contract baseline: PR #9 (`docs/tow/tow-api-contract.openapi.yaml`)
> Method: read the normative docs, then inspect every reusable/adjacent artifact
> against the real tree (no guessed paths). `file:line` is the evidence.

Legend: **REUSE** (correct as-is) · **ADAPT** (reusable with shape/extension
changes) · **REPLACE** (superseded; a new MVP-01 artifact owns it) · **MISSING**
(does not exist; MVP-01 must create it).

This document is the explicit gate that precedes code. MVP-01 deliberately
creates no parallel abstraction where a reusable one exists: the legacy
`emergency_requests`/`tow_proposals` flow and `partner_documents` are audited
below and are **not** extended by MVP-01 (they belong to MVP-03+).

---

## 1. Canonical Tow module identity

| Required MVP-01 capability | Existing implementation | Class |
| --- | --- | --- |
| `module_key=tow`, `service_key=tow`, `partner_type=tow` as a single canonical source | No module entity. The string `tow` is duplicated literally in `database/migrations/001_baseline_schema.js:249` (`partners.type` enum) and `:325` (`emergency_requests.status`), and in `src/models/EmergencyRequest.js` (request_type) | **MISSING** — MVP-01 creates `src/modules/tow/domain/identity.js` as the single source and a DB-constrained `service_modules` row |
| Persisted Tow module registry (`enabled`, `disabled_reason`, `updated_by`, `updated_at`) | No `service_modules`/`tow_module_state` table or model (`grep` → 0 hits) | **MISSING** — new table in migration `003` |
| Central availability policy/port (`ServiceModuleAvailability`) | No port/policy; no `service_module_disabled` anywhere | **MISSING** |
| Admin-only GET/PATCH module control | No route; `/api/admin/tow/module` not mounted (`src/app.js:122-148`) | **MISSING** |
| Idempotent toggle + minimal change metadata | No toggle anywhere | **MISSING** |
| Canonical error `service_module_disabled` | Correct code listed in contract (`tow-api-contract.base.openapi.yaml:1808`); zero implementation | **MISSING** |
| Graceful-drain contract (ASSIGNED+ drains; MVP does not certify Phase-2 races) | No module semantics; legacy `emergency_requests` has no ASSIGNED state (`001:325`) | **MISSING** — MVP-01 exposes the policy contract only |

## 2. Typed/validated MVP Tow settings

| Required MVP-01 capability | Existing implementation | Class |
| --- | --- | --- |
| Typed settings store | `system_settings` key/value table (`001_baseline_schema.js:892-913`) + `SystemSettings` model (`src/models/SystemSettings.js:1-385`) + `/api/system-settings` router (`src/routes/systemSettings.js:1-84`) | **ADAPT** — reuse the store; MVP-01 adds a typed Tow settings schema/port and a canonical value set |
| Admin GET/PATCH typed Tow settings (`TowSettingsPatch`, partial, validated) | Generic whole-row settings CRUD/import; no Tow-scoped typed validation | **ADAPT** — new thin `/admin/tow/settings` surface over the same table |
| Matching radius setting | `guincho_search_radius_km` (`002_baseline_settings.js:24`, km) and legacy `tow_search_radius_km` consumer (`src/models/EmergencyRequest.js:1085-1093`) | **ADAPT** — MVP-01 defines canonical `tow_initial_radius_km`/`tow_max_radius_km` |
| Proposal expiry setting | `guincho_proposal_expiry_minutes` (`002_baseline_settings.js:25`) | **REUSE (value)** — promoted to typed `tow_proposal_expiry_minutes` |
| Per-vehicle pricing parameters | Legacy `tow_price_per_km`/`tow_minimum_charge` in reais (`002_baseline_settings.js:43-46`) | **REPLACE** — MVP-01 persists pricing per `TowVehicle` in canonical cents/meters (not a global setting) |
| No Phase-2 financial/no-show/payout settings | Contract declares 14 `TowSettings` props including counteroffer/no-show/payout (`tow-api-contract.base.openapi.yaml:1472-1495`) | **MISSING/DEFER** — MVP-01 implements only the MVP subset and documents the deferral |

## 3. TowVehicle

| Required MVP-01 capability | Existing implementation | Class |
| --- | --- | --- |
| TowVehicle domain/persistence/API | No `tow_vehicles` table/model/route (`grep` → 0 hits) | **MISSING** |
| Partner ownership / multiple vehicles per partner | `partners` table (`001:246-306`) with `partners.user_id`; no vehicle relation | **REUSE (partners)** + **MISSING (vehicles)** |
| At most one active TowVehicle per partner | No invariant anywhere; legacy `partners.vehicle_type`/`license_plate` are single free-text columns (`001:280-281`) | **MISSING** — DB partial unique index + transactional activation |
| Class/capacity for matching | Legacy `tow_proposals.tow_truck_type`/`tow_capacity_kg`/`has_winch` (`001:863-865`) is proposal-scoped and client-supplied | **REPLACE** — vehicle-scoped `equipment_type`, `supported_vehicle_classes`, `max_towed_weight_kg` |
| Pricing persisted in canonical cents/meters | Legacy money is `decimal(10,2)` reais (`001:856+`) and distance in km | **REPLACE** — integer cents + `included_km` decimal + integer `price_per_additional_km_cents` |
| Activate/deactivate | none | **MISSING** |

## 4. Vehicle documents

| Required MVP-01 capability | Existing implementation | Class |
| --- | --- | --- |
| Required TowVehicle documents | Partner-level onboarding docs exist (`partner_documents` `001:973-993`; rules `src/config/partnerDocumentRules.js:1-80`; flow `src/services/DocumentService.js`) — a different entity | **ADAPT boundary** — reuse the *pattern* (status/rejection/verified_by) but create `tow_vehicle_documents`; do **not** overload `partner_documents` |
| Storage via port | Multipart upload + local storage + public URL (`src/routes/upload.js`, `src/config/publicUrl.js`) | **REUSE (mechanism)** wrapped behind a `FileStorage` port so Domain/Application stay infrastructure-free |
| Statuses `pending\|approved\|rejected\|expired` | Partner docs use `pending/approved/rejected` (`001:982`), no `expired`; contract enum at `tow-api-contract.base.openapi.yaml:1175-1177` | **ADAPT/REPLACE** — new canonical status vocabulary; `expired` is derived for eligibility from `expires_at` |
| Admin approval/rejection | `DocumentController.verifyDocument` (`src/controllers/DocumentController.js:262-326`) for partner docs | **ADAPT (pattern)** — new thin admin surface for vehicle docs with canonical error codes |
| Operational only with required docs approved and valid | `Partner.hasAllRequiredDocuments` for partner onboarding | **MISSING (vehicle)** — new `document-policy` + `eligibility-policy` |

## 5. Compatibility

| Required MVP-01 capability | Existing implementation | Class |
| --- | --- | --- |
| Centralized class/capacity compatibility policy | Legacy filtering is inline in proposal/matching code and proposal-scoped (`tow_proposals.tow_truck_type/capacity`) | **MISSING** — pure domain `compatibility-policy` with canonical `motorcycle/light_vehicle/medium_truck/heavy_truck` |
| Weight mandatory for medium/heavy | none | **MISSING** |

## 6. Operational eligibility composition

| Required MVP-01 capability | Existing implementation | Class |
| --- | --- | --- |
| module availability + active vehicle + valid documents + compatibility = eligible | Legacy `findNearby` filters on partner flags only (`src/models/EmergencyRequest.js:450-527`) | **MISSING** — pure `eligibility-policy` composing the four inputs |

## 7. Cross-cutting reusable assets (do not duplicate)

| Asset | Path | MVP-01 use |
| --- | --- | --- |
| Auth + role middleware | `src/middleware/auth.js:6-83` | **REUSE** for partner ownership and admin-only endpoints |
| Express app factory | `src/app.js:19-172` | **REUSE** — mount two thin Tow routers |
| Knex singleton | `src/config/database.js:1-59` | **REUSE** through repository adapters |
| SQLite test harness schema | `tests/helpers/testDb.js:93-687` | **ADAPT** — add the three MVP-01 tables for offline API tests |
| Real Postgres harness | `tests/helpers/tow/postgres.js`, `scripts/tow/{pg-guard,test-env}.js` | **REUSE** for DB + concurrency proof |
| T01 baseline lifecycle | `scripts/tow/db-baseline.js`, `run-db-baseline-gate.js`, `001/002` | **ADAPT** expectations to the new deterministic migration list/table/settings set |
| Contract + OpenAPI gates | `npm run validate:openapi`, `npm run test:contract`, `npm run verify:tow` | **REUSE** unchanged |

## 8. Scope boundary (explicit non-deliverables)

The following remain **untouched** by MVP-01 and are registered here so the
review can verify containment: Google Routes/route pricing (MVP-02),
`TowRequest`/matching/radius query (MVP-03), proposals/counteroffers/assignment
(MVP-04), execution/tracking/cancellation (MVP-05), CASH/CARD/PIX/debts/wallet/
payout (MVP-06), disputes/reviews/audit/Phase-2 races (#33), secret rotation
(#31), production/VPS.

## 9. Resulting MVP-01 construction plan

```text
src/modules/tow/domain/        identity, errors, vehicle-classes, pricing,
                               tow-vehicle, compatibility-policy,
                               document-policy, availability-policy,
                               eligibility-policy        (pure JS, no I/O)
src/modules/tow/application/   ports, module-service, vehicle-service,
                               document-service, settings-service,
                               eligibility-service       (no Express/Knex/fs)
src/modules/tow/adapters/      persistence (knex), storage (fs via port),
                               clock
src/modules/tow/http/          thin controllers, serializers, error mapper,
                               routes
database/migrations/003_...    service_modules, tow_vehicles,
                               tow_vehicle_documents + DB invariants
```

No code was written before this delta existed.
