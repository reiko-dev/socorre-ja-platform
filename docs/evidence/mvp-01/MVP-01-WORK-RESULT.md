# MVP-01 Work Result

## Status
READY_FOR_MUSE_REREVIEW

## Base / Branch / Head
- Repository: `socorre-system`
- Base (execution): `c8e40d71dd23c32a76050c05518353b6d030753f` (post-merge main of PR #34, Tow MVP replan; T00/T01 ACCEPTED)
- Branch: `feature/mvp-01-tow-foundation`
- Original reviewed head: `872b22ed` (implementation `cd509eaf`)
- Muse correction implementation head: `8bb98fc7ce70b465fe29a3dcc1e799382c8761d7`
- **External correction implementation head: `443ac423`** (EXT-MVP01-1 + EXT-MVP01-2)
- Push / PR / merge: **not performed** (executor stops before Phase J; orchestrator runs Muse then updates the PR with `Closes #13`)

## Current-State Delta
Delivered as its own required artifact before any code:
`docs/evidence/mvp-01/01-current-state-delta.md` maps every MVP-01 capability →
existing implementation (`file:line`) → REUSE/ADAPT/REPLACE/MISSING. Summary:
- no Tow v1 module/vehicle/document vocabulary existed; `partners.type='tow'`
  and `system_settings` are the only reusable assets;
- partner onboarding documents (`partner_documents`, `DocumentService`) are a
  different entity and were **not** overloaded;
- the legacy `emergency_requests`/`tow_proposals` flow is out of MVP-01 scope
  and untouched.

## Architecture
Clean module under `src/modules/tow/`:
- `domain/**` — pure: identity, errors, vehicle classes, pricing, vehicle
  invariants, document policy, availability policy, compatibility policy,
  eligibility composition, settings schema. No Express/Knex/fs/provider import.
- `application/**` — services + ports only; depends on ports, never adapters.
- `adapters/**` — Knex persistence, local file storage, system clock.
- `http/**` — thin controllers + DTO serializers + canonical error mapper.
- `composition.js` — the only place pure layers meet infrastructure.
Boundary is enforced by `tests/tow/mvp01/towArchitectureBoundary.test.js`
(domain/application import only relative pure files; HTTP controllers import no
persistence client; no hidden `.only`/`test.skip`).

## Module
- Canonical identity `module_key=tow`, `service_key=tow`, `partner_type=tow`
  (`domain/identity.js`), single DB-constrained row in `service_modules`.
- Admin-only `GET|PATCH /api/admin/tow/module`; idempotent toggle (repeated
  same-state toggle writes nothing and keeps the first reason); metadata
  `enabled`, `disabled_reason`, `updated_by`, `updated_at`.
- Public `GET /api/tow/module-status` (contract has no security on this path).
- Central availability policy (`isModuleEnabled` / `assertModuleEnabled`) throws
  the canonical `service_module_disabled` (409).
- MVP graceful-drain contract exposed: blocks new business, preserves
  administration, allows ASSIGNED to drain; advanced SEARCHING/NEGOTIATING
  closure and disable races deliberately deferred to #33.

## TowVehicle
- `tow_vehicles` table + domain + API (`/api/tow/vehicles` CRUD,
  `/activate`, `/deactivate`), partner-owned via `req.user.partner_id`.
- **At most one active per partner**: PostgreSQL partial unique index
  `tow_vehicles_one_active_per_partner` plus transactional activation that
  deactivates siblings; a unique violation maps to `conflict`.
- Canonical pricing persisted as integer cents + `included_km` decimal:
  `minimum_charge_cents`, `included_km`, `price_per_additional_km_cents`.
- `(partner_id, plate)` uniqueness, CHECK constraints for year/weight/cents,
  equipment-type and vehicle-class vocabularies.
- `document_status` is derived from the vehicle documents for every response.

## Documents
- `tow_vehicle_documents` table; storage behind a `FileStorage` port (local
  adapter only in infrastructure).
- Statuses `pending|approved|rejected|expired` (DB CHECK). `expires_at` in the
  past makes an approved document effectively `expired` for eligibility.
- Partner upload/list/delete scoped to the owning partner; admin
  list/get/approve/reject under `/api/admin/tow/vehicle-documents`.
- A TowVehicle is operational only with the required document
  (`vehicle_license`) approved and valid.

## Compatibility
- Central pure policy `domain/compatibility.js`:
  requested class ∈ `supported_vehicle_classes`, requested weight ≤
  `max_towed_weight_kg`, weight/PBT mandatory for `medium_truck`/`heavy_truck`.
- Canonical classes `motorcycle|light_vehicle|medium_truck|heavy_truck`,
  equipment `flatbed|wheel_lift|heavy_wrecker`.
- Operational eligibility composition
  (`module + active vehicle + valid documents + compatibility`) is one pure
  function plus an application service (`GET`-less seam for MVP-03).

## Migrations
- New deterministic `003_mvp01_tow_foundation.js`; `001/002` and
  `database/migrations-legacy/**` untouched.
- Structural seed: exactly one `service_modules` row (`tow/tow/tow`), no
  functional data. New fingerprint:
  `37cee47edc8dd1084786ab5fe3c32511c71b9a4a2788f67406391916c7cc0f59`
  (identical across reset+migrate runs).
- T01 expectations **pinned explicitly** (correction pass MMVP-3): the gate and
  the T01 e2e suite pin
  `['001_baseline_schema.js','002_baseline_settings.js','003_mvp01_tow_foundation.js']`;
  the directory read is only a loud cross-check that names any unexpected or
  missing file, so migration scope creep trips the gate.
  `db-baseline.js` requires the 3 new tables and allows exactly one
  `service_modules` row (with a specific assertion), keeping the
  "no functional data / exactly one admin" guarantees intact.
- Details: `docs/evidence/mvp-01/10-schema-migration-notes.md`.

## Tests
New focused suites (`tests/tow/mvp01/`), after the correction pass:
UNIT (domain 27, eligibility service 5, activate-conflict mapping 3, document
service 8, settings repository 5), API (19), AUTHZ (5), SEC/architecture (4),
DB real-PG (6), CONC real-PG (4) = **86 tests** in `tests/tow/mvp01/`,
no `.only`/`test.skip`/relaxed expectations. The correction pass added
**27 tests** (API 5, domain 2, conflict mapping 3, document service 8, settings
repository 5, baseline safety 4).

| Gate | Result |
| --- | --- |
| `npm run validate:openapi` | PASS |
| `npm run test:contract` | 5 suites / 62 tests PASS |
| `npm run verify:tow` | GREEN (5/5 stages incl. PostgreSQL) |
| `npx jest tests/tow --runInBand` | 24 passed / 5 skipped suites · 427 passed / 58 skipped · 0 failures |
| `npm run test:db-baseline` | GREEN (fresh volume; reset+migrate fprints identical) |
| `npx jest --runInBand` (full) | 57 passed / 5 skipped suites · **851 passed / 58 skipped / 0 failures** |
| MVP-01 real-PG suites | `towPersistence.e2e` 6/6 · `towVehicleConcurrency.e2e` 4/4 |
| T01 baseline e2e (real PG) | 33/33 |
| Legacy PG tow e2e | `towPostgres` 2/2 · `g3TowPostgres` 7/7 |

Evidence logs: `02-red-offline.txt` (RED), `06-openapi-contract.txt`,
`07-verify-tow.txt`, `08-full-jest.txt`, and the correction pass
`11-correction-pass.md`.

## PostgreSQL Evidence
Real PostgreSQL 14 in the disposable T01/T00 container (always torn down):
- `03-db-baseline-gate.txt` / `.json` — empty DB → migrate 3 migrations → one
  admin → clean baseline (32 tables) → guarded reset → same fingerprint ×2 →
  teardown verified (no container/volume/network left);
- `04-postgres-mvp01.txt` — migration creates the tables; module key unique;
  **partial unique index rejects a second active vehicle**; FKs cascade;
  **two concurrent activations leave exactly one active vehicle**; repeated
  toggles keep one canonical row; parallel creates leave zero active;
- `05-postgres-t01-and-legacy.txt` — updated T01 baseline e2e 33/33 and the
  legacy PG tow suites unchanged.

## Regression
- Post-T01 baseline preserved: contract 62/62, safety suites green,
  OpenAPI PASS, `verify:tow` GREEN.
- Full Jest rose from 771 passed / 48 skipped / 0 failures to
  824 passed / 57 skipped / 0 failures (all added tests; no pre-existing test
  modified except the two T01 baseline expectations, by design).
- `tests/setup.js` isolates Tow document uploads to the OS temp dir.

## Muse Review
- First pass: Muse Sparks 1.3 Free reviewed the frozen head `872b22ed` (implementation
  `cd509eaf`) and returned `CHANGES_REQUIRED` (P0 = 0, P1 = 1, P2 = 2, P3 = 3).
- Correction pass: all six findings fixed (details below and in `11-correction-pass.md`).
- **Re-review: APPROVE** on head `35ea7302` (implementation `8bb98fc7`) — P0 = 0, P1 = 0,
  P2 = 0, P3 = 1 (`MMVP2-1`, the pre-existing legacy `towDocumentFlow` socket flake, non-blocking;
  recorded in T00 as `flake-tow-document-flow-403.txt`).
- Artifact: `docs/evidence/mvp-01/12-muse-review.md`.
- External review: `CHANGES_REQUIRED` (P0 = 0, P1 = 1 / EXT-MVP01-1 private documents, P2 = 1 /
  EXT-MVP01-2 partner-type eligibility) on head `0d52d797`.
- External correction pass: both findings fixed in implementation `443ac423`
  (private storage + authenticated downloads; `PartnerRepository` port + `partner_not_operational`).
- **External re-review: APPROVE** on head `b7f86d49` — P0 = P1 = P2 = P3 = 0, `findings: []`.
- Artifact: `docs/evidence/mvp-01/14-muse-external-review.md`.

## Correction Pass (MMVP-1..6)
Full detail: `11-correction-pass.md`.

- **MMVP-1 (P1)** — `vehicle-repository.insert()/update()` now map unique
  violations to `TowError('conflict')` (409) via the shared `isUniqueViolation`,
  same as `activate()`. API tests: duplicate-plate POST → 409; PATCH to an
  existing plate → 409 and no row change.
- **MMVP-2 (P2)** — `document-service.upload` validates `expires_at` before
  persisting (`undefined|null|''` → null; anything else must parse, else 422);
  domain `toEpoch` returns `NaN` for garbage and `effectiveDocumentStatus`
  treats it as `expired`, never as never-expiring. Domain + API + unit tests.
- **MMVP-3 (P2)** — the T01 gate and e2e **pin** the exact three migrations; the
  directory read is a loud cross-check that names an unexpected/missing file.
  Offline test proves a smuggled `004_*.js` fails naming the file.
- **MMVP-4 (P3)** — new offline `towActivateConflictMapping.test.js` forces a
  23505 / `SQLITE_CONSTRAINT` through the real service → repository path and
  asserts the mapped `conflict`; concurrency e2e asserts `active_count === 1`
  unconditionally and adds a real-PG direct-SQL index proof.
- **MMVP-5 (P3)** — `document-service.remove` calls `storage.remove(file_path)`
  best-effort after the row delete; unit tests assert only the deleted
  document's bytes are removed and a storage failure never fails the delete.
- **MMVP-6 (P3)** — `settings-repository.upsertMany` wraps the whole patch in
  one transaction; tests prove all-or-nothing rollback and a successful
  multi-key patch.

Post-correction gates: OpenAPI PASS · contract 62/62 · `verify:tow` GREEN ·
`tests/tow` 427 passed / 58 skipped · db-baseline GREEN · full Jest
**851 passed / 58 skipped / 0 failures** · real-PG MVP-01 10 suites / 86 tests ·
T01 baseline e2e 33/33 · legacy PG 2/2 + 7/7.

## External Correction Pass (EXT-MVP01-1 + EXT-MVP01-2)
Full detail: `13-external-correction.md`.

External review of PR #35 returned `CHANGES_REQUIRED` (P0 = 0, P1 = 1, P2 = 1).
Implementation head `443ac423`; both findings fixed and tested.

- **EXT-MVP01-1 (P1) — private documents + authorized read.** Default Tow
  document storage moved out of the public web tree to
  `<backend>/private/tow-documents` (git-ignored; `TOW_DOCUMENT_STORAGE_DIR`
  override kept). The `FileStorage` port now exposes `save -> { key }`,
  `read(key) -> Buffer` and `remove(key)`; `urlFor` was removed. New
  authenticated byte-transport endpoints
  (`GET /api/admin/tow/vehicle-documents/:documentId/download` and
  `GET /api/tow/vehicles/:vehicleId/documents/:documentId/download`) resolve
  through the application layer, read via the port, return the stored mime and a
  sanitized `Content-Disposition`, and never expose a path. The frozen DTO keeps
  `file_url` as the relative authenticated download path per context (never
  `/uploads/...`, never absolute). Authz: anonymous 401, non-admin 403, other
  partner 404, owner/admin 200, nonexistent 404; direct storage-key access is
  404. No nginx/`/uploads` change.
- **EXT-MVP01-2 (P2) — central eligibility requires `partner_type=tow`.** New
  `PartnerRepository` port (`findById -> { id, type } | null`) with a Knex
  adapter under `adapters/persistence/`, wired in `composition.js`. The pure
  domain `evaluateEligibility` rejects a missing/non-tow partner with the stable
  code `partner_not_operational`; module availability is still reported first
  (`service_module_disabled`). Tests prove a mechanic partner with an active
  vehicle and valid documents is not eligible and that a `tow -> non-tow`
  mutation revokes eligibility without mutating the vehicle.

New tests: 29 (local-file-storage 5, download security 9, partner-repository 3,
eligibility-integration 2, plus 4+3+3 extended in the existing eligibility,
domain and document-service suites). RED evidence:
`13a-red-external-correction.txt` (7 suites / 20 failing before the fix).

Post-external-correction gates: OpenAPI PASS · contract 62/62 · `verify:tow`
GREEN 5/5 · `tests/tow/mvp01` 105 passed / 10 skipped · `tests/tow` 456 passed /
58 skipped · db-baseline GREEN (fingerprint `37cee47e…` ×2) · full Jest
**880 passed / 58 skipped / 0 failures** · real-PG MVP-01 14 suites / 115 tests ·
T01 baseline e2e 33/33 · legacy PG 2/2 + g3 7/7. PostgreSQL torn down.

## Scope
- MVP-02 touched: NO
- Phase 2/#33 touched: NO
- #31 touched: NO
- production/VPS touched: NO
- Google Routes / TowRequest / matching / proposals / assignment / tracking /
  cancellation / payments / debts / wallet / disputes / audit: NO
- no `git add -A`; explicit paths only; no push/PR/merge.

## Remaining Findings
- **Settings subset (intentional).** `001`–`003` declare only the MVP settings
  (`tow_initial_radius_km`, `tow_max_radius_km`,
  `tow_proposal_expiry_minutes`). The frozen `TowSettings` schema lists 14
  properties including counteroffer/no-show/payout/cancellation-financial
  values owned by #33 and later MVPs. MVP-01 implements the required subset and
  leaves the remaining typed keys to their owning deliveries.
- **Admin module drain counters** are `0` in MVP-01 because the TowRequest state
  machine does not exist yet (MVP-03+); the field is present to keep the DTO
  contract shape.
- **Operational eligibility** is exposed as a service (the seam later MVPs call)
  rather than a new HTTP path, because no MVP-01 contract operation exists for
  it; the public `/tow/partner/status` route belongs to a later delivery.
- `partner_type` and `updated_by` are returned by the admin module view in
  addition to the contract's required fields (the schema allows it).
- The authenticated document download endpoints are additive transport not yet
  present in the frozen OpenAPI; they are flagged as a candidate for a future
  contract revision (the frozen contract was not silently changed).
- `partner_not_operational` is an additive domain/application error code (409);
  it is not part of the frozen `ErrorResponse` enum (which only requires the
  canonical set to be present).
- No lint/typecheck script exists in the backend package; the Jest suites and
  the architecture boundary test are the static guards.

## Final Verdict
MVP-01 EXTERNAL CORRECTIONS GREEN — READY FOR MUSE TARGETED REVIEW
