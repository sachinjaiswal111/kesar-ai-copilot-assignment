'use strict';
/**
 * normalize_email.js  (Phase 2)
 *
 * Turns an incoming webhook payload (or a flat email object) into one flat,
 * predictable item for the rest of the workflow, and runs cheap deterministic
 * prompt-injection heuristics as defense-in-depth (the LLM prompt is the
 * first line of defense, these flags are the second).
 *
 * Works in Node (CommonJS, unit tests) AND pasted as-is into an n8n Code node
 * (mode: "Run Once for All Items"). Node name expected by later nodes: "Normalize Email".
 *
 * received_at is preserved verbatim. We never substitute the system clock.
 */

const PROMPT_VERSION = 'v2';

// Rule name -> regex. Deliberately simple and explainable; flags only raise
// needs_human, they never auto-reject an email.
const INJECTION_RULES = [
  {
    name: 'ignore_instructions',
    re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any)\b[^.\n]{0,40}\b(instructions?|prompts?|policies|policy|rules|guidelines)\b/i,
  },
  {
    name: 'system_override',
    re: /\b(system\s+(note|prompt|message|override|instruction)s?|note\s+to\s+(the\s+)?(ai|assistant|bot|llm)|you\s+are\s+now\b|new\s+instructions?\s*:)/i,
  },
  {
    name: 'suppress_ticket',
    re: /\b(do\s*n['o]?t|do\s+not|never|don['’]t)\s+(create|open|raise|log|file)\b[^.\n]{0,25}\b(ticket|case|record)s?\b/i,
  },
  {
    name: 'force_approval',
    re: /(\b(mark|set|treat|process)\b[^.\n]{0,40}\b(as\s+)?approved\b|\bapprove\s+(the\s+|my\s+|this\s+)?(refund|return|request)\b|\breply\s+(exactly|with\s+exactly)\b)/i,
  },
  {
    // Body tries to close/open our prompt delimiter to escape the untrusted block.
    name: 'delimiter_escape',
    re: /<\/?\s*untrusted_customer_email\s*>/i,
  },
];

function detectInjectionHeuristics(text) {
  const s = typeof text === 'string' ? text : '';
  return INJECTION_RULES.filter((r) => r.re.test(s)).map((r) => r.name);
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function normalizeAttachments(a) {
  if (!Array.isArray(a)) return [];
  return a
    .map((x) => (typeof x === 'string' ? x : x && (x.filename || x.name || x.fileName)) || '')
    .map((x) => String(x).trim())
    .filter(Boolean);
}

function normalizeEmail(rawItem, options) {
  const promptVersion = (options && options.promptVersion) || PROMPT_VERSION;
  // n8n Webhook node wraps the POST JSON in `.body`; accept a flat email too.
  const raw = rawItem && typeof rawItem === 'object' ? rawItem : {};
  const e = raw.body && typeof raw.body === 'object' && !Array.isArray(raw.body) ? raw.body : raw;

  // `from` is {name, email} in the assignment data; tolerate a plain string.
  const from = e.from && typeof e.from === 'object' ? e.from : { email: e.from };
  const subject = str(e.subject);
  const body = str(e.body);
  const attachments = normalizeAttachments(e.attachments);

  return {
    email_id: str(e.id !== undefined ? e.id : e.email_id).trim(),
    received_at: str(e.received_at).trim(),
    from_name: str(from.name).trim(),
    from_email: str(from.email).trim().toLowerCase(),
    to: str(e.to).trim(),
    subject,
    body,
    attachments,
    has_attachments: attachments.length > 0,
    heuristic_injection_flags: detectInjectionHeuristics(`${subject}\n${body}`),
    prompt_version: promptVersion,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeEmail, detectInjectionHeuristics, INJECTION_RULES, PROMPT_VERSION };
}

// ---- n8n Code node entry (Run Once for All Items). Ignored under Node tests. ----
if (typeof $input !== 'undefined') {
  return $input.all().map((item) => ({ json: normalizeEmail(item.json) }));
}
