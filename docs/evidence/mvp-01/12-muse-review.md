# MVP-01 — Targeted Muse adversarial review (post-correction)

```text
verdict: APPROVE
reviewed_head: 35ea7302
implementation_head: 8bb98fc7
reviewer: Muse Sparks 1.3 Free
prior_review: CHANGES_REQUIRED (MMVP-1..6) on head 872b22ed
scope: MVP-01 / Issue #13 — Tow Foundation
```

## Summary

All six MMVP findings are fixed with real code changes plus 27 focused tests, verified adversarially rather
than from the summary. Every regression gate is green: offline MVP-01/tow/full jest, OpenAPI validation,
contract suite, `verify:tow`, `db-baseline` gate, and real-PostgreSQL MVP-01 (10/10) with mandatory teardown.
No scope leakage, no `.only`/`.skip`, worktree left clean.

## Finding resolution

| id | prior severity | status | evidence |
|---|---|---|---|
| MMVP-1 | P1 | **FIXED** | `vehicle-repository.insert()/update()` catch unique violations (23505 / SQLITE_CONSTRAINT / unique-constraint message) and throw `TowError('conflict')` → HTTP 409; offline API tests prove POST-duplicate → 409/conflict with row count unchanged (1) and PATCH-to-duplicate → 409/conflict with the original plate intact. |
| MMVP-2 | P2 | **FIXED** | `document-service.normalizeExpiresAt()` rejects non-empty unparseable `expires_at` as `validation_error` (422) BEFORE `storage.save` (test asserts save not called); domain `toEpoch()` returns NaN for garbage and `effectiveDocumentStatus` maps NaN → `expired` (never never-expiring). Past → expired/not-eligible; valid future → approved/eligible; `''`/null/undefined → null. |
| MMVP-3 | P2 | **FIXED** | Gate pins `PINNED_MIGRATIONS=[001,002,003]` with pure `assertPinnedMigrations(pinned, actual)` that throws naming unexpected AND missing files; directory read is cross-check only. `dbBaseline.e2e.test.js` pins the same list; `dbBaselineSafety.test.js` adds 4 offline tests (pin exact, real dir matches, extra file throws naming `004_smuggled_scope.js`, missing file throws). `test:db-baseline` GREEN. |
| MMVP-4 | P3 | **FIXED** | New `towActivateConflictMapping.test.js` forces 23505 and SQLITE_CONSTRAINT through the REAL service→repository path (fake knex tx throwing on 2nd update) asserting `conflict`/409, plus a negative control (non-unique error passes through unmapped). Concurrency e2e asserts `active == 1` unconditionally plus a real-PG direct-SQL partial-index proof. |
| MMVP-5 | P3 | **FIXED** | `document-service.remove()` calls `storage.remove(document.file_path)` after row deletion inside try/catch (best-effort). Unit tests: remove called once with the deleted doc's path only; storage failure still resolves `{id, deleted:true}` with the row removed. |
| MMVP-6 | P3 | **FIXED** | `settings-repository.upsertMany()` runs the loop inside a single `db.transaction` via `trx` (early return 0 for empty input). Tests: success applies all keys in 1 transaction; mid-loop failure rolls back new keys and preserves the existing value; service patch/readback passes. |

## Findings

| id | severity | location | evidence | required_fix |
|---|---|---|---|---|
| MMVP2-1 | P3 | `tests/tow/towDocumentFlow.test.js` (legacy pre-MVP-01 harness, untouched) | Orchestrator-observed single `Parse Error: Expected HTTP/, RTSP/ or ICE/` failure, then green in the same run's full suite and 6/6 dedicated re-runs; recorded in `docs/evidence/t00/flake-tow-document-flow-403.txt`. In this review: full jest green (57 suites / 851 tests) and targeted `towDocumentFlow` green (14/14). | None inside MVP-01 (non-blocking). Optional follow-up outside scope: retry/quarantine tracking for the legacy harness. |

## Regression check (live)

- `npx jest tests/tow/mvp01 --runInBand` → 8 passed / 2 skipped (PG-gated), 76 passed, 10 skipped
- `npx jest tests/tow --runInBand` → 24 passed / 5 skipped, 427 passed, 58 skipped
- `npx jest --runInBand` → 57 passed / 5 skipped, **851 passed, 58 skipped** (includes legacy `towDocumentFlow` green)
- `npm run validate:openapi` → PASS
- `npm run test:contract` → 5 suites / 62 tests PASS
- `npm run verify:tow` → GREEN (containers/network removed)
- `npm run test:pg:up` → `TOW_POSTGRES_E2E=1 npx jest tests/tow/mvp01` → 10 suites / 86 tests → `npm run test:pg:down` (no leftovers)
- `npm run test:db-baseline` → GREEN (fingerprint identical across reset; teardown verified; worktree clean)
- `npx jest tests/tow/mvp01/towArchitectureBoundary.test.js` → 4/4 PASS (domain purity; no `.only`/`.skip`; no MVP-02 leakage)

## Verified claims

- duplicate plate → 409 conflict with no row change → CONFIRMED
- garbage `expires_at` rejected 422 pre-storage; past=expired, future=eligible → CONFIRMED
- migration list pinned `[001,002,003]`; extra file fails loudly naming it → CONFIRMED
- 23505/SQLITE_CONSTRAINT → conflict through the service path; `active == 1` unconditional → CONFIRMED
- no regressions across all gates incl. real PG with teardown → CONFIRMED

## Unverified or risky

- Real-PG concurrency rejection path is timing-dependent (serialized runs may yield zero rejections); accepted
  because the deterministic injected-failure suite covers the mapping branch and the invariant is asserted
  unconditionally.
- Settings fake-knex models transaction semantics by construction; real-PG transactional behavior is covered
  indirectly by `verify:tow`/`db-baseline` gates rather than a live mid-loop failure injection.

## Verdict

**APPROVE** — P0 = 0, P1 = 0, P2 = 0, P3 = 1 (MMVP2-1, legacy flake, non-blocking).
