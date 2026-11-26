'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { evaluateEligibility, detectOpenedOrUsed } = require('../code/evaluate_eligibility.js');
const { prepareTicketAction } = require('../code/prepare_ticket_action.js');
const { prepareAuditRow, unwrapObservation, COLUMNS } = require('../code/prepare_audit_row.js');
const { normalizeEmail } = require('../code/normalize_email.js');

const orders = JSON.parse(fs.readFileSync(path.join(root, 'data/orders.json'), 'utf8')).orders;
const emails = JSON.parse(fs.readFileSync(path.join(root, 'data/test_emails.json'), 'utf8')).emails;
const raw = (id) => emails.find((e) => e.id === id);

// Context as it looks after Validate Classification (classifier fields supplied by the test).
const ctx = (id, extra = {}) => ({ ...normalizeEmail(raw(id)), ...extra });
const evalFor = (id, extra = {}) => evaluateEligibility({ emailData: ctx(id, extra), orders });
const NOW = '2026-11-20T10:00:00.000Z';

// ---------------- evaluateEligibility: damaged / wrong / missing ----------------

test('eligibility: E04 damaged within 48h, no photos yet -> eligible, photos required, High', () => {
  const r = evalFor('E04', { intent: 'complaint', order_id: 'KC-1052', sentiment: 'neutral' }).eligibility;
  assert.strictEqual(r.case_type, 'damaged_wrong_missing');
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.requires_photos, true);
  assert.strictEqual(r.photos_provided, false);
  assert.strictEqual(r.refundable_amount, 1598);
  assert.strictEqual(r.ticket_priority, 'High');
  assert.strictEqual(r.days_since_delivery, 1);
  assert.ok(r.hours_since_delivery <= 48);
});

test('eligibility: E21 follow-up with photos -> photos_provided true', () => {
  const r = evalFor('E21', { intent: 'complaint', order_id: 'KC-1052' }).eligibility;
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.photos_provided, true);
  assert.ok(r.reasons.join(' ').includes('cracked_jar.jpg'));
});

test('eligibility: E08 angry leak -> eligible, High, needs human', () => {
  const r = evalFor('E08', { intent: 'complaint', order_id: 'KC-1051', sentiment: 'angry' }).eligibility;
  assert.strictEqual(r.case_type, 'damaged_wrong_missing');
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.refundable_amount, 1498);
  assert.strictEqual(r.ticket_priority, 'High');
  assert.strictEqual(r.needs_human_from_eligibility, true);
});

test('eligibility: E14 wrong item -> damaged_wrong_missing, full refund or replacement', () => {
  const r = evalFor('E14', { intent: 'complaint', order_id: 'KC-1053' }).eligibility;
  assert.strictEqual(r.case_type, 'damaged_wrong_missing');
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.refundable_amount, 1398);
  assert.strictEqual(r.requires_photos, true);
});

test('eligibility: E23 missing item -> eligible, no order-total refund quoted', () => {
  const r = evalFor('E23', { intent: 'complaint', order_id: 'KC-1054' }).eligibility;
  assert.strictEqual(r.case_type, 'damaged_wrong_missing');
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.refundable_amount, null);
  assert.strictEqual(r.order_total, 1798);
  assert.ok(r.missing_item_note);
});

test('eligibility: damaged report outside 48h is not eligible', () => {
  const e = ctx('E04', { intent: 'complaint', order_id: 'KC-1052', received_at: '2026-11-22T09:00:00+05:30' });
  const r = evaluateEligibility({ emailData: e, orders }).eligibility;
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.needs_human_from_eligibility, true);
});

// ---------------- evaluateEligibility: standard returns ----------------

test('eligibility: E03 sealed toner, 4 days -> eligible, refund subtotal 899, 79 non-refundable', () => {
  const r = evalFor('E03', { intent: 'return_refund', order_id: 'KC-1047' }).eligibility;
  assert.strictEqual(r.case_type, 'standard_return');
  assert.strictEqual(r.days_since_delivery, 4);
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.refundable_amount, 899);
  assert.strictEqual(r.non_refundable_fees, 79);
  assert.strictEqual(r.ticket_priority, 'Medium');
  assert.strictEqual(r.kit_rule_note, null);
});

test('eligibility: E11 Bridal Glow Kit unopened -> eligible with complete-set note', () => {
  const r = evalFor('E11', { intent: 'return_refund', order_id: 'KC-1048' }).eligibility;
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.refundable_amount, 3499);
  assert.ok(r.kit_rule_note.includes('complete set'));
});

test('eligibility: E12 used + 8 days + injection -> ineligible, High, never approved', () => {
  const r = evalFor('E12', { intent: 'return_refund', order_id: 'KC-1055', prompt_injection_detected: true }).eligibility;
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.days_since_delivery, 8);
  assert.strictEqual(r.ticket_priority, 'High');
  assert.strictEqual(r.needs_human_from_eligibility, true);
  assert.ok(r.reasons.join(' ').includes('7-day'));
});

test('eligibility: E16 used for two weeks -> ineligible, Low', () => {
  const r = evalFor('E16', { intent: 'complaint', order_id: 'KC-1049', sentiment: 'negative' }).eligibility;
  assert.strictEqual(r.case_type, 'standard_return'); // complaint label alone must not force the damaged path
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.ticket_priority, 'Low');
});

test('eligibility: E19 COD unopened, 3 days -> eligible, UPI/bank after pickup, 49 non-refundable', () => {
  const r = evalFor('E19', { intent: 'return_refund', order_id: 'KC-1050' }).eligibility;
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.refundable_amount, 1648);
  assert.strictEqual(r.non_refundable_fees, 49);
  assert.strictEqual(r.payment_method, 'cod');
  assert.match(r.refund_method_note, /UPI or bank transfer AFTER reverse pickup/);
});

test('eligibility: privacy mismatch returns no order data', () => {
  const e = ctx('E04', { intent: 'complaint', order_id: 'KC-1047' }); // E04 sender asking about another customer's order
  const r = evaluateEligibility({ emailData: e, orders }).eligibility;
  assert.strictEqual(r.privacy_blocked, true);
  assert.strictEqual(r.order_found, false);
  assert.strictEqual(r.resolved_order_id, null);
  assert.strictEqual(r.refundable_amount, null);
});

test('detectOpenedOrUsed: unopened vs used wording', () => {
  for (const t of ['It is still sealed, never opened', 'Both are unopened', 'all seals intact', "I haven't used it, seal intact", 'unused']) {
    assert.strictEqual(detectOpenedOrUsed(t), false, t);
  }
  for (const t of ['Used them for a few days', 'I have been using it', "it didn't suit my skin", 'I see no difference']) {
    assert.strictEqual(detectOpenedOrUsed(t), true, t);
  }
});

// ---------------- prepareTicketAction ----------------

const ticketCtx = (id, extra) => evalFor(id, extra);

test('tickets: E04 on empty sheet -> create TKT-001 with all 11 columns', () => {
  const c = ticketCtx('E04', { intent: 'complaint', order_id: 'KC-1052', summary: 'Cracked jar' });
  const r = prepareTicketAction({ contextData: c, existingTickets: [], nowIso: NOW });
  assert.strictEqual(r.ticket_action, 'create');
  assert.strictEqual(r.ticket_id, 'TKT-001');
  const header = fs.readFileSync(path.join(root, 'templates/tickets_template.csv'), 'utf8').split(/\r?\n/)[0].split(',');
  assert.deepStrictEqual(Object.keys(r.ticket_row), header);
  assert.strictEqual(r.ticket_row.status, 'Open');
  assert.strictEqual(r.ticket_row.priority, 'High');
  assert.strictEqual(r.ticket_row.email_ids, 'E04');
  assert.strictEqual(r.ticket_row.order_id, 'KC-1052');
});

test('tickets: E21 dedupes into E04 ticket (update, merged email_ids, notes with attachments) and is idempotent', () => {
  const t1 = prepareTicketAction({ contextData: ticketCtx('E04', { intent: 'complaint', order_id: 'KC-1052', summary: 'Cracked jar' }), existingTickets: [], nowIso: NOW }).ticket_row;
  const c21 = ticketCtx('E21', { intent: 'complaint', order_id: 'KC-1052', summary: 'Follow-up with photos' });
  const r = prepareTicketAction({ contextData: c21, existingTickets: [t1], nowIso: '2026-11-20T11:00:00.000Z' });
  assert.strictEqual(r.ticket_action, 'update');
  assert.strictEqual(r.ticket_id, 'TKT-001');
  assert.strictEqual(r.ticket_row.email_ids, 'E04, E21');
  assert.strictEqual(r.ticket_row.created_at, NOW);
  assert.strictEqual(r.ticket_row.updated_at, '2026-11-20T11:00:00.000Z');
  assert.ok(r.ticket_row.notes.includes('[E04]') && r.ticket_row.notes.includes('[E21]'));
  assert.ok(r.ticket_row.notes.includes('cracked_jar.jpg'));

  const again = prepareTicketAction({ contextData: c21, existingTickets: [r.ticket_row], nowIso: '2026-11-20T12:00:00.000Z' });
  assert.strictEqual(again.ticket_action, 'update');
  assert.strictEqual(again.ticket_row.email_ids, 'E04, E21');
  assert.strictEqual(again.ticket_row.notes, r.ticket_row.notes);
});

test('tickets: priority only escalates upward on update', () => {
  const existing = { ticket_id: 'TKT-004', created_at: NOW, updated_at: NOW, order_id: 'KC-1047', customer_email: 'kavya.reddy@example.com', email_ids: 'E03', intent: 'return_refund', priority: 'High', status: 'Open', summary: 's', notes: '[E03] x' };
  const low = { ...ticketCtx('E03', { intent: 'return_refund', order_id: 'KC-1047' }), email_id: 'E99' };
  low.eligibility.ticket_priority = 'Low';
  assert.strictEqual(prepareTicketAction({ contextData: low, existingTickets: [existing], nowIso: NOW }).ticket_row.priority, 'High');
});

test('tickets: a Closed ticket does not block a new one; next id continues the sequence', () => {
  const closed = { ticket_id: 'TKT-007', order_id: 'KC-1052', status: 'Closed', email_ids: 'E04', priority: 'High', notes: '' };
  const r = prepareTicketAction({ contextData: ticketCtx('E21', { intent: 'complaint', order_id: 'KC-1052' }), existingTickets: [closed], nowIso: NOW });
  assert.strictEqual(r.ticket_action, 'create');
  assert.strictEqual(r.ticket_id, 'TKT-008');
  assert.strictEqual(r.ticket_row.email_ids, 'E21');
});

// ---------------- prepareAuditRow with n8n-wrapped observations ----------------

const payload = { status: 'FOUND', order_found: true, lookup_method: 'sender_email', order: { order_id: 'KC-1044', status: 'shipped' } };
const wrapped = JSON.stringify([{ response: JSON.stringify(payload) }]);

test('unwrapObservation: array/object/string wrappers all yield the payload', () => {
  assert.deepStrictEqual(unwrapObservation(wrapped), payload);
  assert.deepStrictEqual(unwrapObservation({ response: JSON.stringify(payload) }), payload);
  assert.deepStrictEqual(unwrapObservation([{ response: payload }]), payload);
  assert.deepStrictEqual(unwrapObservation(JSON.stringify(payload)), payload);
  assert.deepStrictEqual(unwrapObservation(JSON.stringify(JSON.stringify(payload))), payload);
  assert.strictEqual(unwrapObservation('not json'), null);
  assert.strictEqual(unwrapObservation(undefined), null);
});

test('audit: wrapped get_order observation -> order_found true, KC-1044, no tool_error', () => {
  const classification = { ...normalizeEmail(raw('E10')), intent: 'order_status', secondary_intent: null, order_id: null, language: 'en', sentiment: 'neutral', confidence: 0.9, needs_human: false, validation_notes: [] };
  const steps = [
    { action: { tool: 'get_order', toolInput: { query: 'by sender email' } }, observation: wrapped },
    { action: { tool: 'search_faq', toolInput: { query: 'x' } }, observation: JSON.stringify([{ response: JSON.stringify({ found: true, matched_sections: [] }) }]) },
  ];
  const row = prepareAuditRow({
    classification,
    agentOutput: { output: 'Hi Vikram,\n\nYour order is on its way.\n\nWarm regards,\nTeam Kesar\n---AGENT_META---\n{"escalate": false, "reason": ""}' },
    intermediateSteps: steps,
    processedAt: NOW,
  });
  assert.strictEqual(row.order_found, true);
  assert.strictEqual(row.order_id, 'KC-1044');
  assert.ok(!/tool_error/.test(row.notes), row.notes);
  assert.ok(row.notes.includes('get_order: FOUND'));
  assert.ok(row.notes.includes('search_faq: found'));
  assert.strictEqual(row.needs_human, false);
  assert.strictEqual(row.action_taken, 'drafted_reply');
  assert.strictEqual(row.prompt_version, 'v2');
  assert.strictEqual(row.email_id, 'E10');
  assert.deepStrictEqual(Object.keys(row), COLUMNS);
});

test('audit: agent error on a ticket branch keeps email_id, from_email, prompt_version, ticket_id', () => {
  const classification = { ...normalizeEmail(raw('E08')), intent: 'complaint', secondary_intent: null, order_id: 'KC-1051', language: 'en', sentiment: 'angry', confidence: 0.95, needs_human: false };
  const row = prepareAuditRow({ classification, agentOutput: { error: 'Gemini 503' }, ticketId: 'TKT-002', processedAt: NOW });
  assert.strictEqual(row.email_id, 'E08');
  assert.strictEqual(row.from_email, 'riya.kapoor@example.com');
  assert.strictEqual(row.prompt_version, 'v2');
  assert.strictEqual(row.ticket_id, 'TKT-002');
  assert.strictEqual(row.needs_human, true);
  assert.match(row.error, /agent error/);
});

// ---------------- n8n entry blocks ----------------

test('code files: no ESM syntax and n8n tool/eligibility entries use the async IIFE', () => {
  for (const f of ['tool_get_order', 'tool_search_faq', 'evaluate_eligibility']) {
    const src = fs.readFileSync(path.join(root, `code/${f}.js`), 'utf8');
    assert.match(src, /return \(async \(\) => \{/, f);
    assert.doesNotMatch(src, /^\s*(import|export)\s/m, f);
  }
});
