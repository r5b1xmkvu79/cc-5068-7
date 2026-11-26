import { readFile } from 'node:fs/promises';
import { MANIFEST } from '../config.js';
import { buildCorpus } from './build.js';
import { buildIndex } from '../core/index.js';
import { writeReport } from '../core/evaluate.js';
import { buildReplacement } from '../core/replace.js';

console.log('[1/4] building corpus...');
const manifest = await buildCorpus();
console.log(`      ${manifest.count} clips / ${manifest.groups.length} source groups`);

console.log('[2/4] extracting features and fitting index (train groups only)...');
const idx = await buildIndex();

console.log('[3/4] grouped evaluation...');
const report = await writeReport(idx, JSON.parse(await readFile(MANIFEST, 'utf8')));
console.log(`      prop top1 (eq/raw): ${report.generalTarget.equalized.propIdentity.top1} / ${report.generalTarget.dynamicsPreserved.propIdentity.top1}`);
console.log(`      force top1 (eq/raw): ${report.generalTarget.equalized.actionForce.top1} / ${report.generalTarget.dynamicsPreserved.actionForce.top1}`);

console.log('[4/4] rendering door replacement track...');
const pick = (prop, force, tag = 'hi') =>
  manifest.records.find((r) => r.kind === 'main' && r.prop === prop && r.force === force && r.gainTag === tag);
const events = [
  { t: 1.0, queryId: pick('P1', 'light').id },
  { t: 3.2, queryId: pick('P2', 'heavy').id },
  { t: 5.4, queryId: pick('P1', 'light', 'lo').id },
];
await buildReplacement(idx, events, {
  loudnessMode: 'eq',
  excludeGroups: events.map((e) => manifest.records.find((r) => r.id === e.queryId).group),
});
console.log('done. start the UI with: npm run serve');
