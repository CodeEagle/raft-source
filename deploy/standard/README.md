# Standard self hosting

Requires Docker Compose, Git and Node; lzc-cli is not required. Build from the checked out commit:

```
node scripts/deploy-target.mjs build --target standard --ref HEAD
cp deploy/standard/.env.example deploy/standard/.env
```

Set independent secrets and APP_URL in `.env` (restrict its permissions to 0600).
Use URL-safe characters for the database password. Copy the image IDs from the generated manifest into `.env` for manual Compose operations.

The standard entrypoint does not migrate or bootstrap databases. Before the first deployment, start dependencies, run the repository migration preflight/deploy with the server image, and initialize the RisingWave SQL for this release (see `infra/risingwave/sql` and `scripts/dev/raftdev-risingwave-bootstrap.ts`). Do this before serving traffic; this example is not an automatic provisioning system.

```
docker compose --env-file deploy/standard/.env -f deploy/standard/compose.yml up -d postgres risingwave
node scripts/deploy-target.mjs deploy --target standard --env local --artifact <artifact-manifest.json>
```

Web listens on localhost:8080 and proxies same-origin API/WebSockets. For remote use put it behind a TLS reverse proxy, set APP_URL to the external URL, and preserve WebSocket upgrades. Redis is optional and omitted. Persist and back up all three named volumes. The wrapper checks both local image IDs before deploying and never rebuilds during deployment.
