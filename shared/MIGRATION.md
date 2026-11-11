# Explicit Set policy-count migration

The operator explicitly authorized one narrow update to the existing expansion grant: increase `tinyset-small.max_operations` from two to four and correct its documentation URL to `https://docs.tinyfish.ai/datasets/reference.md`. The pool and grant IDs, key fingerprint, expiry, allowed bounties, row cap, price cap, concurrency and **$10 aggregate ceiling stay identical**. Three Research reservations at $2 plus four Set reservations at $1 sum to that same ceiling. The original Set trial remains counted.

This migration was applied once with zero active operations. [Readback receipt](evidence/tinyset-count-migration.json): all 29 existing entries and $3 of retained reservations were preserved, including the prior fixed-Fetch reconciliation. No provider request, refund, counter reset or new grant identity was created. Later jobs can consume the remaining allowance; the receipt is a dated snapshot.

## Implementation and safeguards

`PoolLedger.prepareTinySetPolicyCountMigration(grantFile, confirmGrantId)` accepts only the exact old Set shape: ten rows, 100000 micro-USD per row, two operations and the originally bound documentation URL. It refuses halted pools, any active reservation, an already migrated ledger, a mismatched grant or unrelated changes. It validates the new grant and the aggregate maximum policy products against the unchanged ceiling.

Under the existing exclusive pool lock, preparation writes owner-only old/new snapshots for the grant, binding and ledger, with SHA-256 hashes and a transaction manifest. The new ledger adds a migration audit containing the preserved-entry hash and counters. A durable `.policy-migration-pending.json` marker then fences normal reads and reservations. Nothing is silently committed by initialization, status or reservation.

`PoolLedger.commitTinySetPolicyCountMigration(grantFile, confirmGrantId, confirmMigrationId)` explicitly reviews or resumes that same prepared transaction. It checks the two grants differ only in the authorized fields, validates both ledger snapshots, preserves every entry and reconciliation record, and requires every current target to be its exact old or new bytes. Unexpected edits fail before any replacement. Each replacement uses a private temporary file, file sync, atomic rename and directory sync. All targets are verified before a durable committed receipt is stored and the pending marker is removed.

The active grant, binding and ledger become consistent before ordinary operations resume. Controllers retain immutable grant instances, so old instances deliberately fail the new fingerprint check. Reload controls from the same existing private grant path before the next provider job; do not create a new ledger or grant ID.

## Interrupted migration

An interruption after any of the three target writes leaves the prepared snapshots and pending marker available for explicit recovery. With all workers stopped, inspect the transaction manifest and use the **same commit method and migration ID** to resume. It accepts exact old/new target states and installs the already staged revision; it never overwrites unexpected later data or reconstructs counters.

A hard process crash can also leave `.ledger.lock`. No helper steals or deletes that lock. It requires separate operator review of the owning process and transaction before recovery. Do not remove binding markers, reset state, copy old counters over newer work or use initialization as recovery.

Preparation that never reached its pending marker does not change the active control files. Unused staging directories remain evidence. Once committed, a repeated migration or commit is rejected. The retained transaction directory contains private grant fingerprints and belongs outside any repository.

## Offline verification

```sh
npm run test:shared
npm run typecheck
```

The 28 shared tests include five migration regressions. They verify unchanged identities, key reference, ceiling, existing entries and prior reconciliation history; rejection of active/unrelated/tampered work; recovery after each of the three target-write phases; stale-lock handling; and the final $6 Research plus $4 Set policy ceiling. All filesystem and pricing fixtures are synthetic and issue zero provider requests.
