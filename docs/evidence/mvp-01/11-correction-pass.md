# MVP-01 — Muse Correction Pass (MMVP-1..6)

Reviewed frozen head: `872b22ed` (implementation `cd509eaf`), verdict
`CHANGES_REQUIRED` (P0 = 0, P1 = 1, P2 = 2, P3 = 3). This pass fixes all six
findings and adds the required tests. No MVP-02/#33/#31/production scope.

## MMVP-1 (P1) — duplicate plate maps to 409 conflict, not 500

- `src/modules/tow/adapters/persistence/vehicle-repository.js`: `insert()` and
  `update()` now catch unique violations through the shared `isUniqueViolation`
  predicate and throw `TowError('conflict')` (409), the same mapping already
  used by `activate()`.
- Tests (`tests/tow/mvp01/towFoundationApi.test.js`):
  - POST duplicate plate for the same partner → `409 conflict` and exactly one
    row with that plate;
  - PATCH a plate to an existing plate of the same partner → `409 conflict` and
    the row is unchanged.

## MMVP-2 (P2) — invalid `expires_at` is rejected, never "never-expiring"

- `src/modules/tow/application/document-service.js`: new `normalizeExpiresAt`
  runs BEFORE `storage.save`/persistence. `undefined|null|''` → `null`; any
  other value must parse to a valid date, otherwise `validation_error` (422).
- `src/modules/tow/domain/documents.js`: `toEpoch` returns `NaN` for a
  non-empty unparseable value; `effectiveDocumentStatus` treats that as
  `expired` (not valid, not never-expiring). Empty/null still means no expiry.
- Tests:
  - domain (`towFoundationDomain.test.js`): empty means no expiry; `'garbage'`
    → `expired` / not valid / not satisfied;
  - API (`towFoundationApi.test.js`): garbage → `422 validation_error` and no
    row persisted; past date → stored, approved, `document_status='expired'`;
    valid future → `document_status='approved'`;
  - unit (`towDocumentService.test.js`): absent/empty → `null`; garbage and
    boolean/object/array junk → 422 before storage; past accepted at storage;
    future accepted.

## MMVP-3 (P2) — T01 migration list is pinned, not tautological

- `scripts/tow/run-db-baseline-gate.js`: `PINNED_MIGRATIONS =
  ['001_baseline_schema.js','002_baseline_settings.js','003_mvp01_tow_foundation.js']`.
  `assertPinnedMigrations()` cross-checks the directory and throws an error that
  NAMES the unexpected/missing file; `expectedMigrations()` returns the pinned
  list.
- `tests/tow/baseline/dbBaseline.e2e.test.js`: `BASELINE_MIGRATIONS` is the same
  pinned constant; the directory test throws naming any file outside the pin.
- Tests (`tests/tow/baseline/dbBaselineSafety.test.js`): the pin is the exact
  three; the real directory matches; a fabricated `004_smuggled_scope.js` fails
  loudly naming the file; a missing file fails loudly.
- Real PG: `dbBaseline.e2e.test.js` 33/33.

## MMVP-4 (P3) — conflict mapping forced through the service path

- New `tests/tow/mvp01/towActivateConflictMapping.test.js` (offline): a fake
  Knex transaction throws a 23505 / `SQLITE_CONSTRAINT` on the activation
  update; the REAL `vehicleService.activate` → REAL repository maps it to
  `TowError` `conflict` (409). A non-unique failure is proven NOT to be mapped.
- `tests/tow/mvp01/towVehicleConcurrency.e2e.test.js`: `active_count === 1` is
  asserted unconditionally; the rejection assertion is explicitly conditional on
  observed rejections; a real-PG direct-SQL test proves the partial unique index
  rejects a second active row (4/4 with the new proof).

## MMVP-5 (P3) — deleting a document removes the stored bytes

- `src/modules/tow/application/document-service.js#remove`: after the row
  delete, `storage.remove(document.file_path)` is called best-effort (a storage
  failure never fails the delete; the path is never logged or exposed).
- Tests (`tests/tow/mvp01/towDocumentService.test.js`): `remove` is invoked for
  the deleted document's path, not for others; a storage failure still resolves
  `{ deleted: true }`.

## MMVP-6 (P3) — settings upsert is transactional

- `src/modules/tow/adapters/persistence/settings-repository.js#upsertMany`:
  every key is upserted inside one `db.transaction(trx)`, all-or-nothing.
- Tests (`tests/tow/mvp01/towSettingsRepository.test.js`): a successful patch
  applies all keys in one transaction; a mid-loop failure rolls back new keys;
  an existing value is not clobbered on failure; an empty patch opens no
  transaction; the settings service applies and reads back a two-key patch.

## Tests added

27 new tests, no `.only`/`.skip`/relaxed expectations:

| Suite | Added |
| --- | --- |
| `towFoundationApi.test.js` | 5 |
| `towFoundationDomain.test.js` | 2 |
| `towActivateConflictMapping.test.js` (new) | 3 |
| `towDocumentService.test.js` (new) | 8 |
| `towSettingsRepository.test.js` (new) | 5 |
| `dbBaselineSafety.test.js` | 4 |

## Gates re-run (all green)

| Gate | Result |
| --- | --- |
| `npm run validate:openapi` | PASS |
| `npm run test:contract` | 5 suites / 62 tests PASS |
| `npm run verify:tow` | GREEN (5/5 stages incl. PostgreSQL) |
| `npx jest tests/tow --runInBand` | 24 passed / 5 skipped suites · 427 passed / 58 skipped · 0 failures |
| `npm run test:db-baseline` | GREEN (fresh volume; fingerprint identical ×2; teardown verified) |
| `npx jest --runInBand` | 57 passed / 5 skipped suites · **851 passed / 58 skipped / 0 failures** |
| `TOW_POSTGRES_E2E=1 npx jest tests/tow/mvp01 --runInBand` | 10 suites / 86 tests PASS |
| MVP-01 real PG | persistence 6/6 · concurrency 4/4 |
| T01 baseline e2e (real PG) | 33/33 |
| Legacy PG tow e2e | `towPostgres` 2/2 · `g3TowPostgres` 7/7 |

`npm run test:pg:down` ran after every PG session; teardown confirmed.

## Scope

- MVP-02: NO · #33: NO · #31: NO · production/VPS: NO
- no `git add -A`; explicit paths only; no push/PR/merge.
