import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

export function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

export function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL in ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

export function ensureFile(filePath, content = '') {
  if (!fs.existsSync(filePath)) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

export function slugify(value, fallback = 'item') {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  return slug || fallback;
}

export function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function lockPayload() {
  return `${process.pid}:${Date.now()}`;
}

async function tryCreateLock(lockFile) {
  const handle = await fsp.open(lockFile, 'wx');
  await handle.writeFile(lockPayload(), 'utf8');
  return handle;
}

async function lockIsStale(lockFile, staleMs) {
  try {
    const stats = await fsp.stat(lockFile);
    return Date.now() - stats.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

export async function withFileLock(lockFile, action, options = {}) {
  const retryMs = options.retryMs ?? 120;
  const staleMs = options.staleMs ?? 120_000;
  const maxWaitMs = options.maxWaitMs ?? 45_000;
  const startedAt = Date.now();
  let lockHandle;

  while (true) {
    try {
      ensureDir(path.dirname(lockFile));
      lockHandle = await tryCreateLock(lockFile);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }

      if (await lockIsStale(lockFile, staleMs)) {
        try {
          await fsp.unlink(lockFile);
        } catch {
          // Another worker can acquire before unlink; ignore.
        }
      }

      if (Date.now() - startedAt > maxWaitMs) {
        throw new Error(`Timed out waiting for lock ${lockFile}`);
      }

      await sleep(retryMs);
    }
  }

  try {
    return await action();
  } finally {
    if (lockHandle) {
      try {
        await lockHandle.close();
      } catch {
        // Ignore close errors for stale lock recovery.
      }
    }
    try {
      await fsp.unlink(lockFile);
    } catch {
      // Lock may already be removed by process termination recovery.
    }
  }
}

export function defaultLearningsTemplate() {
  return `# Learnings\n\nPersistent append-only memory shared across journey runs.\n\n## Entities inferred\n\n## Capability expectations\n\n## Confirmed behaviors\n\n## Unconfirmed expectations\n\n## Risky-flow outcomes (Cancel vs Confirm)\n\n## Open hypotheses\n`;
}

export function ensureLearningsFile(learningsPath) {
  ensureFile(learningsPath, defaultLearningsTemplate());
}

function findSectionRange(lines, sectionName) {
  const heading = `## ${sectionName}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }

  return { start, end };
}

export async function appendLearning(learningsPath, lockPath, sectionName, message, meta = {}) {
  await withFileLock(lockPath, async () => {
    ensureLearningsFile(learningsPath);
    const content = await fsp.readFile(learningsPath, 'utf8');
    const lines = content.split('\n');

    const metaParts = [];
    if (meta.runId) {
      metaParts.push(`run=${meta.runId}`);
    }
    if (meta.journeyId) {
      metaParts.push(`journey=${meta.journeyId}`);
    }
    if (meta.url) {
      metaParts.push(`url=${meta.url}`);
    }

    const metaSuffix = metaParts.length ? ` (${metaParts.join(', ')})` : '';
    const entry = `- [${nowIso()}] ${message}${metaSuffix}`;

    let range = findSectionRange(lines, sectionName);

    if (!range) {
      if (lines[lines.length - 1] !== '') {
        lines.push('');
      }
      lines.push(`## ${sectionName}`);
      lines.push('');
      range = findSectionRange(lines, sectionName);
    }

    const insertionIndex = range.start + 2;
    lines.splice(insertionIndex, 0, entry);

    await fsp.writeFile(learningsPath, `${lines.join('\n').replace(/\n+$/, '\n')}\n`, 'utf8');
  });
}

export function mergeUniqueBy(items, keySelector) {
  const seen = new Set();
  const merged = [];

  for (const item of items) {
    const key = keySelector(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }

  return merged;
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function escapeMd(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
