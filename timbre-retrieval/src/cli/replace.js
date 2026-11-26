import { readFile } from 'node:fs/promises';
import { MANIFEST } from '../config.js';
import { buildIndex } from '../core/index.js';
import { buildReplacement } from '../core/replace.js';

const idx = await buildIndex();
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));

// Three door events in the "film": a light tap, a heavy slam, another light tap.
const pick = (prop, force, tag = 'hi') =>
  manifest.records.find((r) => r.kind === 'main' && r.prop === prop && r.force === force && r.gainTag === tag);

const events = [
  { t: 1.0, queryId: pick('P1', 'light').id },
  { t: 3.2, queryId: pick('P2', 'heavy').id },
  { t: 5.4, queryId: pick('P1', 'light', 'lo').id },
];

const summary = await buildReplacement(idx, events, {
  target: 'general',
  loudnessMode: 'eq',
  excludeGroups: events.map((e) => manifest.records.find((r) => r.id === e.queryId).group),
});
console.log('replacement track written:', summary.file);
for (const p of summary.placements) {
  console.log(`  t=${p.eventTime}s  query ${p.query} -> ${p.replacement} (sim=${p.similarity})`);
}
