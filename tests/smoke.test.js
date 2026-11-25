'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const p = (f) => path.join(root, f);
const readJson = (f) => JSON.parse(fs.readFileSync(p(f), 'utf8'));

test('required repo files exist', () => {
  for (const f of ['data/orders.json', 'data/test_emails.json', 'data/faq.md', 'data/brand_voice.md', 'schemas/llm_output.schema.json']) {
    assert.ok(fs.existsSync(p(f)), `missing ${f}`);
  }
});

test('orders.json has 15 orders', () => {
  assert.strictEqual(readJson('data/orders.json').orders.length, 15);
});

test('test_emails.json has 25 emails', () => {
  assert.strictEqual(readJson('data/test_emails.json').emails.length, 25);
});

test('markdown data files are non-empty', () => {
  for (const f of ['data/faq.md', 'data/brand_voice.md']) {
    assert.ok(fs.readFileSync(p(f), 'utf8').trim().length > 0, f);
  }
});

test('llm_output schema parses with required fields', () => {
  const s = readJson('schemas/llm_output.schema.json');
  assert.strictEqual(s.type, 'object');
  assert.deepStrictEqual(
    [...s.required].sort(),
    ['confidence', 'intent', 'language', 'order_id', 'secondary_intent', 'sentiment', 'summary']
  );
});

test('template CSVs have 18 audit-log and 11 tickets columns', () => {
  const cols = (f) => fs.readFileSync(p(f), 'utf8').split(/\r?\n/)[0].split(',').length;
  assert.strictEqual(cols('templates/audit_log_template.csv'), 18);
  assert.strictEqual(cols('templates/tickets_template.csv'), 11);
});
