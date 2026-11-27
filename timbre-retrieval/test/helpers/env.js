// MUST be imported before any src/ module: points the data dir at a fresh
// throwaway location so tests never touch the real data/ directory.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TIMBRE_DATA_DIR = mkdtempSync(join(tmpdir(), 'timbre-accept-'));
