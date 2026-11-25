'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { lookupOrder, computeDeliveryElapsed } = require('../code/tool_get_order.js');
const { parseFaqSections, searchFaq } = require('../code/tool_search_faq.js');
const { prepareAuditRow, COLUMNS } = require('../code/prepare_audit_row.js');
const { normalizeEmail } = require('../code/normalize_email.js');
const { validateClassification } = require('../code/validate_classification.js');

const orders = JSON.parse(fs.readFileSync(path.join(root, 'data/orders.json'), 'utf8')).orders;
const faq = fs.readFileSync(path.join(root, 'data/faq.md'), 'utf8');
const emails = JSON.parse(fs.readFileSync(path.join(root, 'data/test_emails.json'), 'utf8')).emails;
const email = (id) => emails.find((e) => e.id === id);
const sectionNums = (r) => r.matched_sections.map((s) => Number(s.title.split('.')[0]));

// Look up as the workflow would: trusted sender + received_at from the email itself.
const lookup = (id, query, classifiedOrderId = null) => {
  const e = email(id);
  return lookupOrder({ query, verifiedSenderEmail: e.from.email, receivedAt: e.received_at, orders, classifiedOrderId });
};

// ---------------- get_order ----------------

test('get_order: E01 found by order ID', () => {
  const r = lookup('E01', 'KC-1041');
  assert.strictEqual(r.status, 'FOUND');
  assert.strictEqual(r.order_found, true);
  assert.strictEqual(r.lookup_method, 'order_id');
  assert.strictEqual(r.order.order_id, 'KC-1041');
  assert.strictEqual(r.order.status, 'shipped');
  assert.strictEqual(r.delivery_elapsed, null); // not delivered yet
});

test('get_order: query forms (JSON, lowercase, classifier fallback)', () => {
  assert.strictEqual(lookup('E01', '{"order_id":"KC-1041"}').order.order_id, 'KC-1041');
  assert.strictEqual(lookup('E01', 'order kc-1041 please').order.order_id, 'KC-1041');
  assert.strictEqual(lookup('E01', 'by sender email', 'KC-1041').lookup_method, 'order_id');
});

test('get_order: E10 no order ID -> found by verified sender email (KC-1044)', () => {
  const r = lookup('E10', 'by sender email', null);
  assert.strictEqual(r.status, 'FOUND');
  assert.strictEqual(r.lookup_method, 'sender_email');
  assert.strictEqual(r.order.order_id, 'KC-1044');
});

test('get_order: sender-email fallback picks the most recent order', () => {
  const mk = (id, date) => ({ order_id: id, customer_email: 'a@x.example', order_date: date, delivered_date: null });
  const r = lookupOrder({ query: '', verifiedSenderEmail: 'A@X.example', receivedAt: '2026-11-20T10:00:00+05:30',
    orders: [mk('KC-2001', '2026-11-01'), mk('KC-2002', '2026-11-10'), mk('KC-2003', '2026-11-05')] });
  assert.strictEqual(r.order.order_id, 'KC-2002');
  assert.strictEqual(r.matching_orders_count, 3);
});

test('get_order: E07 other person\'s order -> UNAUTHORIZED, zero order fields leaked', () => {
  const r = lookup('E07', 'KC-1046');
  assert.strictEqual(r.status, 'UNAUTHORIZED_EMAIL_MISMATCH');
  assert.strictEqual(r.order_found, false);
  assert.strictEqual(r.requested_order_id, 'KC-1046');
  assert.deepStrictEqual(Object.keys(r).sort(), ['message', 'order_found', 'requested_order_id', 'status']);
  const blob = JSON.stringify(r);
  const victim = orders.find((o) => o.order_id === 'KC-1046');
  for (const leak of [victim.customer_name, victim.customer_email, victim.tracking_url, victim.courier,
    victim.shipping_address.line1, victim.shipping_address.city, victim.shipping_address.pincode, 'Bridal', 'shipped', 'delivery_elapsed']) {
    assert.ok(!blob.includes(leak), `leaked: ${leak}`);
  }
  assert.ok(!('order' in r));
});

test('get_order: LLM-supplied email in the query is ignored (only trusted sender counts)', () => {
  const r = lookup('E07', 'KC-1046 meera.iyer@example.com {"email":"meera.iyer@example.com"}');
  assert.strictEqual(r.status, 'UNAUTHORIZED_EMAIL_MISMATCH');
});

test('get_order: fails closed when the verified sender is missing', () => {
  for (const sender of ['', undefined, null]) {
    assert.strictEqual(lookupOrder({ query: 'KC-1046', verifiedSenderEmail: sender, orders }).status, 'UNAUTHORIZED_EMAIL_MISMATCH');
    assert.strictEqual(lookupOrder({ query: 'by sender email', verifiedSenderEmail: sender, orders }).status, 'NOT_FOUND');
  }
});

test('get_order: E22 unknown order ID -> NOT_FOUND', () => {
  const r = lookup('E22', 'KC-1099');
  assert.strictEqual(r.status, 'NOT_FOUND');
  assert.strictEqual(r.order_found, false);
  assert.strictEqual(r.requested_order_id, 'KC-1099');
});

test('get_order: unknown sender and no order ID -> NOT_FOUND (E18)', () => {
  const r = lookup('E18', 'by sender email');
  assert.strictEqual(r.status, 'NOT_FOUND');
  assert.match(r.message, /email address/);
});

test('get_order: E24 cancelled order returns cancellation details', () => {
  const r = lookup('E24', 'KC-1045');
  assert.strictEqual(r.status, 'FOUND');
  assert.strictEqual(r.order.status, 'cancelled');
  assert.strictEqual(r.order.cancelled_date, '2026-11-16');
  assert.match(r.order.refund_status, /Refund of INR 828 initiated/);
  assert.strictEqual(r.delivery_elapsed, null);
});

test('computeDeliveryElapsed: E03=4, E11=5, E12=8, E16=15 days', () => {
  const d = (id, delivered) => computeDeliveryElapsed(delivered, email(id).received_at).days_since_delivery;
  assert.strictEqual(d('E03', '2026-11-16'), 4);
  assert.strictEqual(d('E11', '2026-11-15'), 5);
  assert.strictEqual(d('E12', '2026-11-12'), 8);
  assert.strictEqual(d('E16', '2026-11-05'), 15);
});

test('computeDeliveryElapsed: E04 delivered 19 Nov -> 1 day, within 48h', () => {
  const r = computeDeliveryElapsed('2026-11-19', email('E04').received_at);
  assert.strictEqual(r.days_since_delivery, 1);
  assert.ok(r.hours_since_delivery > 24 && r.hours_since_delivery <= 48, String(r.hours_since_delivery));
  assert.strictEqual(r.hours_since_delivery, 33.7);
});

test('computeDeliveryElapsed: uses IST calendar days regardless of received_at offset; never the clock', () => {
  // 2026-11-19T20:00Z is 2026-11-20 01:30 IST -> 1 calendar day after 19 Nov
  assert.strictEqual(computeDeliveryElapsed('2026-11-19', '2026-11-19T20:00:00Z').days_since_delivery, 1);
  assert.strictEqual(computeDeliveryElapsed('2026-11-19', '2026-11-20T09:00:00').days_since_delivery, 1); // no tz -> IST
  for (const bad of [[null, 'x'], ['2026-11-19', ''], ['2026-11-19', 'garbage'], ['19/11/2026', '2026-11-20T09:00:00+05:30']]) {
    assert.strictEqual(computeDeliveryElapsed(...bad), null);
  }
});

// ---------------- search_faq ----------------

test('parseFaqSections: intro + 9 numbered sections', () => {
  const { intro, sections } = parseFaqSections(faq);
  assert.match(intro, /only\*\* source of truth|only source of truth|Customer Support FAQ/);
  assert.strictEqual(sections.length, 9);
  assert.deepStrictEqual(sections.map((s) => s.number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.strictEqual(sections[7].title, 'Product Safety & Medical Questions');
  assert.ok(!sections[0].content.includes('## '));
  assert.match(sections[0].content, /1–2 business days/);
});

test('search_faq: E02 oily + vegan -> Products', () => {
  for (const q of ['is Saffron Glow serum okay for oily skin and vegan', email('E02').body]) {
    const r = searchFaq(q, faq);
    assert.strictEqual(r.found, true);
    assert.ok(sectionNums(r).includes(7));
    assert.match(r.matched_sections.find((s) => s.title.startsWith('7.')).content, /Vegan/);
  }
});

test('search_faq: E09 Guwahati + COD (English, Hindi) -> Shipping + COD', () => {
  for (const q of ['delivery time to Guwahati and is COD available', email('E09').body, 'गुवाहाटी डिलीवरी कैश ऑन डिलीवरी']) {
    const r = searchFaq(q, faq);
    assert.strictEqual(r.found, true, q);
    assert.ok(sectionNums(r).includes(1), `shipping missing for: ${q}`);
    assert.ok(sectionNums(r).includes(2), `COD missing for: ${q}`);
  }
});

test('search_faq: Hinglish delivery question -> Shipping', () => {
  assert.ok(sectionNums(searchFaq('order kab aayega, kitne din lagenge delivery me', faq)).includes(1));
});

test('search_faq: E20 eczema -> section 8 Medical Safety included', () => {
  for (const q of ['will Kumkumadi oil cure eczema', email('E20').body]) {
    const r = searchFaq(q, faq);
    assert.strictEqual(r.found, true);
    assert.ok(sectionNums(r).includes(8), q);
    assert.match(r.matched_sections.find((s) => s.title.startsWith('8.')).content, /cosmetics, not medicines/);
  }
});

test('search_faq: section 8 always included even when other sections fill the cap', () => {
  const r = searchFaq('shipping cod cancel return damaged refund serum pregnancy allergy', faq);
  assert.ok(r.matched_sections.length <= 4);
  assert.ok(sectionNums(r).includes(8));
});

test('search_faq: Hindi health keywords include section 8', () => {
  assert.ok(sectionNums(searchFaq('मुझे एक्जिमा है, क्या यह इलाज करेगा', faq)).includes(8));
  assert.ok(sectionNums(searchFaq('pregnancy me use kar sakte hain?', faq)).includes(8));
});

test('search_faq: E13 GST invoice / GSTIN -> found:false, escalate', () => {
  for (const q of ['GST invoice with company GSTIN', email('E13').body, 'जीएसटी इनवॉइस']) {
    const r = searchFaq(q, faq);
    assert.strictEqual(r.found, false, q);
    assert.deepStrictEqual(r.matched_sections, []);
    assert.match(r.message, /Do NOT guess; escalate to a human/);
    assert.deepStrictEqual(r.uncovered_topics, ['GST invoice']);
  }
});

test('search_faq: GST alongside a covered topic still flags the uncovered part', () => {
  const r = searchFaq('GST invoice for my returned order', faq);
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(r.uncovered_topics, ['GST invoice']);
  assert.match(r.note, /does NOT cover: GST invoice/);
});

test('search_faq: unrelated or empty query -> found:false', () => {
  for (const q of ['what is the meaning of life', '', undefined]) assert.strictEqual(searchFaq(q, faq).found, false);
});

test('search_faq: results capped at 4 sections', () => {
  assert.ok(searchFaq('shipping cod cancel return damaged refund serum contact', faq).matched_sections.length <= 4);
});

// ---------------- prepareAuditRow ----------------

const GOOD = { intent: 'order_status', secondary_intent: null, order_id: null, sentiment: 'neutral', language: 'en', confidence: 0.95, summary: 'Customer asks about an order.' };
const classify = (id, over = {}) => validateClassification(normalizeEmail(email(id)), { ...GOOD, ...over });
const step = (tool, input, obs) => ({ action: { tool, toolInput: { query: input }, log: '' }, observation: typeof obs === 'string' ? obs : JSON.stringify(obs) });
const REPLY = 'Hi Priya,\n\nYour order is on its way.\n\nWarm regards,\nTeam Kesar';
const AT = '2026-11-20T10:00:00.000Z';

test('prepareAuditRow: always exactly the 18 audit columns, in template order', () => {
  const header = fs.readFileSync(path.join(root, 'templates/audit_log_template.csv'), 'utf8').split(/\r?\n/)[0].split(',');
  assert.deepStrictEqual(COLUMNS, header);
  assert.strictEqual(header.length, 18);
  for (const input of [{}, { classification: classify('E01') }, { classification: classify('E01'), agentOutput: { error: 'boom' } }]) {
    assert.deepStrictEqual(Object.keys(prepareAuditRow({ ...input, processedAt: AT })), header);
  }
});

test('prepareAuditRow: E06 spam (other branch) -> logged_only, empty draft, no human', () => {
  const row = prepareAuditRow({ classification: classify('E06', { intent: 'other', confidence: 0.98, sentiment: 'neutral' }), processedAt: AT });
  assert.strictEqual(row.action_taken, 'logged_only');
  assert.strictEqual(row.reply_draft, '');
  assert.strictEqual(row.order_found, '');
  assert.strictEqual(row.needs_human, false);
  assert.strictEqual(row.email_id, 'E06');
  assert.strictEqual(row.secondary_intent, '');
  assert.strictEqual(row.processed_at, AT);
  assert.strictEqual(row.prompt_version, 'v1');
});

test('prepareAuditRow: E07 UNAUTHORIZED in intermediateSteps -> order_found false, needs_human, privacy action', () => {
  const steps = [step('get_order', 'KC-1046', { status: 'UNAUTHORIZED_EMAIL_MISMATCH', order_found: false, requested_order_id: 'KC-1046', message: 'x' })];
  const row = prepareAuditRow({
    classification: classify('E07', { order_id: 'KC-1046' }),
    agentOutput: { output: 'Hi Arjun,\n\nFor privacy we can only discuss an order with the email used to place it.\n\nWarm regards,\nTeam Kesar' },
    intermediateSteps: steps, processedAt: AT,
  });
  assert.strictEqual(row.order_found, false);
  assert.strictEqual(row.needs_human, true);
  assert.strictEqual(row.action_taken, 'privacy_blocked_escalated');
  assert.strictEqual(row.order_id, 'KC-1046');
  assert.match(row.notes, /privacy_blocked/);
});

test('prepareAuditRow: E10 order resolved by email in steps -> order_id KC-1044, order_found true', () => {
  const found = lookup('E10', 'by sender email');
  const row = prepareAuditRow({
    classification: classify('E10', { order_id: null }),
    agentOutput: { output: REPLY },
    intermediateSteps: [step('get_order', 'by sender email', found)], processedAt: AT,
  });
  assert.strictEqual(row.order_id, 'KC-1044');
  assert.strictEqual(row.order_found, true);
  assert.strictEqual(row.needs_human, false);
  assert.strictEqual(row.action_taken, 'drafted_reply');
  assert.strictEqual(row.reply_draft, REPLY);
});

test('prepareAuditRow: observation may be an object instead of a JSON string', () => {
  const row = prepareAuditRow({
    classification: classify('E10'), agentOutput: REPLY,
    intermediateSteps: [{ action: { tool: 'get_order' }, observation: lookup('E10', 'by sender email') }], processedAt: AT,
  });
  assert.strictEqual(row.order_id, 'KC-1044');
});

test('prepareAuditRow: E13 search_faq found:false -> needs_human', () => {
  const row = prepareAuditRow({
    classification: classify('E13', { intent: 'product_query' }),
    agentOutput: { output: 'Hi Nisha,\n\nA team member will follow up within 24 business hours.\n\nWarm regards,\nTeam Kesar' },
    intermediateSteps: [step('search_faq', 'GST invoice', searchFaq('GST invoice', faq))], processedAt: AT,
  });
  assert.strictEqual(row.needs_human, true);
  assert.strictEqual(row.action_taken, 'escalated_needs_human');
  assert.strictEqual(row.order_found, '');
  assert.match(row.notes, /faq_not_found/);
});

test('prepareAuditRow: E22 / E18 get_order NOT_FOUND -> order_found false, needs_human', () => {
  for (const id of ['E22', 'E18']) {
    const row = prepareAuditRow({
      classification: classify(id, { order_id: id === 'E22' ? 'KC-1099' : null }),
      agentOutput: REPLY, intermediateSteps: [step('get_order', 'x', lookup(id, id === 'E22' ? 'KC-1099' : 'by sender email'))], processedAt: AT,
    });
    assert.strictEqual(row.order_found, false, id);
    assert.strictEqual(row.needs_human, true, id);
  }
  assert.strictEqual(prepareAuditRow({
    classification: classify('E22', { order_id: 'KC-1099' }), agentOutput: REPLY,
    intermediateSteps: [step('get_order', 'KC-1099', lookup('E22', 'KC-1099'))], processedAt: AT,
  }).order_id, 'KC-1099'); // keeps the classifier's ID when nothing resolved
});

test('prepareAuditRow: angry sentiment and low confidence force needs_human', () => {
  const mk = (over) => prepareAuditRow({
    classification: classify('E08', over), agentOutput: REPLY,
    intermediateSteps: [step('get_order', 'KC-1051', lookup('E08', 'KC-1051'))], processedAt: AT,
  });
  assert.strictEqual(mk({ intent: 'complaint', sentiment: 'angry' }).needs_human, true);
  assert.strictEqual(mk({ sentiment: 'neutral', confidence: 0.5 }).needs_human, true);
  assert.strictEqual(mk({ sentiment: 'neutral' }).needs_human, false);
});

test('prepareAuditRow: classification injection flag forces needs_human even if agent says fine', () => {
  const row = prepareAuditRow({
    classification: classify('E12', { intent: 'return_refund', order_id: 'KC-1055' }),
    agentOutput: `${REPLY}\n---AGENT_META---\n{"escalate": false, "reason": ""}`,
    intermediateSteps: [step('get_order', 'KC-1055', lookup('E12', 'KC-1055'))], processedAt: AT,
  });
  assert.strictEqual(row.needs_human, true);
  assert.match(row.notes, /injection_flags/);
});

test('prepareAuditRow: AGENT_META is stripped; escalate:true raises needs_human; reply stays 100% clean', () => {
  const raw = `\n\t${REPLY}  \n\n---AGENT_META---\n{"escalate": true, "reason": "customer reports rash"}`;
  const row = prepareAuditRow({ classification: classify('E20', { intent: 'product_query' }), agentOutput: { output: raw }, intermediateSteps: [], processedAt: AT });
  assert.strictEqual(row.needs_human, true);
  assert.strictEqual(row.reply_draft, REPLY);
  assert.ok(!/AGENT_META|escalate|\{/.test(row.reply_draft));
  assert.match(row.notes, /agent_escalate: customer reports rash/);
  // garbled meta still never leaks into the draft
  const row2 = prepareAuditRow({ classification: classify('E01'), agentOutput: `${REPLY}\n---AGENT_META---\n{not json`, intermediateSteps: [], processedAt: AT });
  assert.strictEqual(row2.reply_draft, REPLY);
});

test('prepareAuditRow: agent failure or empty reply on a reply-needed intent -> escalated with error', () => {
  const failed = prepareAuditRow({ classification: classify('E01'), agentOutput: { error: '429 Too Many Requests' }, processedAt: AT });
  assert.strictEqual(failed.needs_human, true);
  assert.strictEqual(failed.action_taken, 'escalated_needs_human');
  assert.match(failed.error, /429 Too Many Requests/);
  assert.strictEqual(failed.reply_draft, '');
  assert.strictEqual(prepareAuditRow({ classification: classify('E01'), agentOutput: { output: '   ' }, processedAt: AT }).needs_human, true);
});

test('prepareAuditRow: classifier fallback error is carried through; ticket_id passes through', () => {
  const bad = validateClassification(normalizeEmail(email('E01')), { error: 'quota' });
  const row = prepareAuditRow({ classification: bad, ticketId: ' TKT-001 ', processedAt: AT });
  assert.strictEqual(row.needs_human, true);
  assert.strictEqual(row.action_taken, 'escalated_needs_human');
  assert.match(row.error, /LLM error: quota/);
  assert.strictEqual(row.ticket_id, 'TKT-001');
});

test('prepareAuditRow: no stray whitespace in any string cell', () => {
  const row = prepareAuditRow({
    classification: { ...classify('E01'), from_email: '  x@y.example ' },
    agentOutput: { output: `\t\n  ${REPLY}   \n\n\n\n` }, intermediateSteps: [], processedAt: ` ${AT} `,
  });
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string') assert.strictEqual(v, v.trim(), k);
  }
  assert.strictEqual(row.from_email, 'x@y.example');
});

// ---------------- n8n paste-ability ----------------

function runTool(file, query, ctx, helpers) {
  const src = fs.readFileSync(path.join(root, 'code', file), 'utf8');
  const fn = new Function('query', '$', src);
  const $ = (name) => {
    assert.strictEqual(name, 'Validate Classification');
    return { first: () => ({ json: ctx }), item: { json: ctx } };
  };
  return fn.call({ helpers }, query, $);
}

test('n8n entry: get_order tool uses trusted ctx, fetches via this.helpers.httpRequest, returns JSON string', async () => {
  let called = 0;
  const helpers = { httpRequest: async (opts) => { called++; assert.match(opts.url, /orders\.json$/); return JSON.stringify({ orders }); } };
  const ctx = { from_email: 'arjun.nair@example.com', received_at: email('E07').received_at, order_id: 'KC-1046' };
  const out = await runTool('tool_get_order.js', 'KC-1046', ctx, helpers);
  assert.strictEqual(typeof out, 'string');
  assert.strictEqual(JSON.parse(out).status, 'UNAUTHORIZED_EMAIL_MISMATCH');
  assert.strictEqual(called, 1);
  const ok = JSON.parse(await runTool('tool_get_order.js', 'by sender email', { from_email: 'vikram.singh@example.com', received_at: email('E10').received_at, order_id: null }, { httpRequest: async () => ({ orders }) }));
  assert.strictEqual(ok.order.order_id, 'KC-1044');
});

test('n8n entry: get_order tool fails safe when context or fetch is broken', async () => {
  const boom = { httpRequest: async () => { throw new Error('network'); } };
  const r = JSON.parse(await runTool('tool_get_order.js', 'KC-1041', { from_email: 'ananya.rao@example.com' }, boom));
  assert.strictEqual(r.order_found, false);
  assert.strictEqual(r.status, 'ERROR');
});

test('n8n entry: search_faq tool fetches markdown and returns JSON string', async () => {
  const out = await runTool('tool_search_faq.js', 'eczema and cure', {}, { httpRequest: async () => faq });
  assert.strictEqual(typeof out, 'string');
  assert.ok(JSON.parse(out).matched_sections.some((s) => s.title.startsWith('8.')));
  const bad = JSON.parse(await runTool('tool_search_faq.js', 'x', {}, { httpRequest: async () => { throw new Error('down'); } }));
  assert.strictEqual(bad.found, false);
});

test('n8n entry: prepare_audit_row handles agent branch and other branch', () => {
  const src = fs.readFileSync(path.join(root, 'code/prepare_audit_row.js'), 'utf8');
  const fn = new Function('$input', '$', src);
  const cls = classify('E01');
  const other = classify('E06', { intent: 'other', confidence: 0.98 });
  const $ = () => ({ itemMatching: () => ({ json: cls }) });
  const agentRow = fn({ all: () => [{ json: { output: REPLY, intermediateSteps: [step('get_order', 'KC-1041', lookup('E01', 'KC-1041'))] } }] }, $)[0].json;
  assert.strictEqual(agentRow.email_id, 'E01');
  assert.strictEqual(agentRow.order_found, true);
  assert.strictEqual(agentRow.action_taken, 'drafted_reply');
  const otherRow = fn({ all: () => [{ json: other }] }, $)[0].json;
  assert.strictEqual(otherRow.email_id, 'E06');
  assert.strictEqual(otherRow.action_taken, 'logged_only');
});
