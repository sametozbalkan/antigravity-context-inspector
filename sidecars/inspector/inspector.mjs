#!/usr/bin/env node
/**
 * CLI entrypoint for Antigravity Context Inspector.
 *
 * Reads ~/.gemini/antigravity/conversations/<uuid>.db (read-only) and outputs
 * either a concise CLI summary or a structured JSON snapshot.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { UUID_RE } from './lib/accounting.mjs';
import { buildSnapshot } from './lib/snapshot.mjs';

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function usageText() {
  return [
    'Usage: inspector.mjs [options]',
    '',
    'Options:',
    '  --db <path>               Path to a conversation .db file',
    '  --conversation-id <uuid>  Conversation UUID (latest if omitted)',
    '  --workspace <path>        Active workspace folder path',
    '  --model-catalog <path>    Path to cached model catalog JSON',
    '  --json                    Output structured JSON snapshot',
    '  -h, --help                Show this help message',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    db: null,
    conversationId: null,
    workspace: null,
    modelCatalog: null,
    json: false,
    help: false,
  };

  const valueFlags = new Map([
    ['--db', 'db'],
    ['--conversation-id', 'conversationId'],
    ['--workspace', 'workspace'],
    ['--model-catalog', 'modelCatalog'],
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }

    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      const flag = arg.slice(0, eqIdx);
      const val = arg.slice(eqIdx + 1);
      const key = valueFlags.get(flag);
      if (!key) {
        return { error: `Unknown argument: ${arg}` };
      }
      opts[key] = val;
      continue;
    }

    const key = valueFlags.get(arg);
    if (key) {
      if (i + 1 >= argv.length) {
        return { error: `Missing value for ${arg}` };
      }
      opts[key] = argv[i + 1];
      i += 1;
      continue;
    }

    return { error: `Unknown argument: ${arg}` };
  }

  return { opts };
}

function findLatestDb(convDir) {
  let entries;
  try {
    entries = fs.readdirSync(convDir);
  } catch {
    return null;
  }

  let bestPath = null;
  let bestMtime = -Infinity;
  for (const name of entries) {
    if (!name.endsWith('.db')) continue;
    const full = path.join(convDir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        bestPath = full;
      }
    } catch {
      // ignore entries that vanish or cannot be stat'd
    }
  }
  return bestPath;
}

export function main(argv = process.argv.slice(2)) {
  const { opts, error } = parseArgs(argv);
  if (error) {
    process.stderr.write(`${error}\n`);
    process.exit(2);
  }

  if (opts.help) {
    process.stdout.write(`${usageText()}\n`);
    return;
  }

  let dbPath;
  if (opts.db) {
    dbPath = expandHome(opts.db);
  } else {
    const geminiBase = process.env.ANTIGRAVITY_GEMINI_DIR
      ? expandHome(process.env.ANTIGRAVITY_GEMINI_DIR)
      : path.join(os.homedir(), '.gemini');
    const convDir = path.join(geminiBase, 'antigravity', 'conversations');
    if (opts.conversationId) {
      if (!UUID_RE.test(opts.conversationId)) {
        process.stderr.write(`Invalid conversation ID: ${opts.conversationId}\n`);
        process.exit(1);
      }
      dbPath = path.join(convDir, `${opts.conversationId}.db`);
    } else {
      const latest = findLatestDb(convDir);
      if (!latest) {
        process.stderr.write('No conversation databases found.\n');
        process.exit(1);
      }
      dbPath = latest;
    }
  }

  if (!isFile(dbPath)) {
    process.stderr.write(`Conversation database not found: ${dbPath}\n`);
    process.exit(1);
  }

  const snapshot = buildSnapshot(dbPath, opts.workspace, opts.modelCatalog);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  } else {
    process.stdout.write(`${snapshot.summary.cli_text}\n`);
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(fileURLToPath(import.meta.url)) ===
      fs.realpathSync(path.resolve(process.argv[1]))
    );
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main();
}
