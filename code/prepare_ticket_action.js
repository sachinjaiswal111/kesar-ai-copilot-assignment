const PRIORITY_RANK = { Low: 1, Medium: 2, High: 3 };

function higherPriority(a, b) {
  const pa = PRIORITY_RANK[a] ? a : 'Medium';
  const pb = PRIORITY_RANK[b] ? b : 'Medium';
  return PRIORITY_RANK[pa] >= PRIORITY_RANK[pb] ? pa : pb;
}

function nextTicketId(existingTickets) {
  let maxNum = 0;
  for (const row of existingTickets || []) {
    const m = String(row.ticket_id || '').match(/^TKT-(\d+)$/i);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  }
  return `TKT-${String(maxNum + 1).padStart(3, '0')}`;
}

function mergeEmailIds(existingStr, newId) {
  const parts = String(existingStr || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (newId && !parts.includes(newId)) parts.push(newId);
  return parts.join(', ');
}

function prepareTicketAction({ contextData, existingTickets, nowIso }) {
  const ts = nowIso || new Date().toISOString();
  const elig = contextData.eligibility || {};
  const validRows = (existingTickets || []).filter((r) => r && r.ticket_id);
  const targetOrderId = String(elig.resolved_order_id || contextData.order_id || '').trim().toUpperCase();

  const existingOpen = targetOrderId
    ? validRows.find(
        (r) =>
          String(r.order_id || '').trim().toUpperCase() === targetOrderId &&
          String(r.status || '').trim().toLowerCase() !== 'closed'
      )
    : null;

  const attNote =
    Array.isArray(contextData.attachments) && contextData.attachments.length > 0
      ? ` Attachments: ${contextData.attachments.join(', ')}.`
      : '';
  const eligNote = Array.isArray(elig.reasons) && elig.reasons.length > 0 ? elig.reasons.join(' ') : '';
  const newNoteEntry = `[${contextData.email_id}] ${contextData.summary || ''}${attNote} ${eligNote}`.trim();

  if (existingOpen) {
    const existingNotes = String(existingOpen.notes || '').trim();
    const updatedNotes = existingNotes.includes(`[${contextData.email_id}]`)
      ? existingNotes
      : existingNotes
      ? `${existingNotes} | ${newNoteEntry}`
      : newNoteEntry;

    const ticketRow = {
      ticket_id: existingOpen.ticket_id,
      created_at: existingOpen.created_at || ts,
      updated_at: ts,
      order_id: existingOpen.order_id || targetOrderId,
      customer_email: existingOpen.customer_email || contextData.from_email || '',
      email_ids: mergeEmailIds(existingOpen.email_ids, contextData.email_id),
      intent: existingOpen.intent || contextData.intent || '',
      priority: higherPriority(existingOpen.priority, elig.ticket_priority || 'Medium'),
      status: existingOpen.status || 'Open',
      summary: existingOpen.summary || contextData.summary || '',
      notes: updatedNotes,
    };

    return {
      ...contextData,
      ticket_action: 'update',
      ticket_id: ticketRow.ticket_id,
      ticket_row: ticketRow,
    };
  }

  const newId = nextTicketId(validRows);
  const ticketRow = {
    ticket_id: newId,
    created_at: ts,
    updated_at: ts,
    order_id: targetOrderId,
    customer_email: contextData.from_email || '',
    email_ids: contextData.email_id || '',
    intent: contextData.intent || '',
    priority: elig.ticket_priority || (contextData.intent === 'complaint' ? 'High' : 'Medium'),
    status: 'Open',
    summary: contextData.summary || '',
    notes: newNoteEntry,
  };

  return {
    ...contextData,
    ticket_action: 'create',
    ticket_id: ticketRow.ticket_id,
    ticket_row: ticketRow,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { prepareTicketAction, nextTicketId, mergeEmailIds };
}

if (typeof $input !== 'undefined') {
  const existingTickets = $input.all().map((i) => i.json || {});
  const contextData = $('Evaluate Eligibility').first().json;
  return [{ json: prepareTicketAction({ contextData, existingTickets }) }];
}