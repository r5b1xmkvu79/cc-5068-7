// Shared fixture: builds the corpus, the index, and the separated query set
// once per test process, and runs the acceptance gate on the clean artifacts.
import { readFile } from 'node:fs/promises';
import { MANIFEST } from '../../src/config.js';
import { buildCorpus } from '../../src/cli/build.js';
import { buildIndex } from '../../src/core/index.js';
import { buildQuerySet } from '../../src/accept/queryset.js';
import { runAcceptance } from '../../src/accept/gate.js';

let cached = null;

export async function getFixture() {
  if (cached) return cached;
  await buildCorpus();
  const index = await buildIndex();
  const queryset = await buildQuerySet();
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const report = await runAcceptance({ index, manifest, queryset });
  cached = { manifest, index, queryset, report };
  return cached;
}
