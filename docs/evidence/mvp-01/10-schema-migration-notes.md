# MVP-01 — Schema & Migration Notes

> Migration: `database/migrations/003_mvp01_tow_foundation.js`
> Applied on top of the accepted T01 baseline (`001_baseline_schema.js`,
> `002_baseline_settings.js`). `001/002` are untouched.

## Applied migration list (derived, not hardcoded)

```text
001_baseline_schema.js
002_baseline_settings.js
003_mvp01_tow_foundation.js
```

The T01 clean-database gate (`npm run test:db-baseline`) and the T01
`MIGRATION` suite now **derive** the expected list from
`database/migrations/*.js`, so the "exact baseline" assertion stays strict while
a new deterministic migration does not require editing a hardcoded array.

## New tables

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `service_modules` | Canonical Tow module registry | `module_key` UNIQUE; `updated_by` FK→`users` (SET NULL); exactly one seeded row `tow/tow/tow` |
| `tow_vehicles` | Partner-owned tow vehicles | `(partner_id, plate)` UNIQUE; `partner_id` FK→`partners` (CASCADE); **partial UNIQUE index `tow_vehicles_one_active_per_partner` on `(partner_id) WHERE active = true`**; CHECKs for year, weight, equipment type, non-negative integer cents and `included_km`; jsonb class array length ≥ 1 |
| `tow_vehicle_documents` | Per-vehicle documents | FKs `tow_vehicle_id`→`tow_vehicles` (CASCADE), `partner_id`→`partners` (CASCADE), `verified_by`→`users` (SET NULL); status CHECK `pending/approved/rejected/expired`; `file_size >= 0` CHECK |

## Structural seed

`003` inserts exactly one row into `service_modules`:

```text
module_key=tow  service_key=tow  partner_type=tow  enabled=true
```

It inserts **no** functional business data. The T01 baseline assertion keeps its
"no functional data / exactly one admin" guarantees and now also asserts that
`service_modules` holds exactly the one canonical module row.

## Settings

MVP-01 does **not** seed new `system_settings` rows. The typed MVP settings
(`tow_initial_radius_km`, `tow_max_radius_km`, `tow_proposal_expiry_minutes`)
resolve to typed defaults when absent and are persisted into the existing
`system_settings` table only when an admin patches them. The baseline settings
count therefore remains 25.

## Determinism

- `migrate` from an empty schema applies the three migrations in batch 1;
- `reset + migrate + seed` reproduces the same fingerprint on both runs.

## Fingerprint (real PostgreSQL 14, disposable T01 container)

```text
run 1: 37cee47edc8dd1084786ab5fe3c32511c71b9a4a2788f67406391916c7cc0f59
run 2: 37cee47edc8dd1084786ab5fe3c32511c71b9a4a2788f67406391916c7cc0f59
baseline: 32 tables, 31 rows (1 admin + 25 settings + 1 module + 4 knex bookkeeping), settings=25
```

Evidence: `03-db-baseline-gate.txt`, `03-db-baseline-gate.json`.

## Rollback

`down()` drops `tow_vehicle_documents`, `tow_vehicles`, `service_modules` in
reverse dependency order. No legacy migration is edited or restored.
