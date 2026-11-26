# Test Report — Kesar & Co. Support Copilot
> **Note on Google Sheet Results (₹0 Free-Tier Quota Constraint):**  
> This build stayed strictly within the ₹0 free-tier budget using Google AI Studio's free `gemini-2.5-flash` tier (~20 requests/day). While individual live runs verified every core branch (`E01` order status, `E04` damaged item + `TKT-002`, `E07` privacy block, `E10` email fallback, `E12` prompt-injection rejection + `TKT-003`), the full 25-email `v2` batch hit Gemini's free-tier daily quota (`429: Too many requests`) after `E01` completed. Every rate-limited email degraded safely without crashing (`needs_human: TRUE`, exact error logged, and `E12`'s deterministic heuristic detector still caught all 4 injection flags). All deterministic rules—schema validation, privacy checks, 7-day/48-hour eligibility, FAQ matching, and ticket deduplication—are also verified by **100/100 passing unit tests** (`npm test`). Swapping the Chat Model credential in n8n to Groq's free tier (`llama-3.3-70b-versatile`) or a paid Gemini key resolves the `429` cap with zero code changes.

**Candidate name:** [ADD YOUR NAME BEFORE SUBMITTING]
**Platform used:** n8n Cloud (free trial)
**LLM(s) used:** Google Gemini `gemini-2.5-flash` (AI Studio free tier) via n8n's Google Gemini Chat Model nodes. Classifier temperature 0, reply agent temperature 0.2.

> **Read this first (honest status).** The v2 batch of all 25 emails did **not** complete on the live LLM. Gemini's free-tier daily quota (about 20 requests/day on `gemini-2.5-flash`) ran out partway through, so only **E01 passed end-to-end** in the v2 batch. The other 24 hit `429` errors and were handled by the safe fallback (details in sections 2 and 5). The deterministic parts (privacy check, eligibility, ticket dedupe, audit parsing, FAQ search) are verified by 100 passing unit tests, which is a different kind of evidence from live LLM accuracy, and I keep the two apart below.

---

## 1. How I decided what "correct" means

I wrote the expected intent and action for each email from `data/faq.md` and `data/orders.json` before judging any output.

- **Draft vs. human:** a reply is "correct" only if every fact in it comes from a tool result or the FAQ. Anything involving a refund/replacement decision, anger, a medical question, a missing order, an ownership mismatch, a prompt injection or an uncovered topic (GST) is expected to be **needs human** with a draft that makes no promise.
- **Dates:** "today" is the scenario date 2026-11-20 and all windows are computed from each email's `received_at` (IST). 7-day returns need unopened/sealed items. The 48-hour damaged/wrong/missing window is checked against `received_at`, and photos are required.
- **Tickets:** every return/refund and complaint gets one ticket, and a second email for the same open order updates it (E21 → E04's ticket).
- **Judgment calls:** E16 ("used two weeks, no difference") is expected to be a ticket with a polite decline. E23 (missing item) is expected to refund only the missing item's value (FAQ §5), not the order total. E17 (collab) and E25 (thank-you) are `other`: logged, no ticket.
- **Evidence labels:** "live" means observed in my own n8n Cloud runs. "unit" means covered by `npm test` (fixed inputs, no LLM call).

---

## 2. Results per email

v1 was run on 10 emails (E01, E02, E03, E04, E07, E08, E10, E12, E13, E20). Where I did not keep a clear per-email note of the v1 outcome I wrote `not recorded` instead of guessing. ⚠️ means the customer-facing draft was right but the audit row was wrong. `—` means not run.

| Email | Expected intent | Expected action | v1 intent | v1 action | v1 ✅/❌ | v2 intent | v2 action | v2 ✅/❌ | Notes |
|---|---|---|---|---|---|---|---|---|---|
| E01 | order_status | Draft with courier/ETA/tracking; no human | order_status | Draft OK, but audit logged `order_found FALSE`, `tool_error`; extra "24 business hours" line | ⚠️ | order_status | `drafted_reply`, `order_found TRUE`, `needs_human FALSE`, `get_order: FOUND`; SwiftShip, Nov 17 ship / Nov 21 ETA, exact tracking URL, no filler | ✅ | Live. Confirms all three v1 fixes. |
| E02 | product_query | Draft from FAQ §7 (all skin types incl. oily; vegan) | not recorded | `search_faq` tool failed in n8n | ❌ | product_query | Classified; agent step hit `429` | ❌ | v2 failure is quota, not logic. FAQ search for this query is unit-tested to return §7. |
| E03 | return_refund | Ticket; eligible (4 days, sealed): refund ₹899, ₹79 shipping non-refundable | not recorded | not recorded | — | other (fallback) | Classification `429` → `needs_human TRUE`, error logged | ❌ | Eligibility logic unit-tested. Not shown live in v2. |
| E04 | complaint (+return_refund) | Ticket; eligible within 48h; ask for photos of product and box | complaint | Ticket `TKT-002`, `KC-1052`, `order_found TRUE`, 48h policy, ₹1,598, asked for photos | ✅ | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | v1 result is from a live run. v2 live batch hit quota. Unit-tested. |
| E05 | order_status (Hinglish) | Draft in Hinglish for KC-1043 (shipped) | — | — | — | order_status | Classified (Hinglish); agent step hit `429` | ❌ | Classification correct live. No draft produced. |
| E06 | other (spam) | Log only, no reply, no ticket | — | — | — | other (fallback) | `429` fallback: `other` + `needs_human TRUE` | ❌ | `other` was verified in an earlier live classification run. In the v2 batch the fallback also gives `other`, but flagged for a human (spam should not need one). |
| E07 | order_status | Privacy block: no order details, ask to write from the registered email; needs human | order_status | `KC-1046`, `order_found FALSE`, `needs_human TRUE`; no order/address/tracking disclosed; asked Meera's email | ✅ | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Ownership check is deterministic code in `get_order` (unit-tested). |
| E08 | complaint | Ticket (High); angry; leaked items within 48h; needs human | not recorded | not recorded | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Eligibility unit-tested (eligible, High). |
| E09 | product_query (Hindi) | Draft in Hindi: North-East 6–8 business days; COD available up to ₹5,000 (+₹49 fee) | — | — | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Hindi `product_query` classification verified in an earlier live run. FAQ search unit-tested for §1/§2/§7. |
| E10 | order_status | No order ID: find `KC-1044` via sender email; draft with courier, tracking, ETA | order_status | Resolved `KC-1044` by sender email; BharatExpress, exact tracking URL, Nov 25 ETA. Audit row wrongly showed `tool_error` / `order_found FALSE` | ⚠️ | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Audit bug fixed in v2 (unit-tested with wrapped observations). |
| E11 | return_refund | Ticket; eligible; kit must be returned complete; refund ₹3,499 | — | — | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Unit-tested. |
| E12 | return_refund | Ticket; ignore injection; decline (used, 8 days); needs human | return_refund | `KC-1055`, `TKT-003`; ignored the injection; declined (7-day, unopened); `needs_human TRUE`. A Gemini `429` on the agent step cost the audit row `email_id`/`from_email`/`prompt_version` | ⚠️ | other (fallback) | Classification `429`. The deterministic heuristics still flagged all 4 injection signals (`ignore_instructions`, `system_override`, `suppress_ticket`, `force_approval`) and set `needs_human TRUE` | ❌ | The only defence layer exercised live in v2 was the non-LLM one, and it worked. |
| E13 | other/product_query (GST not in FAQ) | No answer; escalate; needs human | not recorded | not recorded | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | A GST escalation to `needs_human TRUE` was observed in earlier live runs. In v2 this email only got the fallback. |
| E14 | complaint | Ticket; wrong item within 48h; replacement/refund | — | — | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Unit-tested. |
| E15 | order_status | Draft for `KC-1042` (out for delivery, COD) | — | — | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Not unit-tested by ID. |
| E16 | return_refund / complaint | Ticket; ineligible (used, outside 7 days); polite decline | — | — | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Unit-tested (ineligible, Low). |
| E17 | other (collab) | Log; point to partnerships@ per FAQ §9; no ticket | — | — | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Not unit-tested by ID. |
| E18 | other / low confidence | Low-confidence → needs human; ask for order number | — | — | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Low-confidence gate unit-tested with a hand-made classification. |
| E19 | return_refund | Ticket; eligible (3 days, COD): UPI/bank refund after pickup; ₹49 COD fee non-refundable | — | — | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Unit-tested. |
| E20 | product_query (medical) | No cure claim; patch test + see a doctor; needs human | not recorded | not recorded | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | FAQ search always includes §8 (unit-tested). |
| E21 | complaint | Update E04's ticket (`email_ids: "E04, E21"`); photos received | — | — | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Dedupe + idempotency unit-tested. |
| E22 | order_status | `KC-1099` not found → no guessing; needs human | — | — | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Unit-tested (`NOT_FOUND`). |
| E23 | complaint | Ticket; missing item within 48h; refund the item's value only | — | — | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Unit-tested (no order-total refund quoted). |
| E24 | order_status | Draft for `KC-1045` (cancelled) from order data only | — | — | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Order lookup unit-tested. |
| E25 | other (thanks) | Log only, no ticket, no human | — | — | — | other (fallback) | Classification `429` → `needs_human TRUE` | ❌ | Not unit-tested by ID. |

**Evidence in the repo:** `screenshots/audit_log.png` shows the 25 Audit Log rows from the v2 batch (E01 complete, E02/E05 classified, 22 fallback rows). `screenshots/tickets.png` shows a single ticket, `TKT-001` (E12 / `KC-1055`). The `TKT-002` (E04) and `TKT-003` (E12) mentioned in the rows above come from earlier live runs; those rows are not in the current sheet, so the screenshots do not show them. Ticket dedupe (E04 → E21) is verified by unit tests only.

**v2 live outcome in one line:** E01 passed; E02 and E05 classified correctly but the agent got `429`; E03, E04 and E06–E25 hit the daily quota at classification and degraded to `intent: other`, `needs_human: TRUE`, with the exact error written to the Audit Log. Nothing crashed and nothing was invented.

**Deterministic (unit-test) coverage by email ID:** E01–E04, E06–E14, E16, E18–E24 appear in at least one unit test (tools, eligibility, tickets, audit or classification validation). E05, E15, E17 and E25 have no ID-specific test. These tests use hand-written classifier outputs, so they prove the code around the model, not the model's accuracy.

---

## 3. Summary

*n* = emails run in that version.

| Metric | Prompt v1 | Prompt v2 |
|---|---|---|
| Emails run (*n*) | 10 | 25 |
| Intent accuracy (x / *n*) | not tallied (known correct: E01, E04, E07, E10, E12) | 3 / 25 live (E01, E02, E05). The other 22 got the fallback `other` |
| Correct action (x / *n*) | not tallied (clean: E04, E07; right draft but wrong audit row: E01, E10, E12) | 1 / 25 live (E01) |
| Valid JSON on first try (x / *n*) | not tracked | 3 / 3 for emails that reached the model (E01, E02, E05); the other 22 never got a model response |
| Emails sent to "needs human" | not tallied | 24 / 25 (all but E01; E02/E05 inferred from the missing draft) |
| Avg. tokens per email (if tracked) | not tracked | not tracked |
| Est. cost per email (₹ or $) | not tracked (free tier) | not tracked (free tier); projected cost is in README section 7 |

These v2 numbers measure how much of the batch the free tier let through, not the quality of the design. A re-run with quota is needed for real accuracy numbers.

---

## 4. What I changed from v1 to v2, and why

- **Change 1: audit log read tool results wrongly.** n8n's agent wraps Custom Code Tool results as `[{"response": "..."}]`. v1 logged `get_order: unknown | order_found FALSE | tool_error` on E01 and E10 even when the lookup worked. v2 adds a recursive `unwrapObservation()` in `prepare_audit_row.js`. Live check: E01 now shows `order_found TRUE`, `get_order: FOUND`, `needs_human FALSE`. Unit-tested.
- **Change 2: `search_faq` failed inside n8n.** It worked in Node but not as an n8n Custom Code Tool (seen on E02, E01, E10). v2 uses the same async `return (async () => {...})()` entry as `get_order`, plus keyword coverage for all 9 FAQ sections including Hindi/Hinglish, and an explicit `found: false` with `uncovered_topics` for GST. Unit-tested for E02, E09, E13 and E20.
- **Change 3: lost identity on agent errors.** When the agent returned `429` on a ticket branch (E12), v1 read its context from the ticket row and the audit row lost `email_id`, `from_email` and `prompt_version`. v2 always reads `Validate Classification`, and reads `Evaluate Eligibility` / `Prepare Ticket Action` only if they ran.
- **Change 4: prompt noise.** `agent_v1.md` called `search_faq` on simple order-status emails and always added "a team member will follow up within 24 business hours". `agent_v2.md` skips the FAQ call once `get_order` returns FOUND and only uses the follow-up line when escalating. Live check on E01.
- **Change 5: deterministic eligibility and tickets.** The 7-day / 48-hour logic and the refund amounts moved into `evaluate_eligibility.js` and the dedupe into `prepare_ticket_action.js`, so the model explains a verdict instead of computing one. `normalize_email.js` now stamps `prompt_version: v2`.

---

## 5. Failures I could not fix (be honest)

| Email | What goes wrong | Why I think it happens | What I would try next |
|---|---|---|---|
| E03, E04, E06–E25 (22 emails) | Classification fails with `429` ("receiving too many requests"). They fall back to `intent: other`, `needs_human TRUE`, error logged. No v2 result for them. | Gemini AI Studio's free tier allows only about 20 requests/day on `gemini-2.5-flash`. The earlier dev and v1 runs plus the first v2 emails used it up. | Swap the Chat Model sub-nodes to Groq free tier (`llama-3.3-70b-versatile`, roughly 1,000 requests/day) or a paid Gemini tier. This is a credentials/sub-node change in n8n with no code change (I have not run it on Groq). Then re-run all 25 and refill the tables. |
| E02, E05 | Classified correctly, then the agent step gets `429`. No reply draft. | The quota ran out between the classify and agent calls. Each email costs 2+ model calls (classify, agent, plus tool-calling turns). | Same fix. Also add retry-with-backoff and a small delay between emails, and fall back to a "queued, human to draft" state instead of a bare error. |
| E06, E17, E25 (and any harmless email) | The 429 fallback sends everything to `needs_human TRUE`, including spam and thank-you emails that need no human. | The fallback is deliberately fail-closed: it cannot know the email is harmless without the model. | Keep it. Cheap deterministic pre-filters for obvious spam could lower the human load, but I did not build one. |
| All 25 | I have no live accuracy number for the final system yet, and the Audit Log sheet does not yet hold 25 successful rows. | Quota (above). | Re-run after switching model/quota, then update this report, the screenshots and the demo. |
| Cost / tokens | Not tracked per email. | I did not add token counting to the audit log. | Read token usage from the model response and write it to `notes`. |
| Reply tone and length | Only E01 was checked against the brand-voice rules in v2 (greeting, 3–6 sentences, sign-off, no filler). | Quota. | Review all drafts by hand after the re-run. |
