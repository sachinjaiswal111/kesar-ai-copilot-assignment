const ORDERS_URL =
  'https://raw.githubusercontent.com/abhishek-patel-cadient/kesar-ai-copilot-assignment/refs/heads/main/data/orders.json';

function parseIstDateStart(yyyyMmDd) {
  if (!yyyyMmDd || typeof yyyyMmDd !== 'string') return null;
  const dt = new Date(`${yyyyMmDd.trim()}T00:00:00+05:30`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parseReceivedAt(receivedAt) {
  if (!receivedAt || typeof receivedAt !== 'string') return null;
  const s = receivedAt.trim();
  const hasTz = /(?:Z|[+-]\d{2}:\d{2})$/i.test(s);
  const dt = new Date(hasTz ? s : `${s}+05:30`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function computeDeliveryElapsed(deliveredDate, receivedAt) {
  const dStart = parseIstDateStart(deliveredDate);
  const rDate = parseReceivedAt(receivedAt);
  if (!dStart || !rDate) return { days_since_delivery: null, hours_since_delivery: null };
  const diffMs = rDate.getTime() - dStart.getTime();
  const hours = Math.round((diffMs / 3600000) * 10) / 10;
  const rIstDay = new Date(rDate.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
  const rDayStart = parseIstDateStart(rIstDay);
  const days = Math.floor((rDayStart.getTime() - dStart.getTime()) / 86400000);
  return { days_since_delivery: days, hours_since_delivery: hours };
}

function detectCaseType(intent, text) {
  const t = (text || '').toLowerCase();
  const damagedPattern =
    /\b(damaged|cracked|broken|leaked|leaking|spilled|spill|wrong item|wrong product|instead of|missing|not in the box|only had)\b/i;
  if (intent === 'complaint' || damagedPattern.test(t)) {
    return 'damaged_wrong_missing';
  }
  return 'standard_return';
}

function detectOpenedOrUsed(text) {
  const t = (text || '').toLowerCase();
  const explicitlyUnopened = /\b(unopened|never opened|not opened|still sealed|seals? intact)\b/i.test(t);
  const usedSignals =
    /\b(used|using|didn'?t suit|did not suit|no difference|applied|tried it|tried them|for two weeks|for a few days)\b/i.test(t);
  if (usedSignals) return true;
  if (explicitlyUnopened) return false;
  return /\bopened\b/i.test(t);
}

function evaluateEligibility({ emailData, orders }) {
  const sender = String(emailData.from_email || '').trim().toLowerCase();
  const orderId = emailData.order_id ? String(emailData.order_id).trim().toUpperCase() : null;
  const list = Array.isArray(orders) ? orders : [];

  let matched = null;
  if (orderId) {
    matched = list.find((o) => String(o.order_id || '').toUpperCase() === orderId) || null;
    if (matched && String(matched.customer_email || '').trim().toLowerCase() !== sender) {
      return {
        ...emailData,
        eligibility: {
          order_found: false,
          resolved_order_id: null,
          privacy_blocked: true,
          case_type: detectCaseType(emailData.intent, `${emailData.subject} ${emailData.body}`),
          eligible: false,
          reasons: ['Privacy check failed: sender email does not match order owner.'],
          days_since_delivery: null,
          hours_since_delivery: null,
          requires_photos: false,
          photos_provided: Boolean(emailData.has_attachments),
          refundable_amount: null,
          non_refundable_fees: null,
          payment_method: null,
          refund_method_note: '',
          kit_rule_note: null,
          ticket_priority: 'High',
          needs_human_from_eligibility: true,
        },
      };
    }
  } else if (sender) {
    const byEmail = list
      .filter((o) => String(o.customer_email || '').trim().toLowerCase() === sender)
      .sort((a, b) => String(b.order_date || '').localeCompare(String(a.order_date || '')));
    matched = byEmail[0] || null;
  }

  const combinedText = `${emailData.subject || ''} ${emailData.body || ''}`;
  const caseType = detectCaseType(emailData.intent, combinedText);
  const isAngry = emailData.sentiment === 'angry';
  const isInjection = Boolean(emailData.prompt_injection_detected);

  if (!matched) {
    return {
      ...emailData,
      eligibility: {
        order_found: false,
        resolved_order_id: orderId,
        privacy_blocked: false,
        case_type: caseType,
        eligible: null,
        reasons: ['Order not found in database; cannot verify eligibility.'],
        days_since_delivery: null,
        hours_since_delivery: null,
        requires_photos: caseType === 'damaged_wrong_missing',
        photos_provided: Boolean(emailData.has_attachments),
        refundable_amount: null,
        non_refundable_fees: null,
        payment_method: null,
        refund_method_note: '',
        kit_rule_note: null,
        ticket_priority: caseType === 'damaged_wrong_missing' || isAngry || isInjection ? 'High' : 'Medium',
        needs_human_from_eligibility: true,
      },
    };
  }

  const elapsed = computeDeliveryElapsed(matched.delivered_date, emailData.received_at);
  const paymentMethod = matched.payment_method || null;
  const hasKit = (matched.items || []).some((i) => /kit/i.test(i.name || '') || /KIT/i.test(i.sku || ''));
  const kitRuleNote = hasKit ? 'Combo/kit products (Bridal Glow Kit) must be returned as a complete set.' : null;
  const reasons = [];
  let eligible = false;
  let refundableAmount = null;
  let nonRefundableFees = null;
  let requiresPhotos = false;
  let ticketPriority = 'Medium';

  if (matched.status !== 'delivered' || !matched.delivered_date) {
    eligible = false;
    reasons.push(`Order status is "${matched.status}" (not delivered yet).`);
    ticketPriority = caseType === 'damaged_wrong_missing' || isAngry ? 'High' : 'Medium';
  } else if (caseType === 'damaged_wrong_missing') {
    requiresPhotos = true;
    const within48h =
      (elapsed.hours_since_delivery !== null && elapsed.hours_since_delivery <= 48) ||
      (elapsed.days_since_delivery !== null && elapsed.days_since_delivery <= 2);
    eligible = within48h;
    refundableAmount = matched.total;
    nonRefundableFees = 0;
    ticketPriority = 'High';
    if (within48h) {
      reasons.push(
        `Damaged/wrong/missing item reported within 48h window (${elapsed.days_since_delivery} day(s) since delivery). Eligible for free replacement or full refund.`
      );
      if (!emailData.has_attachments) {
        reasons.push('Photos of product and outer box are required before processing.');
      } else {
        reasons.push(`Photos attached: ${(emailData.attachments || []).join(', ')}.`);
      }
    } else {
      reasons.push(`Reported outside 48-hour damaged/wrong/missing window (${elapsed.days_since_delivery} days).`);
    }
  } else {
    const within7d = elapsed.days_since_delivery !== null && elapsed.days_since_delivery <= 7;
    const openedOrUsed = detectOpenedOrUsed(combinedText);
    eligible = within7d && !openedOrUsed;
    refundableAmount = matched.subtotal;
    nonRefundableFees = (matched.shipping_fee || 0) + (matched.cod_fee || 0);
    if (!within7d) {
      reasons.push(`Outside 7-day return window (${elapsed.days_since_delivery} days since delivery).`);
    }
    if (openedOrUsed) {
      reasons.push('Product was opened or used (policy requires unused, unopened items with seal intact).');
    }
    if (eligible) {
      reasons.push(`Eligible standard return (${elapsed.days_since_delivery} days since delivery, unopened/sealed).`);
    }
    if (isInjection || isAngry) ticketPriority = 'High';
    else ticketPriority = eligible ? 'Medium' : 'Low';
  }

  const refundMethodNote =
    paymentMethod === 'cod'
      ? 'COD order: refund via UPI or bank transfer AFTER reverse pickup is completed (never ask for OTP, PIN, CVV, or password). COD fee (INR 49) is non-refundable on standard returns.'
      : 'Prepaid order: refund to original payment method within 5-7 business days after quality check (shipping fee non-refundable on standard returns; full amount refunded on damaged/wrong/missing).';

  const needsHuman =
    !eligible || isAngry || isInjection || (caseType === 'damaged_wrong_missing' && isAngry);

  return {
    ...emailData,
    order_id: matched.order_id,
    eligibility: {
      order_found: true,
      resolved_order_id: matched.order_id,
      privacy_blocked: false,
      case_type: caseType,
      eligible,
      reasons,
      days_since_delivery: elapsed.days_since_delivery,
      hours_since_delivery: elapsed.hours_since_delivery,
      requires_photos: requiresPhotos,
      photos_provided: Boolean(emailData.has_attachments),
      refundable_amount: refundableAmount,
      non_refundable_fees: nonRefundableFees,
      order_total: matched.total,
      order_items: matched.items || [],
      payment_method: paymentMethod,
      refund_method_note: refundMethodNote,
      kit_rule_note: kitRuleNote,
      ticket_priority: ticketPriority,
      needs_human_from_eligibility: needsHuman,
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { evaluateEligibility, computeDeliveryElapsed, detectCaseType, detectOpenedOrUsed };
}

if (typeof $input !== 'undefined') {
  return (async () => {
    let raw;
    if (typeof this !== 'undefined' && this.helpers && typeof this.helpers.httpRequest === 'function') {
      raw = await this.helpers.httpRequest({ method: 'GET', url: ORDERS_URL });
    } else {
      const resp = await fetch(ORDERS_URL);
      raw = await resp.text();
    }
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw && raw.body ? JSON.parse(raw.body) : raw;
    const orders = parsed.orders || [];
    const emailData = $input.first().json;
    return [{ json: evaluateEligibility({ emailData, orders }) }];
  })();
}