import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../packages/server/package.json', import.meta.url));
const { Client } = require('pg');
const spec = JSON.parse(readFileSync(new URL('./rw-bootstrap-spec.json', import.meta.url), 'utf8'));
const identifier = value => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
};
const literal = value => {
  if (value.includes('\0')) throw new Error('CDC value contains NUL');
  return `'${value.replaceAll("'", "''")}'`;
};
function databaseUrl(name, database) {
  const url = new URL(process.env[name] ?? '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname !== `/${database}` || url.search || url.hash) {
    throw new Error(`${name} must address database ${database} without URL overrides`);
  }
  return url;
}
async function main() {
  const postgresUrl = databaseUrl('DATABASE_URL', 'slock');
  const risingwaveUrl = databaseUrl('RISINGWAVE_DATABASE_URL', 'dev');
  const options = url => ({ connectionString: url.toString(), connectionTimeoutMillis: 10_000, query_timeout: 7_200_000 });
  const postgres = new Client(options(postgresUrl));
  const risingwave = new Client(options(risingwaveUrl));
  try {
    await postgres.connect();
    await risingwave.connect();
    const wal = await postgres.query('SHOW wal_level');
    if (wal.rows[0]?.wal_level !== 'logical') throw new Error('Postgres wal_level must be logical');
    const publication = await postgres.query('SELECT 1 FROM pg_publication WHERE pubname = $1', [spec.publication]);
    if (!publication.rowCount) {
      await postgres.query(`CREATE PUBLICATION ${identifier(spec.publication)} FOR TABLE ${spec.publicationTables.map(name => `public.${identifier(name)}`).join(', ')}`);
    }
    // Dedicated autocommit connection: logical slot creation must not run in a transaction.
    const slotClient = new Client(options(postgresUrl));
    try {
      await slotClient.connect();
      const slot = await slotClient.query('SELECT 1 FROM pg_replication_slots WHERE slot_name = $1', [spec.slot]);
      if (!slot.rowCount) await slotClient.query("SELECT pg_create_logical_replication_slot($1, 'pgoutput')", [spec.slot]);
    } finally { await slotClient.end(); }

    const existing = await risingwave.query('SELECT name, relation_type FROM rw_catalog.rw_relations WHERE name = ANY($1::varchar[])', [[spec.source, ...spec.requiredRelations]]);
    if (existing.rowCount) {
      const names = new Set(existing.rows.map(row => row.name));
      const missing = [spec.source, ...spec.requiredRelations].filter(name => !names.has(name));
      if (!missing.length) {
        console.log('RisingWave source and serving graph already exist; bootstrap skipped');
        return;
      }
      // Partially applied graph: resume in place instead of rebuilding. Each
      // remaining statement is executed with already-exists tolerance, so a
      // slow single-node RisingWave can converge across multiple restarts
      // without dropping and recreating the managed relations.
      console.log(`Partial RisingWave bootstrap (missing ${missing.length}); resuming in place`);
    }
    if (!existing.rows.some(row => row.name === spec.source)) {
      // Matches createCdcSource in bootstrap-risingwave-local.ts; empty password supports trust auth.
    await risingwave.query([
      `CREATE SOURCE ${spec.source} WITH (`,
      "  connector = 'postgres-cdc',",
      `  hostname = ${literal(process.env.RISINGWAVE_CDC_HOST ?? postgresUrl.hostname)},`,
      `  port = ${literal(process.env.RISINGWAVE_CDC_PORT ?? (postgresUrl.port || '5432'))},`,
      `  username = ${literal(process.env.RISINGWAVE_CDC_USERNAME ?? decodeURIComponent(postgresUrl.username))},`,
      `  password = ${literal(process.env.RISINGWAVE_CDC_PASSWORD ?? decodeURIComponent(postgresUrl.password))},`,
      "  database.name = 'slock',",
      "  schema.name = 'public',",
      `  slot.name = ${literal(spec.slot)},`,
      `  publication.name = ${literal(spec.publication)},`,
      "  publication.create.enable = 'false'",
      ')',
    ].join('\n'));
    }
    for (const [index, statement] of spec.statements.entries()) {
      try { await risingwave.query(statement); }
      catch (error) {
        // Idempotent resume: relations created by an earlier interrupted run
        // are reported as duplicates and are not fatal.
        if (/(already exists|is being created|with name \S+ exists)/i.test(error.message)) continue;
        throw new Error(`RisingWave statement ${index + 1}/${spec.statements.length}: ${error.message}`);
      }
    }
    console.log(`RisingWave bootstrap complete: ${spec.statements.length} statements`);
  } finally { await Promise.allSettled([postgres.end(), risingwave.end()]); }
}
// Also bound total bootstrap duration, including connection cleanup.
const timeout = setTimeout(() => { console.error('RisingWave bootstrap exceeded 2 hours'); process.exit(1); }, 7_200_000);
main().catch(error => {
  let message = error.message;
  for (const secret of [process.env.DATABASE_URL, process.env.RISINGWAVE_DATABASE_URL, process.env.RISINGWAVE_CDC_PASSWORD]) {
    if (secret) message = message.replaceAll(secret, '<redacted>');
  }
  console.error(`RisingWave bootstrap failed: ${message}`);
  process.exitCode = 1;
}).finally(() => clearTimeout(timeout));
