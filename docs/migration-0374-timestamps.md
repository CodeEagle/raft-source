# 0374–0377 journal order correction

The merged journal placed 0374–0377 before 0373 in time. Drizzle selects pending
SQL using `folderMillis > max(applied.created_at)`, so an upstream database already
at 0373 could skip these custom migrations. Keep the strict timestamp invariant.

This patch changes **only the four journal timestamps**, to 1792360939360 through
1792360939363. They are strictly after 0373 (1792360939359) and before 0378.
Migration SQL files, content hashes, and **0378's timestamp (1792395629764) remain
unchanged**. A fully applied legacy database whose head is 0378 therefore keeps
its existing `(hash, created_at)` match and remains `AT_TARGET_NOOP`, without
rewriting historical database records or replaying SQL. This includes a ledger
with fewer historical rows than the current manifest.

A partially applied legacy branch requires separate reconciliation: some rows may
have old timestamps hidden below the upstream head. The deployment preflight now
reads the ledger and rejects `PENDING_ALREADY_APPLIED` if pending SQL already has
a recorded hash at an unrecognized timestamp. It never repairs or rewrites the
ledger automatically. A legacy intermediate head not in the corrected manifest
continues to fail closed as `HEAD_DIVERGED`. Do not bypass preflight or use the
unguarded `db:migrate` path for such a database; inspect the exact schema and
history before any separately reviewed reconciliation. No test exception is added.

## Validation

Run the existing invariant/admission tests:

```sh
cd packages/server
pnpm test src/db/migrationPreflight.test.ts
```

For the canonical PostgreSQL migration test, use a dedicated scratch server where
the supplied test role may create/drop databases. The suite never reads the normal
`DATABASE_URL`; each case creates and cleans its own random database.

```sh
MIGRATION_0374_ORDER_REAL_PG_URL=postgres://postgres@127.0.0.1:55463/postgres \
  pnpm test src/db/migration0374Order.realPg.test.ts
```

It applies the actual bundled SQL and validates fresh bootstrap, upgrade from 0373,
a fully applied legacy-timestamp ledger with a reduced historical row count
(no SQL replay and no ledger writes), and rejection of a legacy partial ledger
before SQL executes. Deployment preflight is exercised against those databases.
The real-PostgreSQL suite is explicitly skipped without its scratch URL.

Development validation used isolated local PostgreSQL 16.15. It did not access or
change the live dev database, build an LPK, install, or restart any application.
The release owner must run preflight against the actual target database with this
exact source before deciding whether to resume deployment.
