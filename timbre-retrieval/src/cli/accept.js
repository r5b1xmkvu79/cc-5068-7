// Acceptance CLI — an AUXILIARY entry point. The primary interface for the
// acceptance workflow is the graphical UI (see README: 图形入口).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { MANIFEST } from '../config.js';
import { buildCorpus } from './build.js';
import { buildIndex } from '../core/index.js';
import { buildQuerySet } from '../accept/queryset.js';
import { runAcceptance, decidePublish } from '../accept/gate.js';

if (!existsSync(MANIFEST)) {
  console.log('corpus missing — building it first (npm run build does this too)');
  await buildCorpus();
}
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));

console.log('[1/3] indexing (train groups only)...');
const index = await buildIndex();

console.log('[2/3] building separated query set (segments / re-recordings / hard negatives / invalid / duplicates)...');
const queryset = await buildQuerySet();

console.log('[3/3] running acceptance gate...');
const report = await runAcceptance({ index, manifest, queryset });
const decision = await decidePublish(report);

const m = report.metrics;
console.log(`  dedup           : ${m.dedup.pass}/${m.dedup.n} segments retrieve their source recording`);
console.log(`  generalization  : ${m.generalization.pass}/${m.generalization.n} unseen-performer re-recordings (top-1 prop ${m.generalization.top1})`);
console.log(`  hard negatives  : ${m.hardNegative.pass}/${m.hardNegative.n}`);
console.log(`  invalid inputs  : ${m.invalid.rejected}/${m.invalid.n} rejected`);
console.log(`  duplicates      : ${m.duplicates.detected} detected and de-counted`);
console.log(`  index consistent: ${report.consistency.ok}`);
if (report.loudnessSwap.firstReversedClass) {
  console.log(`  loudness-swap diagnostic: ${report.loudnessSwap.firstReversedClass} ranking reverses first`
    + ` (independent expectation: ${report.loudnessSwap.independentExpectation.victim ?? 'n/a'})`);
}
console.log(decision.decision === 'published'
  ? `\nPUBLISHED -> data/accept/published/index.json`
  : `\nREJECTED (${decision.reasons.length} findings)`);
for (const r of decision.reasons.slice(0, 12)) console.log(`  - ${r}`);
process.exit(decision.decision === 'published' ? 0 : 1);
