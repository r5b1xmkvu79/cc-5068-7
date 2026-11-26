import { buildIndex } from '../core/index.js';

const idx = await buildIndex();
console.log(`index: ${idx.rows.length} clips, ${idx.trainGroups.length} train groups`);
console.log('data/index/index.json');
