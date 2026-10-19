#!/bin/sh
set -eu
cd /app

# Bound each dependency wait; failure lets the container supervisor retry.
wait_tcp() {
  node --input-type=module - "$1" "$2" <<'JS'
import net from 'node:net';
const [host, port] = process.argv.slice(2);
const deadline = Date.now() + 120_000;
while (true) {
  const ready = await new Promise(resolve => {
    const socket = net.connect({ host, port: Number(port) });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  if (ready) break;
  if (Date.now() >= deadline) throw new Error(`TCP readiness timed out: ${host}:${port}`);
  await new Promise(resolve => setTimeout(resolve, 1000));
}
JS
}
wait_tcp postgres 5432
# Migration contract: preflight requires the migration DSN to actually deliver a
# statement_timeout via libpq startup options, and to declare the expected value.
# PGOPTIONS is inline (not exported) so the running server's pool is unaffected.
PGOPTIONS="-c statement_timeout=30000" \
SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS=30000 \
  node --import @oxc-node/core/register packages/server/scripts/migration-preflight.ts
(
  cd /app/packages/server
  PGOPTIONS="-c statement_timeout=30000" \
    node --import @oxc-node/core/register scripts/migrate-deploy.ts
  node --import @oxc-node/core/register scripts/verify-feature-flag-admin-privileges.ts
)

mkdir -p /lzcapp/var/secrets /lzcapp/var/uploads
umask 077
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
// Persist a legacy environment secret once before adopting file-backed identity.
try {
  writeFileSync('/lzcapp/var/secrets/scope_attestation_secret', process.env.SCOPE_ATTESTATION_SECRET || randomBytes(64).toString('base64'), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
try {
  writeFileSync('/lzcapp/var/secrets/jwt_secret', randomBytes(64).toString('base64'), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
JS
SCOPE_ATTESTATION_SECRET=$(cat /lzcapp/var/secrets/scope_attestation_secret)
export SCOPE_ATTESTATION_SECRET
JWT_SECRET=$(cat /lzcapp/var/secrets/jwt_secret)
export JWT_SECRET
wait_tcp risingwave 4566
if [ ! -f /lzcapp/var/secrets/.rw-bootstrapped ]; then
  node --import @oxc-node/core/register /app/lazycat/scripts/rw-bootstrap.mjs
  touch /lzcapp/var/secrets/.rw-bootstrapped
fi
exec node --import @oxc-node/core/register packages/server/src/server.ts
