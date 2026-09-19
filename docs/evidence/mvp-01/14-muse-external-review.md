# MVP-01 — Targeted Muse re-review (external findings EXT-MVP01-1 / EXT-MVP01-2)

```text
verdict: APPROVE
reviewed_head: b7f86d49
implementation_head: 443ac423
reviewer: Muse Sparks 1.3 Free
prior: external review CHANGES_REQUIRED (P0=0, P1=1, P2=1) on head 0d52d797
scope: MVP-01 / Issue #13 — Tow Foundation (external correction pass)
findings: []
```

## Summary

Both external findings are fixed and adversarially confirmed. Tow documents now live in git-ignored
`<backend>/private/tow-documents` with a `urlFor`-free `save/read/remove` port, traversal-contained keys, and
authenticated admin/partner download endpoints enforcing the full 401/403/404 matrix; central eligibility
loads `{id,type}` through a new `PartnerRepository` port and rejects non-tow/missing partners with
`partner_not_operational` (module check still first). All live gates pass — mvp01, full tow, full jest (after
one flaky run, two consecutive greens), OpenAPI, contract, `verify:tow`, `db-baseline`, and real-PG mvp01 with
mandatory teardown — with no scope creep.

## External finding checks

| id | status | evidence |
|---|---|---|
| EXT-MVP01-1 | **FIXED** | Default base is `<backend>/private/tow-documents` (git-ignored via `socorre_ai_backend/private/`); `save` returns `{key}` only, `urlFor` deleted, `read()` streams bytes, `resolveKey` contains traversal; `GET /api/admin/tow/vehicle-documents/:id/download` (auth+requireAdmin) and `GET /api/tow/vehicles/:vehicleId/documents/:documentId/download` (auth+requireTowPartner) stream the stored mime with sanitized `attachment` disposition; `file_url` is the relative authenticated download path per scope, never `/uploads`. |
| EXT-MVP01-2 | **FIXED** | New `PartnerRepository` port + Knex adapter returning `{id,type}|null` with no legacy Partner-model coupling; `evaluateEligibility` checks module first (`service_module_disabled`) then missing/non-tow partner (`partner_not_operational`); `EligibilityService` loads the partner via the port and passes it to the pure policy; type mutation `tow→mechanic` revokes eligibility without touching the vehicle row (unit spy + integration proof). |

## MMVP-1..6 regression

**NO REGRESSION** — mvp01 105 passed offline / 115 passed on real PG; full tow 456 passed; contract 62 passed;
OpenAPI gate exit 0 with the frozen contract untouched; `verify:tow` GREEN; `remove()` still deletes the row
first with best-effort `storage.remove` in try/catch; architecture-boundary test enforces no `.only` and passes.

## Checks (live evidence)

- **private_storage**: `defaultBaseDir` resolves to `<backend>/private/tow-documents` (no `uploads` segment);
  `.gitignore` adds `socorre_ai_backend/private/`; `nginx.production.conf` untouched; `TOW_DOCUMENT_STORAGE_DIR`
  override verified.
- **port_and_traversal**: `save -> {key}` only (`urlFor: undefined`), `read -> Buffer`, `remove`; `grep` shows
  no public URL in `src`; `../../etc/passwd` and backslash variants refused with `escapes the base directory`
  (read AND remove); absolute `/etc/passwd` contained (ENOENT).
- **download_endpoints_and_authz**: SEC suite (real app + real storage on a temp dir): anonymous 401 both
  surfaces; non-admin 403 on admin route; other partner 404 `not_found` (foreign vehicle/document shapes);
  owner 200 byte-identical + `image/jpeg`; admin 200; `999999` → 404 both; `Content-Disposition: attachment`
  sanitized (no `..`, no `/`); storage-key knowledge → `GET /uploads/<key>` and `/<key>` both 404 (no static
  serving).
- **dto_file_url**: `documentDownloadPath(row, scope)` — admin and partner relative paths; test asserts exact
  strings, no `http(s)`, no `/uploads/`; stored key is never emitted.
- **partner_type_eligibility**: tow+valid → eligible; mechanic+active vehicle+approved docs+compatible →
  `partner_not_operational`; null partner → `partner_not_operational`; disabled module + mechanic →
  `service_module_disabled` (order); service spy + integration flip revokes with the vehicle row unchanged.
- **regression_live**: `tests/tow/mvp01` 105 passed offline / 115 passed on PG; `tests/tow` 456 passed; full
  jest (first run transient 2-failed, then two consecutive GREEN, 61 suites/880 passed/5 skipped); OpenAPI
  exit 0; contract 5/62; `verify:tow` GREEN; `db-baseline` GREEN; PG teardown leaves nothing; worktree clean.
- **scope**: implementation diff touches only `.gitignore` + the Tow module + its tests; no openapi/nginx/
  pricing/requests/matching/proposals/assignment/tracking/payments changes; download routes deliberately left
  out of the frozen OpenAPI (candidate for a future contract revision).

## Unverified or risky (non-blocking)

- One transient full-jest run showed 2 failed non-tow suites (FAIL lines not captured); two subsequent full
  runs were GREEN and all focused gates never failed — treated as flaky non-tow suites.
- `tests/tow/mvp01/towPersistence.e2e.test.js` seeds a raw row with the stale string
  `/uploads/tow-documents/crlv.jpg` (FK fixture, bypasses the service, never served; DTO ignores stored
  `file_url`) — cleanup candidate.
- Absolute-path keys are contained (ENOENT inside baseDir) rather than rejected with the `escapes` error;
  effect is safe; only relative-traversal shapes assert the explicit refusal message.

## Verdict

**APPROVE** — P0 = 0, P1 = 0, P2 = 0, P3 = 0; `findings: []`.
