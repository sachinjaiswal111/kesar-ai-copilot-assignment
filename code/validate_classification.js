'use strict';
/**
 * validate_classification.js  (Phase 2)
 *
 * Deterministic gate after the LLM classifier. Guarantees every email leaves
 * this step with a classification that satisfies schemas/llm_output.schema.json,
 * even if the model returned junk, fenced JSON, or the call errored (429 etc).
 *
 * Works in Node (CommonJS, unit tests) AND pasted as-is into an n8n Code node
 * (mode: "Run Once for All Items"). Expects an upstream node named "Normalize Email".
 *
 * Rules:
 *  - Light coercions only where the meaning is unambiguous (case, "none" -> null,
 *    bad order_id -> null with a note, long summary -> truncated).
 *  - Anything else wrong in a REQUIRED field -> safe fallback (intent "other",
 *    needs_human true). We never guess.
 */

const INTENTS = ['order_status', 'product_query', 'return_refund', 'complaint', 'other'];
const SENTIMENTS = ['positive', 'neutral', 'negative', 'angry'];
const LANGUAGES = ['en', 'hi', 'hinglish'];
const ORDER_ID_RE = /^KC-\d{4}$/;
const NULLISH_STRINGS = ['', 'null', 'none', 'n/a', 'na', 'nil', 'undefined'];
const SUMMARY_MAX = 200;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

const FALLBACK_SUMMARY = 'Classification failed; escalated for human review.';

// ---- helpers --------------------------------------------------------------

/** Accepts object | {output} | {text} | [x] | JSON string (optionally ```json fenced). */
function extractCandidate(raw) {
  if (raw === null || raw === undefined) return { error: 'empty LLM output' };

  if (Array.isArray(raw)) {
    if (raw.length === 0) return { error: 'empty LLM output' };
    return extractCandidate(raw[0]);
  }

  if (typeof raw === 'string') {
    let s = raw.trim();
    const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) s = fence[1].trim();
    if (!s) return { error: 'empty LLM output' };
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch (e) {
      // Last resort: JSON object embedded in prose.
      const a = s.indexOf('{');
      const b = s.lastIndexOf('}');
      if (a === -1 || b <= a) return { error: 'unparseable LLM output (not JSON)' };
      try {
        parsed = JSON.parse(s.slice(a, b + 1));
      } catch (e2) {
        return { error: 'unparseable LLM output (invalid JSON)' };
      }
    }
    return extractCandidate(parsed);
  }

  if (typeof raw === 'object') {
    if (raw.intent === undefined && raw.error !== undefined && raw.error !== null) {
      const err = raw.error;
      const msg = typeof err === 'string' ? err : err.message || JSON.stringify(err);
      return { error: `LLM error: ${String(msg).slice(0, 150)}` };
    }
    if (raw.intent === undefined) {
      if (raw.output !== undefined) return extractCandidate(raw.output);
      if (raw.text !== undefined) return extractCandidate(raw.text);
      if (raw.json !== undefined) return extractCandidate(raw.json);
    }
    return { value: raw };
  }

  return { error: `unsupported LLM output type: ${typeof raw}` };
}

const lc = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v);

function isNullish(v) {
  return v === null || v === undefined || (typeof v === 'string' && NULLISH_STRINGS.includes(v.trim().toLowerCase()));
}

/** Returns {value} or {error}; pushes soft-fix notes into `notes`. */
function validateFields(c, notes) {
  const intent = lc(c.intent);
  if (!INTENTS.includes(intent)) return { error: `invalid intent: ${JSON.stringify(c.intent)}` };

  const sentiment = lc(c.sentiment);
  if (!SENTIMENTS.includes(sentiment)) return { error: `invalid sentiment: ${JSON.stringify(c.sentiment)}` };

  const language = lc(c.language);
  if (!LANGUAGES.includes(language)) return { error: `invalid language: ${JSON.stringify(c.language)}` };

  const confidence = c.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { error: `invalid confidence: ${JSON.stringify(c.confidence)}` };
  }

  if (typeof c.summary !== 'string' || !c.summary.trim()) return { error: 'missing or empty summary' };
  let summary = c.summary.trim();
  if (summary.length > SUMMARY_MAX) {
    summary = summary.slice(0, SUMMARY_MAX - 3) + '...';
    notes.push('summary truncated to 200 chars');
  }

  // secondary_intent: soft field
  let secondary = null;
  if (!isNullish(c.secondary_intent)) {
    const s = lc(c.secondary_intent);
    if (!INTENTS.includes(s)) {
      notes.push(`invalid secondary_intent ${JSON.stringify(c.secondary_intent)} set to null`);
    } else if (s !== intent) {
      secondary = s;
    }
  }

  // order_id: soft field, never guessed
  let orderId = null;
  if (!isNullish(c.order_id)) {
    const o = typeof c.order_id === 'string' ? c.order_id.trim().toUpperCase() : '';
    if (ORDER_ID_RE.test(o)) {
      orderId = o;
    } else {
      notes.push(`malformed order_id ${JSON.stringify(c.order_id)} set to null`);
    }
  }

  return {
    value: {
      intent,
      secondary_intent: secondary,
      order_id: orderId,
      sentiment,
      language,
      confidence,
      summary,
      prompt_injection_suspected: c.prompt_injection_suspected === true,
    },
  };
}

// ---- main -----------------------------------------------------------------

function validateClassification(emailData, rawLlmOutput, options) {
  const email = emailData && typeof emailData === 'object' ? emailData : {};
  const threshold = (options && options.confidenceThreshold) ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const notes = [];

  let result = extractCandidate(rawLlmOutput);
  if (result.value) {
    const checked = validateFields(result.value, notes);
    result = checked.value ? { value: checked.value } : { error: checked.error };
  }

  const heuristicFlags = Array.isArray(email.heuristic_injection_flags) ? email.heuristic_injection_flags : [];
  const valid = !!result.value;

  const classification = valid
    ? result.value
    : {
        intent: 'other',
        secondary_intent: null,
        order_id: null,
        sentiment: 'neutral',
        language: 'en',
        confidence: 0,
        summary: FALLBACK_SUMMARY,
        prompt_injection_suspected: false,
      };

  const promptInjectionDetected = classification.prompt_injection_suspected === true || heuristicFlags.length > 0;
  const lowConfidence = classification.confidence < threshold;

  return {
    ...email,
    ...classification,
    classification_valid: valid,
    prompt_injection_detected: promptInjectionDetected,
    needs_human: !valid || promptInjectionDetected || lowConfidence,
    error: valid ? '' : result.error,
    validation_notes: notes,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateClassification, extractCandidate, INTENTS, SENTIMENTS, LANGUAGES, DEFAULT_CONFIDENCE_THRESHOLD };
}

// ---- n8n Code node entry (Run Once for All Items). Ignored under Node tests. ----
if (typeof $input !== 'undefined') {
  return $input.all().map((item, i) => {
    let emailData;
    try {
      emailData = $('Normalize Email').itemMatching(i).json;
    } catch (e) {
      emailData = item.json; // standalone testing: use the current item
    }
    return { json: validateClassification(emailData, item.json) };
  });
}
