import { readFile } from 'node:fs/promises';
import { MANIFEST, EVAL_DIR } from '../config.js';
import { buildIndex } from '../core/index.js';
import { writeReport } from '../core/evaluate.js';

const idx = await buildIndex();
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const report = await writeReport(idx, manifest);

const line = (name, m) =>
  console.log(`${name.padEnd(14)} top1=${m.top1}  top3=${m.top3}  top5=${m.top5}  MRR=${m.mrr}`);
console.log('\nGeneral timbre target, grouped leave-one-out:');
console.log('  loudness-equalized index:');
line('  prop', report.generalTarget.equalized.propIdentity);
line('  force', report.generalTarget.equalized.actionForce);
console.log('  dynamics-preserved index:');
line('  prop', report.generalTarget.dynamicsPreserved.propIdentity);
line('  force', report.generalTarget.dynamicsPreserved.actionForce);
console.log('\nTargeted weighting (equalized):');
for (const t of ['prop', 'force']) {
  console.log(`  target=${t}`);
  line('  prop', report.targeted[t].propIdentity);
  line('  force', report.targeted[t].actionForce);
}
console.log('\nGain isolation (top-5 gain purity; 0.5 = gain ignored):',
  JSON.stringify(report.gainExperiment.gainPurityTop5));
console.log('Same-source twin mean rank (1 = best):',
  JSON.stringify(report.gainExperiment.sameSourceTwinMeanRank));
console.log('Held-out first-candidate checks:',
  report.heldoutCheck.map((h) => `${h.query}: prop=${h.propOk} force=${h.forceOk}`).join(' | '));
console.log(`\nfull report: ${EVAL_DIR}/report.json`);
