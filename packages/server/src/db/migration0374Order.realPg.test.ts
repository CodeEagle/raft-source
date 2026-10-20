import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { classifyAdmission, readManifest, runPreflight } from "./migrationPreflight";

const url = process.env.MIGRATION_0374_ORDER_REAL_PG_URL;
const folder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const manifest = readManifest(folder);
const legacyTimes = [1792336010434, 1792336989784, 1792342433404, 1792343294410];
const legacyTargetTime = 1792395629764;
const journal = JSON.parse(readFileSync(path.join(folder, "meta/_journal.json"), "utf8"));

function fixture(stop: number, legacy = false): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "raft-0374-fixture-"));
  mkdirSync(path.join(root, "meta"));
  const entries = journal.entries.slice(0, stop + 1).map((entry: { idx: number; when: number; tag: string }) => ({
    ...entry, when: legacy && entry.idx >= 374 && entry.idx <= 377 ? legacyTimes[entry.idx - 374] : entry.when,
  }));
  for (const entry of entries) copyFileSync(path.join(folder, `${entry.tag}.sql`), path.join(root, `${entry.tag}.sql`));
  writeFileSync(path.join(root, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  return root;
}
async function database(run: (client: pg.Client, dbUrl: string) => Promise<void>) {
  const admin = new pg.Client({ connectionString: url });
  const name = `order0374_${randomBytes(6).toString("hex")}`;
  await admin.connect();
  let client: pg.Client | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const dbUrl = new URL(url!); dbUrl.pathname = `/${name}`;
    client = new pg.Client({ connectionString: dbUrl.toString() }); await client.connect();
    await run(client, dbUrl.toString());
  } finally {
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}
async function rows(client: pg.Client) {
  const result = await client.query('SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC, id DESC');
  return result.rows;
}
async function admitted(client: pg.Client) {
  const applied = (await rows(client)).map((row) => ({ hash: row.hash, createdAt: row.created_at }));
  return classifyAdmission(manifest, applied[0] ?? null, "60000", 60000, applied);
}
async function atTarget(client: pg.Client) {
  const applied = await rows(client);
  assert.equal(applied.length, manifest.length);
  assert.deepEqual(applied.map((row) => row.hash).sort(), manifest.map((entry) => entry.hash).sort());
  assert.equal(applied[0].hash, manifest.at(-1)!.hash);
  assert.equal(Number(applied[0].created_at), legacyTargetTime);
  assert.equal((await admitted(client)).code, "AT_TARGET_NOOP");
  const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
  for (const name of ["workspaces", "agent_request_acknowledgements", "channel_workspace_task_runs"]) {
    assert.ok(tables.rows.some((row) => row.table_name === name), name);
  }
  const columns = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name='channel_workspace_task_runs'");
  assert.ok(columns.rows.some((row) => row.column_name === "delegation"));
}

// Requires an explicitly isolated scratch PostgreSQL admin URL. Never uses DATABASE_URL.
describe.skipIf(!url)("0374 timestamp correction with canonical PostgreSQL migrator", () => {
  test("fresh database applies all migrations and a second run is a no-op", async () => database(async (client, dbUrl) => {
    assert.equal(classifyAdmission(manifest, null, "60000", 60000).code, "BEHIND_MIGRATE");
    await runPreflight({ DATABASE_URL: dbUrl, SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000" }, folder);
    await migrate(drizzle(client), { migrationsFolder: folder }); await atTarget(client);
    const before = await rows(client); await migrate(drizzle(client), { migrationsFolder: folder });
    assert.deepEqual(await rows(client), before);
  }));
  test("old upstream head 0373 applies every pending custom migration exactly once", async () => database(async (client, dbUrl) => {
    const seed = fixture(373);
    try { await migrate(drizzle(client), { migrationsFolder: seed }); } finally { rmSync(seed, { recursive: true }); }
    assert.equal((await rows(client)).length, 374);
    assert.equal((await admitted(client)).code, "BEHIND_MIGRATE");
    await runPreflight({ DATABASE_URL: dbUrl, SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000" }, folder);
    await migrate(drizzle(client), { migrationsFolder: folder }); await atTarget(client);
  }));
  test("legacy fully applied dev-shaped history retains its head and does not execute SQL or rewrite bookkeeping", async () => database(async (client, dbUrl) => {
    const seed = fixture(378, true);
    try { await migrate(drizzle(client), { migrationsFolder: seed }); } finally { rmSync(seed, { recursive: true }); }
    await atTarget(client);
    // The real dev ledger has fewer historical rows than today's manifest.
    // Its target head, rather than an exact row count, defines this no-op.
    await client.query('DELETE FROM drizzle.__drizzle_migrations WHERE id IN (SELECT id FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 38)');
    const before = await rows(client);
    assert.equal(before.length, manifest.length - 38);
    assert.equal((await admitted(client)).code, "AT_TARGET_NOOP");
    for (let i = 374; i <= 377; i++) {
      assert.equal(Number(before.find((row) => row.hash === manifest[i].hash)!.created_at), legacyTimes[i - 374]);
    }
    await runPreflight({ DATABASE_URL: dbUrl, SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000" }, folder);
    await migrate(drizzle(client), { migrationsFolder: folder });
    assert.deepEqual(await rows(client), before);
  }));
  test("legacy partial history hidden below upstream head is rejected before SQL can be repeated", async () => database(async (client, dbUrl) => {
    const seed = fixture(377, true);
    try { await migrate(drizzle(client), { migrationsFolder: seed }); } finally { rmSync(seed, { recursive: true }); }
    const before = await rows(client);
    assert.equal(before[0].hash, manifest[373].hash);
    assert.equal((await admitted(client)).code, "PENDING_ALREADY_APPLIED");
    const result = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", "scripts/migration-preflight.ts"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8",
      env: { ...process.env, DATABASE_URL: dbUrl, MIGRATIONS_FOLDER: folder, SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000" },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /PENDING_ALREADY_APPLIED/);
    assert.deepEqual(await rows(client), before);
  }));
});
