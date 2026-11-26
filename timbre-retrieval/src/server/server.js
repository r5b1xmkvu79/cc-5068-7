import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import {
  PORT, ROOT, MANIFEST, INDEX_DIR, CORPUS_RAW, CORPUS_EQ,
  REPLACE_DIR, SR,
} from '../config.js';
import { search, adaptQuery } from '../core/retrieve.js';
import { buildReplacement } from '../core/replace.js';
import { readWav, toMono, writeWav } from '../dsp/wav.js';
import { resampleTo, trimSilence, rmsDb, equalizeLoudness } from '../dsp/loudness.js';
import { extractFeatures } from '../dsp/features.js';
import { fitStats, vectorize } from '../core/distance.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
};

const load = async (f) => JSON.parse(await readFile(f, 'utf8'));

// Cached in-memory index so clips imported at runtime survive across requests.
let indexCache = null;
const getIndex = async () => {
  if (!indexCache) indexCache = await load(path.join(INDEX_DIR, 'index.json'));
  return indexCache;
};

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // ---------- API ----------
    if (p.startsWith('/api/')) {
      const index = await getIndex();
      const manifest = await load(MANIFEST);

      if (p === '/api/state') {
        return json(res, 200, {
          clipCount: index.rows.length,
          trainGroups: index.trainGroups,
          testGroups: index.testGroups,
          keys: index.keys,
          nuisanceKeys: index.nuisanceKeys,
          clips: manifest.records.map((r) => ({
            id: r.id, group: r.group, kind: r.kind,
            prop: r.prop, force: r.force, gainTag: r.gainTag,
            pitchShift: r.pitchShift, excitation: r.excitation,
            rawRmsDb: r.rawRmsDb, eqRmsDb: r.eqRmsDb, duration: r.duration,
          })),
        });
      }

      if (p === '/api/features') {
        const id = url.searchParams.get('id');
        const mode = url.searchParams.get('mode') === 'raw' ? 'raw' : 'eq';
        const row = index.rows.find((r) => r.id === id);
        if (!row) return json(res, 404, { error: 'unknown id' });
        return json(res, 200, {
          id, mode,
          features: row[mode].features,
          curves: row[mode].curves,
        });
      }

      if (p === '/api/search' && req.method === 'POST') {
        const body = await readBody(req);
        const out = search(index, body.queryId, {
          target: body.target || 'general',
          loudnessMode: body.loudnessMode || 'eq',
          usePitch: body.usePitch !== false,
          useLoudness: body.useLoudness,
          metric: body.metric || 'euclidean',
          excludeGroups: body.excludeGroups || [],
          excludeIds: body.excludeIds,
        });
        // Attach neutral UI metadata; ground-truth labels stay off result cards.
        const meta = new Map(manifest.records.map((r) => [r.id, r]));
        out.results = out.results.map((r) => ({
          ...r,
          gainTag: meta.get(r.id)?.gainTag,
          duration: meta.get(r.id)?.duration,
          kind: meta.get(r.id)?.kind,
        }));
        return json(res, 200, out);
      }

      if (p === '/api/feedback' && req.method === 'POST') {
        // Failure/feedback loop: marks feed Rocchio and re-drive the same kernel.
        const body = await readBody(req);
        const adapted = adaptQuery(
          index, body.queryId,
          body.relevant || [], body.irrelevant || [],
          body.loudnessMode || 'eq',
          body.useLoudness ?? false,
        );
        const out = search(index, body.queryId, {
          target: body.target || 'general',
          loudnessMode: body.loudnessMode || 'eq',
          usePitch: body.usePitch !== false,
          useLoudness: body.useLoudness,
          metric: body.metric || 'euclidean',
          excludeGroups: body.excludeGroups || [],
          adaptedZ: adapted,
        });
        return json(res, 200, { adapted: true, ...out });
      }

      if (p === '/api/replace' && req.method === 'POST') {
        const body = await readBody(req);
        const events = (body.events || []).map((e) => ({ t: Number(e.t), queryId: e.queryId }));
        const summary = await buildReplacement(index, events, {
          target: body.target || 'general',
          loudnessMode: body.loudnessMode || 'eq',
          excludeGroups: body.excludeGroups || [],
        });
        await writeFile(path.join(REPLACE_DIR, 'placements.json'), JSON.stringify(summary, null, 2));
        return json(res, 200, summary);
      }

      if (p === '/api/import' && req.method === 'POST') {
        // Self-made recording entry point: raw WAV bytes in, analyzed with the
        // exact same pipeline; normalization uses the already-fitted train stats
        // so the new clip never re-fits anything.
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const wav = readWav(Buffer.concat(chunks));
        const mono = trimSilence(resampleTo(toMono(wav), wav.sampleRate), SR);
        const id = `user_${Date.now().toString(36)}`;
        const eq = equalizeLoudness(mono, -26).samples;
        await mkdir(CORPUS_RAW, { recursive: true });
        await writeFile(path.join(CORPUS_RAW, id + '.wav'), Buffer.from(writeWav(mono, SR, 16)));
        await writeFile(path.join(CORPUS_EQ, id + '.wav'), Buffer.from(writeWav(eq, SR, 16)));
        const fRaw = extractFeatures(mono, SR);
        const fEq = extractFeatures(eq, SR);
        const row = {
          id, group: id, kind: 'user',
          raw: { features: fRaw.features, curves: fRaw.curves, z: [], zLoud: [] },
          eq: { features: fEq.features, curves: fEq.curves, z: [], zLoud: [] },
        };
        row.raw.z = vectorize(row.raw.features).map((v, i) => (v - index.stats.raw.mean[i]) / index.stats.raw.std[i]);
        row.eq.z = vectorize(row.eq.features).map((v, i) => (v - index.stats.eq.mean[i]) / index.stats.eq.std[i]);
        row.raw.zLoud = vectorize(row.raw.features, index.nuisanceKeys.filter((k) => k !== 'duration'))
          .map((v, i) => (v - index.stats.loudRaw.mean[i]) / index.stats.loudRaw.std[i]);
        row.eq.zLoud = vectorize(row.eq.features, index.nuisanceKeys.filter((k) => k !== 'duration'))
          .map((v, i) => (v - index.stats.loudEq.mean[i]) / index.stats.loudEq.std[i]);
        index.rows.push(row);
        const out = search(index, id, { excludeGroups: [id] });
        return json(res, 200, { id, rmsDb: +rmsDb(mono).toFixed(2), search: out });
      }

      if (p === '/api/evaluation') {
        const report = await load(path.join(REPLACE_DIR, '..', 'evaluation', 'report.json'));
        return json(res, 200, report);
      }

      return json(res, 404, { error: 'unknown api route' });
    }

    // ---------- static ----------
    if (p.startsWith('/audio/')) {
      const mode = url.searchParams.get('mode') === 'raw' ? CORPUS_RAW : CORPUS_EQ;
      const name = path.basename(p.replace('/audio/', ''));
      const file = path.join(mode, name);
      if (!existsSync(file)) return json(res, 404, { error: 'no audio' });
      res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' });
      return createReadStream(file).pipe(res);
    }
    if (p === '/replacement.wav') {
      const file = path.join(REPLACE_DIR, 'door_replacement.wav');
      if (!existsSync(file)) return json(res, 404, { error: 'run replacement first' });
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return createReadStream(file).pipe(res);
    }

    const safe = p === '/' ? '/index.html' : p;
    const file = path.normalize(path.join(ROOT, 'web', safe));
    if (!file.startsWith(path.join(ROOT, 'web')) || !existsSync(file)) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    return createReadStream(file).pipe(res);
  } catch (err) {
    return json(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`timbre retrieval UI: http://localhost:${PORT}`);
});
