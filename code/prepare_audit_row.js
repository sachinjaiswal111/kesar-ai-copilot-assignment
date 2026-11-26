'use strict';

const COLUMNS = [
  'email_id', 'received_at', 'from_email', 'intent', 'secondary_intent', 'order_id', 'language', 'sentiment',
  'confidence', 'order_found', 'action_taken', 'needs_human', 'ticket_id', 'reply_draft', 'prompt_version',
  'processed_at', 'error', 'notes',
];

const META_DELIMITER = '---AGENT_META---';

const s = (v) => (v === null || v === undefined ? '' : String(v).trim());

function tryParse(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    return null;
  }
}

/**
 * n8n's AI Agent wraps Custom Code Tool results: the observation can be
 *   '[{"response":"{\"status\":\"FOUND\",...}"}]', {response:"..."}, or a plain JSON string.
 * Peel those layers (max depth 6) and return the parsed tool payload, or null if none is parseable.
 */
function unwrapObservation(val, depth = 0) {
  if (val === null || val === undefined || depth > 6) return null;
  if (typeof val === 'string') {
    const t = val.trim();
    if (!t) return null;
    const parsed = tryParse(t);
    return parsed === null ? null : unwrapObservation(parsed, depth + 1);
  }
  if (Array.isArray(val)) {
    for (const el of val) {
      const u = unwrapObservation(el, depth + 1);
      if (u) return u;
    }
    return null;
  }
  if (typeof val === 'object') {
    if (val.status !== undefined || val.found !== undefined) return val; // already the tool payload
    for (const k of ['response', 'output', 'text', 'result']) {
      if (val[k] !== undefined) {
        const u = unwrapObservation(val[k], depth + 1);
        if (u) return u;
      }
    }
    return val;
  }
  return null;
}

function extractAgentText(agentOutput) {
  if (agentOutput === null || agentOutput === undefined) return { text: '', error: '' };
  if (Array.isArray(agentOutput)) return extractAgentText(agentOutput[0]);
  if (typeof agentOutput === 'string') return { text: agentOutput, error: '' };
  if (typeof agentOutput === 'object') {
    for (const k of ['output', 'text']) {
      if (typeof agentOutput[k] === 'string') return { text: agentOutput[k], error: '' };
    }
    if (agentOutput.error) {
      const e = agentOutput.error;
      return { text: '', error: `agent error: ${typeof e === 'string' ? e : e.message || JSON.stringify(e)}`.slice(0, 200) };
    }
  }
  return { text: '', error: '' };
}

function splitReplyAndMeta(text) {
  let body = String(text || '').replace(/\r\n/g, '\n');
  let meta = null;
  const idx = body.indexOf(META_DELIMITER);
  if (idx !== -1) {
    const metaRaw = body.slice(idx + META_DELIMITER.length).replace(/```(?:json)?/gi, '').trim();
    body = body.slice(0, idx);
    const parsed = tryParse(metaRaw.slice(metaRaw.indexOf('{'), metaRaw.lastIndexOf('}') + 1));
    meta = parsed && typeof parsed === 'object' ? parsed : null;
  }
  body = body
    .replace(/^\s*```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/^\t+/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { reply: body, meta };
}

function inspectSteps(steps) {
  const r = {
    get_order_called: false, order_status: '', resolved_order_id: '', order_found: '',
    privacy_blocked: false, search_faq_called: false, faq_not_found: false, tool_error: false,
  };
  if (!Array.isArray(steps)) return r;
  let anyFound = false;

  for (const step of steps) {
    const tool = s((step && step.action && (step.action.tool || step.action.toolName)) || (step && (step.tool || step.name)));
    const obsRaw = step && (step.observation !== undefined ? step.observation : step.output);
    const obs = unwrapObservation(obsRaw);
    if (tool === 'get_order') {
      r.get_order_called = true;
      const st = obs && obs.status;
      r.order_status = s(st) || r.order_status;
      if (st === 'FOUND' && obs.order && obs.order.order_id) {
        anyFound = true;
        r.resolved_order_id = s(obs.order.order_id);
      } else if (st === 'UNAUTHORIZED_EMAIL_MISMATCH') {
        r.privacy_blocked = true;
      } else if (st === 'NOT_FOUND') {
        // expected: order_found stays false
      } else {
        r.tool_error = true;
      }
    } else if (tool === 'search_faq') {
      r.search_faq_called = true;
      if (obs && obs.found === false) r.faq_not_found = true;
      if (!obs || typeof obs !== 'object') r.tool_error = true;
    }
  }
  if (r.get_order_called) r.order_found = anyFound;
  return r;
}

function prepareAuditRow({ classification, agentOutput, intermediateSteps, ticketId, eligibility, processedAt } = {}) {
  const c = classification && typeof classification === 'object' ? classification : {};
  const elig = eligibility && typeof eligibility === 'object' ? eligibility : null;
  const { text, error: agentError } = extractAgentText(agentOutput);
  const { reply, meta } = splitReplyAndMeta(text);
  const steps = intermediateSteps !== undefined ? intermediateSteps
    : agentOutput && typeof agentOutput === 'object' ? agentOutput.intermediateSteps : undefined;
  const t = inspectSteps(steps);

  let orderFound = t.order_found;
  let resolvedOrderId = t.resolved_order_id || s(c.order_id);
  let privacyBlocked = t.privacy_blocked;

  if (elig) {
    if (typeof elig.order_found === 'boolean') orderFound = elig.order_found;
    if (elig.resolved_order_id) resolvedOrderId = s(elig.resolved_order_id);
    if (elig.privacy_blocked) privacyBlocked = true;
  }

  const reasons = [];
  if (c.needs_human === true) reasons.push('classification_flagged');
  if (privacyBlocked) reasons.push('privacy_blocked');
  if (t.faq_not_found) reasons.push('faq_not_found');
  if ((t.get_order_called || elig) && orderFound === false) reasons.push('order_not_found');
  if (c.sentiment === 'angry') reasons.push('angry_sentiment');
  if (elig && elig.needs_human_from_eligibility === true) reasons.push('eligibility_flagged');
  if (meta && meta.escalate === true) reasons.push(`agent_escalate${meta.reason ? ': ' + s(meta.reason).slice(0, 120) : ''}`);
  if (t.tool_error) reasons.push('tool_error');

  const replyExpected = c.intent !== 'other';
  if (replyExpected && !reply) reasons.push('no_reply_generated');

  const needsHuman = reasons.length > 0;

  let action;
  if (privacyBlocked) action = 'privacy_blocked_escalated';
  else if (needsHuman) action = 'escalated_needs_human';
  else if (reply) action = 'drafted_reply';
  else action = 'logged_only';

  const errors = [s(c.error), agentError].filter(Boolean);
  const notes = [
    ...(Array.isArray(c.validation_notes) ? c.validation_notes.map(s) : []),
    ...(Array.isArray(c.heuristic_injection_flags) && c.heuristic_injection_flags.length
      ? [`injection_flags: ${c.heuristic_injection_flags.join(',')}`] : []),
    ...(c.prompt_injection_detected ? ['prompt_injection_detected'] : []),
    ...(elig && Array.isArray(elig.reasons) && elig.reasons.length ? [`eligibility: ${elig.reasons.join(' ')}`] : []),
    ...(t.get_order_called ? [`get_order: ${t.order_status || 'unknown'}`] : []),
    ...(t.search_faq_called ? [`search_faq: ${t.faq_not_found ? 'not_found' : 'found'}`] : []),
    ...(needsHuman ? [`needs_human because: ${reasons.join('; ')}`] : []),
  ].filter(Boolean);

  const row = {
    email_id: s(c.email_id),
    received_at: s(c.received_at),
    from_email: s(c.from_email),
    intent: s(c.intent),
    secondary_intent: s(c.secondary_intent),
    order_id: resolvedOrderId,
    language: s(c.language),
    sentiment: s(c.sentiment),
    confidence: typeof c.confidence === 'number' ? c.confidence : '',
    order_found: orderFound,
    action_taken: action,
    needs_human: needsHuman,
    ticket_id: s(ticketId),
    reply_draft: reply,
    prompt_version: s(c.prompt_version),
    processed_at: s(processedAt) || new Date().toISOString(),
    error: errors.join(' | '),
    notes: notes.join(' | '),
  };

  return Object.fromEntries(COLUMNS.map((k) => [k, row[k]]));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { prepareAuditRow, unwrapObservation, extractAgentText, splitReplyAndMeta, inspectSteps, COLUMNS, META_DELIMITER };
}

// ---- n8n Code node entry (Run Once for All Items). Ignored under Node tests. ----
if (typeof $input !== 'undefined') {
  return $input.all().map((item) => {
    const j = item.json || {};
    const fromAgent = j.output !== undefined || j.intermediateSteps !== undefined || (j.error !== undefined && j.intent === undefined);

    // ALWAYS take the classification from Validate Classification so email_id / from_email /
    // prompt_version survive even when the agent errored. Fall back to the incoming item.
    let classification = null;
    try {
      classification = $('Validate Classification').first().json;
    } catch (e) {
      classification = null;
    }
    if (!classification || !classification.email_id) classification = fromAgent ? classification || {} : j;

    let eligibility = null;
    let ticketId = j.ticket_id || j.ticketId || '';
    try {
      if ($('Evaluate Eligibility').isExecuted) eligibility = $('Evaluate Eligibility').first().json.eligibility || null;
    } catch (e) {
      // not on this branch
    }
    try {
      if ($('Prepare Ticket Action').isExecuted) ticketId = $('Prepare Ticket Action').first().json.ticket_id || ticketId;
    } catch (e) {
      // not on this branch
    }
    return {
      json: prepareAuditRow({
        classification,
        agentOutput: fromAgent ? j : undefined,
        intermediateSteps: fromAgent ? j.intermediateSteps : undefined,
        ticketId,
        eligibility,
      }),
    };
  });
}
