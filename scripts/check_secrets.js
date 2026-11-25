#!/usr/bin/env node
'use strict';
// Zero-dependency secret scanner. Exit 1 (printing file:line) on a match, 0 when clean.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = ['workflow', 'code', 'prompts', 'README.md', 'TEST_REPORT.md'];
const SKIP_FILES = new Set(['.env.example', 'scripts/check_secrets.js']);
const TEXT_EXT = new Set(['.js', '.json', '.md', '.txt', '.csv', '.py', '.yml', '.yaml', '.html', '']);

const PATTERNS = [
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'Groq key', re: /\bgsk_[A-Za-z0-9]{16,}/ },
  { name: 'Bearer token', re: /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/ },
  {
    name: 'Hardcoded credential assignment',
    re: /["']?(api[_-]?key|token|secret)["']?\s*[:=]\s*["'][A-Za-z0-9._/+=-]{12,}["']/i,
  },
];

function scanText(text, label) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const p of PATTERNS) {
      if (p.re.test(line)) hits.push({ file: label, line: i + 1, pattern: p.name });
    }
  });
  return hits;
}

function collect(target, out) {
  const abs = path.join(ROOT, target);
  if (!fs.existsSync(abs)) return;
  if (fs.statSync(abs).isDirectory()) {
    for (const f of fs.readdirSync(abs)) collect(path.join(target, f), out);
  } else if (TEXT_EXT.has(path.extname(abs).toLowerCase())) {
    out.push(target.split(path.sep).join('/'));
  }
}

function scanRepo() {
  const files = [];
  TARGETS.forEach((t) => collect(t, files));
  const hits = [];
  for (const f of files) {
    if (SKIP_FILES.has(f)) continue;
    hits.push(...scanText(fs.readFileSync(path.join(ROOT, f), 'utf8'), f));
  }
  return hits;
}

module.exports = { scanText, scanRepo, PATTERNS };

if (require.main === module) {
  const hits = scanRepo();
  if (hits.length) {
    hits.forEach((h) => console.error(`SECRET? ${h.file}:${h.line}  (${h.pattern})`));
    console.error(`\n${hits.length} potential secret(s) found.`);
    process.exit(1);
  }
  console.log('check:secrets OK - no secrets found.');
}
