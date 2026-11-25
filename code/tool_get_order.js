'use strict';
/**
 * tool_get_order.js  (Phase 3)
 *
 * Order lookup for the AI Agent's `get_order` tool.
 *
 * Security model (enforced here in code, not in the prompt):
 *  - The sender's email comes from trusted workflow context ($('Validate Classification')),
 *    NEVER from the LLM's tool input. Whatever the model passes in `query` is only used
 *    to pull out an order ID.
 *  - An order is returned only when order.customer_email === verified sender email.
 *    On mismatch the response contains NO fields from the order (not even its status).
 *  - If the verified sender is missing, lookups fail closed.
 *
 * Dates: delivery elapsed time is computed from the email's received_at, never from the
 * system clock. delivered_date has no time-of-day, so it is treated as 00:00 IST.
 *
 * Works in Node (CommonJS, unit tests) AND pasted into an n8n "Custom Code Tool"
 * (language: JavaScript). The n8n entry block at the bottom runs only when `query` exists.
 */

const ORDERS_URL =
  'https://raw.githubusercontent.com/abhishek-patel-cadient/kesar-ai-copilot-assignment/refs/heads/main/data/orders.json';
const ORDER_ID_RE = /KC-\d{4}/i;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Parse an ISO timestamp; if it has no timezone designator assume IST. Returns ms or NaN. */
function parseTs(ts) {
  if (typeof ts !== 'string' || !ts.trim()) return NaN;
  const s = ts.trim();
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : s + '+05:30');
}

/**
 * Days / hours between order.delivered_date (YYYY-MM-DD, IST midnight) and receivedAt.
 *  - days_since_delivery: whole IST calendar days (received IST date minus delivered date).
 *  - hours_since_delivery: elapsed hours from delivery-day 00:00 IST, 1 decimal. Because the
 *    real delivery time is unknown this is an UPPER bound on the true elapsed time.
 * Returns null if not delivered or a date is invalid.
 */
function computeDeliveryElapsed(deliveredDate, receivedAt) {
  if (typeof deliveredDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(deliveredDate.trim())) return null;
  const d = deliveredDate.trim();
  const startMs = Date.parse(`${d}T00:00:00+05:30`);
  const recvMs = parseTs(receivedAt);
  if (Number.isNaN(startMs) || Number.isNaN(recvMs)) return null;

  const recvIstDate = new Date(recvMs + IST_OFFSET_MS).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${recvIstDate}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86400000);
  const hours = Math.round(((recvMs - startMs) / 3600000) * 10) / 10;
  return { delivered_date: d, received_at: receivedAt, days_since_delivery: days, hours_since_delivery: hours };
}

function extractOrderId(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(ORDER_ID_RE);
  return m ? m[0].toUpperCase() : null;
}

function lookupOrder({ query, verifiedSenderEmail, receivedAt, orders, classifiedOrderId } = {}) {
  const sender = lower(verifiedSenderEmail);
  const list = Array.isArray(orders) ? orders : [];

  // 1. Order ID: from the tool query (plain text or JSON), else from the classifier.
  const requestedId = extractOrderId(typeof query === 'string' ? query : JSON.stringify(query || '')) ||
    extractOrderId(classifiedOrderId);

  if (requestedId) {
    const order = list.find((o) => o && String(o.order_id).toUpperCase() === requestedId);
    if (!order) {
      return {
        status: 'NOT_FOUND',
        order_found: false,
        requested_order_id: requestedId,
        message: 'No order found matching that order ID.',
      };
    }
    if (!sender || lower(order.customer_email) !== sender) {
      // Deliberately nothing from `order` here.
      return {
        status: 'UNAUTHORIZED_EMAIL_MISMATCH',
        order_found: false,
        requested_order_id: requestedId,
        message:
          'Security check failed: sender email does not match the order owner. Do NOT disclose any order, tracking, or address details.',
      };
    }
    return {
      status: 'FOUND',
      order_found: true,
      lookup_method: 'order_id',
      order,
      delivery_elapsed: computeDeliveryElapsed(order.delivered_date, receivedAt),
    };
  }

  // 2. No order ID anywhere: fall back to the verified sender email.
  const mine = sender ? list.filter((o) => o && lower(o.customer_email) === sender) : [];
  if (mine.length === 0) {
    return { status: 'NOT_FOUND', order_found: false, message: 'No order found for this email address.' };
  }
  // Most recent order_date wins; ties -> later in the list.
  const order = mine.reduce((best, o) => (String(o.order_date) >= String(best.order_date) ? o : best));
  return {
    status: 'FOUND',
    order_found: true,
    lookup_method: 'sender_email',
    matching_orders_count: mine.length,
    order,
    delivery_elapsed: computeDeliveryElapsed(order.delivered_date, receivedAt),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { lookupOrder, computeDeliveryElapsed, extractOrderId, ORDERS_URL };
}

// ---- n8n Custom Code Tool entry. `query` is injected by n8n; absent under Node tests. ----
if (typeof query !== 'undefined') {
  return (async () => {
    // Trusted context from the workflow, never from the LLM.
    let ctx = {};
    try {
      ctx = $('Validate Classification').first().json;
    } catch (e) {
      try {
        ctx = $('Validate Classification').item.json;
      } catch (e2) {
        ctx = {};
      }
    }

    const getOrders = async () => {
      let res;
      if (typeof this !== 'undefined' && this && this.helpers && this.helpers.httpRequest) {
        res = await this.helpers.httpRequest({ method: 'GET', url: ORDERS_URL, json: true });
      } else {
        res = await (await fetch(ORDERS_URL)).json();
      }
      if (typeof res === 'string') res = JSON.parse(res);
      if (res && res.body && !res.orders) res = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
      return Array.isArray(res) ? res : res.orders;
    };

    try {
      const result = lookupOrder({
        query,
        verifiedSenderEmail: ctx.from_email,
        receivedAt: ctx.received_at,
        orders: await getOrders(),
        classifiedOrderId: ctx.order_id,
      });
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ status: 'ERROR', order_found: false, message: 'Order lookup failed; escalate to a human. Do not guess.' });
    }
  })();
}
