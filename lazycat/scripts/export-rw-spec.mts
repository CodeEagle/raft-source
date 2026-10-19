import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RISINGWAVE_BOOTSTRAP_ARTIFACTS, RISINGWAVE_CDC_TABLES,
  RISINGWAVE_PUBLICATION_TABLES, RISINGWAVE_LOCAL_SOURCE,
  RISINGWAVE_LOCAL_PUBLICATION, RISINGWAVE_LOCAL_SLOT,
  RISINGWAVE_REQUIRED_RELATIONS, buildRisingWaveBootstrapStatements,
} from '../../scripts/dev/raftdev-risingwave-bootstrap.ts';

// Use the canonical selector, splitter, source rewrite and dependency order at build time.
const artifacts = Object.fromEntries(RISINGWAVE_BOOTSTRAP_ARTIFACTS.map(artifact => [
  artifact.file, readFileSync(new URL(`../../${artifact.file}`, import.meta.url), 'utf8'),
]));
writeFileSync(fileURLToPath(new URL('./rw-bootstrap-spec.json', import.meta.url)), JSON.stringify({
  source: RISINGWAVE_LOCAL_SOURCE,
  publication: RISINGWAVE_LOCAL_PUBLICATION,
  slot: RISINGWAVE_LOCAL_SLOT,
  publicationTables: RISINGWAVE_PUBLICATION_TABLES,
  cdcTables: RISINGWAVE_CDC_TABLES,
  artifacts: RISINGWAVE_BOOTSTRAP_ARTIFACTS,
  requiredRelations: RISINGWAVE_REQUIRED_RELATIONS,
  statements: buildRisingWaveBootstrapStatements(artifacts),
}, null, 2) + '\n');
