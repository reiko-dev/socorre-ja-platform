# MVP-01 — External Correction Pass (EXT-MVP01-1 + EXT-MVP01-2)

External review of PR #35 returned `CHANGES_REQUIRED` (P0 = 0, P1 = 1, P2 = 1).
This pass fixes both findings, adds the required tests, re-runs every gate and
keeps all MMVP-1..6 fixes and their tests intact.

- Execution base: `c8e40d71` (post-merge Tow MVP replan)
- Previous reviewed head: `0d52d797` (Muse-approved `8bb98fc7` + review artifacts)
- **New implementation head: `443ac423`** (`fix(mvp-01): private Tow document
  storage, authenticated download and partner-type eligibility`)
- Push / PR / merge: **not performed** (orchestrator re-runs Muse, then updates PR #35)

## EXT-MVP01-1 (P1) — Tow documents private, readable only through an authorized API

### Storage design

- Default Tow document storage moved **out of the public web tree**:
  `<backend>/private/tow-documents` (`socorre_ai_backend/private/tow-documents`),
  resolved by `adapters/storage/local-file-storage.js`. The
  `TOW_DOCUMENT_STORAGE_DIR` env override keeps working (tests point it at a temp
  dir via `tests/setup.js`).
- `socorre_ai_backend/private/` added to `.gitignore`. No nginx config was
  touched: `/uploads/*` is **not** broadened and `/uploads/tow-documents` is not
  made public. Production/VPS untouched.
- The adapter is the only filesystem touch point; it also refuses any key that
  escapes the base directory (`resolveKey` containment).

### FileStorage port (public-URL contract removed)

`application/ports.js`:

```
save(file)  -> Promise<{ key }>      // no `url` anymore
read(key)   -> Promise<Buffer>       // rejects with ENOENT when absent
remove(key) -> Promise<void>
```

`urlFor` was removed from the port typedef and from the adapter. Filesystem
absolute paths and public static URLs are no longer part of the consumer
contract.

### Authenticated download endpoints (additive transport)

Both resolve the document through the application layer and read bytes through
the FileStorage port. They are documented in code as a **candidate for a future
contract revision**; the frozen OpenAPI was not silently changed.

| Route | Auth | Resolution |
| --- | --- | --- |
| `GET /api/admin/tow/vehicle-documents/:documentId/download` | `auth` + `requireAdmin` | `documentService.readForAdmin` |
| `GET /api/tow/vehicles/:vehicleId/documents/:documentId/download` | `auth` + `requireTowPartner` | `documentService.readForVehicle` (strict ownership) |

Both set `Content-Type` from the stored mime, `Cache-Control: private, no-store`
and a safe `Content-Disposition: attachment; filename="<sanitized>"` (path
components stripped, unsafe characters replaced). No absolute path is ever
exposed. A missing document or missing object → `404 not_found`; a non-owned
document on the partner route → `404` (no existence leak).

### DTO

The frozen `TowVehicleDocument` schema still requires `file_url` (string). The
field is kept but now carries the **relative authenticated API download path for
the response context**:

- partner routes → `/api/tow/vehicles/{vehicleId}/documents/{documentId}/download`
- admin routes → `/api/admin/tow/vehicle-documents/{documentId}/download`

It is never `/uploads/...`, never an absolute URL and never a filesystem path.
Internally `file_url` is persisted as the storage key (not public).

### Authz matrix (real app + auth/role middleware)

| Request | anonymous | non-admin (partner) | other tow partner | owning partner | admin | nonexistent |
| --- | --- | --- | --- | --- | --- | --- |
| admin download | 401 | 403 | n/a | n/a | 200 | 404 |
| partner download | 401 | n/a | 404 | 200 (own only) | n/a | 404 |

Security tests (`tests/tow/mvp01/towDocumentDownload.test.js`, 9 tests) also
prove the exact stored bytes and mime, a sanitized `Content-Disposition`, that
`file_url` is the relative authenticated path on both surfaces, and that direct
knowledge of the storage key grants nothing (`/uploads/<key>` and `/<key>` are
404 — there is no static route).

`tests/tow/mvp01/towLocalFileStorage.test.js` (5 tests) proves the default dir is
outside `uploads/`, `save` returns only `{ key }`, there is no `urlFor`, `read`
returns the bytes, `remove` deletes them, key traversal is refused and the
private dir is git-ignored.

MMVP-5 storage cleanup is preserved: `document-service.remove` still calls
`storage.remove(file_path)` best-effort, and its tests keep passing with the new
port (`tests/tow/mvp01/towDocumentService.test.js`, 3 new read tests added).

## EXT-MVP01-2 (P2) — central eligibility requires `partner_type=tow`

- New application port `PartnerRepository` in `application/ports.js`
  (`findById(id) -> { id, type } | null`) with a Knex adapter
  `adapters/persistence/partner-repository.js` that selects only `id, type`.
  Domain/application do not import the legacy `Partner` model or Knex.
- `eligibility-service.evaluate()` loads the partner through the port and passes
  it to the pure domain `evaluateEligibility`, which now rejects:
  - partner missing → not eligible (`partner_not_operational`, reason
    `partner_missing`);
  - `type !== 'tow'` → not eligible (`partner_not_operational`, reason
    `partner_not_tow`).
  Existing codes for module/vehicle/documents/compatibility are unchanged.
- Check order: **module availability first**, then partner identity, then
  vehicle/documents/compatibility — so a disabled module still reports
  `service_module_disabled` even for a non-tow partner.
- `composition.js` wires `partnerRepository` into the eligibility service.

Tests:

- `tests/tow/mvp01/towEligibilityService.test.js` (9 tests): tow partner eligible;
  a `mechanic` partner with active TowVehicle + approved document + compatibility
  is NOT eligible; missing partner NOT eligible; the partner is loaded through the
  port (spy assertion); and a `tow -> non-tow` type mutation immediately revokes
  eligibility without calling `vehicleRepository.update/remove`.
- `tests/tow/mvp01/towFoundationDomain.test.js`: partner is required for
  eligibility and a non-tow/missing partner returns `partner_not_operational`,
  while a disabled module wins first.
- `tests/tow/mvp01/towEligibilityIntegration.test.js` (2 tests): through the real
  composition root + persistence, a tow partner with an active vehicle and an
  approved document is eligible; mutating the partner type to `mechanic` makes
  eligibility immediately false and the TowVehicle row is byte-for-byte unchanged
  (still `active`).
- `tests/tow/mvp01/towPartnerRepository.test.js` (3 tests): `{ id, type }`
  projection, `null` for a missing partner, and a Knex instance is required.

## RED-first evidence

`docs/evidence/mvp-01/13a-red-external-correction.txt` — the new/extended suites
run before the implementation:

```
Test Suites: 7 failed, 7 total
Tests:       20 failed, 46 passed, 66 total
```

All 7 suites went green after the implementation.

## Gates (all green, PostgreSQL torn down)

| Command | Exit | Summary |
| --- | --- | --- |
| `npm run validate:openapi` | 0 | PASS (0 unresolved refs / 0 dropped shadowed methods) |
| `npm run test:contract` | 0 | 5 suites / 62 tests PASS |
| `npm run verify:tow` | 0 | GREEN 5/5 stages incl. disposable PostgreSQL; teardown verified |
| `npx jest tests/tow/mvp01 --runInBand` | 0 | 12 passed / 2 skipped suites · 105 passed / 10 skipped |
| `npx jest tests/tow --runInBand` | 0 | 28 passed / 5 skipped suites · 456 passed / 58 skipped |
| `npm run test:db-baseline` | 0 | GREEN — 32 tables / 31 rows, fingerprint `37cee47e…` identical ×2, teardown verified |
| `npx jest --runInBand` | 0 | 61 passed / 5 skipped suites · **880 passed / 58 skipped / 0 failures** |
| `TOW_POSTGRES_E2E=1 npx jest tests/tow/mvp01 --runInBand` | 0 | 14 suites / 115 tests PASS (incl. real-PG persistence + concurrency) |
| `TOW_POSTGRES_E2E=1 npx jest tests/tow/baseline/dbBaseline.e2e towPostgres.e2e g3TowPostgres.e2e` | 0 | 3 suites / 42 tests PASS (T01 baseline 33, legacy tow 2, g3 7) |
| `npm run test:pg:down` | 0 | containers/volumes/network destroyed, 0 left |

Raw logs: `13b`–`13h` in this directory.

## MMVP-1..6 regression

Preserved and green: duplicate plate → 409; `expires_at` validation; pinned
migration list; activation conflict mapping; storage cleanup; transactional
settings. The full Jest count rose from 851 passed / 58 skipped to **880 passed /
58 skipped / 0 failures** — exactly the 29 new tests, with no pre-existing test
weakened and no `.only`/`.skip`/relaxed expectation.

## Scope

- MVP-02: NO · #33: NO · #31: NO · production/VPS: NO
- No nginx change, no `/uploads` broadening, no static route for private bytes.
- The frozen OpenAPI was not modified; the download routes are additive
  authenticated transport documented as a candidate for a future contract
  revision.
- No `git add -A`; explicit paths only; no push/PR/merge.

## Remaining findings

- The download endpoints are intentionally **not** in the frozen OpenAPI (no
  MVP-01 operation exists for them); they are flagged for a future contract
  revision so the contract can catch up with the additive transport.
- `partner_not_operational` is a domain-application error code with a 409 status;
  it is not part of the frozen `ErrorResponse` enum (the enum check only requires
  the canonical set to be present, so this is additive and non-breaking).
