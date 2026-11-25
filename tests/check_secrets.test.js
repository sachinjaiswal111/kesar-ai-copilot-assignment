'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scanText } = require('../scripts/check_secrets.js');

// Fake keys are assembled at runtime so this file never contains a matching literal.
const fakeGoogle = 'AI' + 'za' + 'A'.repeat(35);
const fakeAnthropic = 'sk-' + 'ant-' + 'x'.repeat(20);

test('catches a synthetic Google API key with file + line', () => {
  const hits = scanText(`line one\nkey = ${fakeGoogle}\n`, 'x.js');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].line, 2);
  assert.strictEqual(hits[0].file, 'x.js');
});

test('catches Anthropic key, Bearer token and hardcoded assignment', () => {
  assert.ok(scanText(fakeAnthropic, 'a').length > 0);
  assert.ok(scanText('Authorization: Bearer abcdef1234567890xyz', 'a').length > 0);
  assert.ok(scanText('const api_key = "abcdef1234567890abcd";', 'a').length > 0);
});

test('passes on clean content', () => {
  const clean = 'Use the n8n Credentials Manager.\nconst intent = "order_status";\nBearer tokens are never stored here.\n';
  assert.deepStrictEqual(scanText(clean, 'clean.md'), []);
});
