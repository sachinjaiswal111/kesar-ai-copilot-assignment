'use strict';
/**
 * tool_search_faq.js  (Phase 3)
 *
 * FAQ retrieval for the AI Agent's `search_faq` tool.
 *
 * Approach: split faq.md on "## " headings, then match the query against a hand-written
 * bilingual (English / Hindi / Hinglish) keyword map per section. Matching is
 * deliberately conservative: a miss returns { found: false } and the agent escalates,
 * which is safe; a false hit could put the wrong policy in front of a customer.
 * (We do NOT match on free body-text overlap for that reason.)
 *
 * - Section 8 (Product Safety & Medical) is always included when any health/skin-condition,
 *   allergy, pregnancy or reaction keyword is present.
 * - Topics the FAQ does not cover (GST invoice) are reported in `uncovered_topics`; if
 *   nothing else matches the result is found:false.
 *
 * Works in Node (CommonJS, unit tests) AND pasted into an n8n Custom Code Tool.
 */

const FAQ_URL =
  'https://raw.githubusercontent.com/abhishek-patel-cadient/kesar-ai-copilot-assignment/refs/heads/main/data/faq.md';
const MAX_SECTIONS = 4;
const MEDICAL_SECTION = 8;

const NOT_FOUND_MESSAGE =
  'No FAQ policy or product information covers this question. Do NOT guess; escalate to a human.';

// Section number -> trigger terms (lowercase). ASCII terms match on word boundaries with
// simple plural/tense suffixes; non-ASCII (Devanagari) terms match as substrings.
const SECTION_TERMS = {
  1: ['shipping', 'ship', 'delivery', 'deliver', 'dispatch', 'courier', 'tracking', 'track', 'how long', 'how many days',
    'delivery time', 'north-east', 'north east', 'northeast', 'guwahati', 'assam', 'kashmir', 'ladakh', 'metro', 'free shipping',
    'shipping fee', 'shipping charge', 'outside india', 'international', 'abroad', 'change address', 'kab aayega', 'kab tak',
    'kitne din', 'swiftship', 'bharatexpress',
    'डिलीवरी', 'डिलिवरी', 'शिपिंग', 'गुवाहाटी', 'असम', 'पूर्वोत्तर', 'कितने दिन', 'कब तक', 'पहुंच'],
  2: ['cod', 'cash on delivery', 'cash', 'handling fee', 'कैश ऑन डिलीवरी', 'कैश ऑन डिलिवरी', 'कैश'],
  3: ['cancel', 'cancell', 'cancellation', 'कैंसिल', 'रद्द'],
  4: ['return', 'exchange', 'send back', 'sealed', 'unopened', 'wapas', 'रिटर्न', 'वापस'],
  5: ['damaged', 'damage', 'broken', 'cracked', 'leak', 'leaked', 'leaking', 'spilled', 'wrong item', 'wrong product',
    'missing', 'replacement', 'replace', 'लीक', 'टूटा', 'खराब', 'गलत'],
  6: ['refund', 'money back', 'paisa wapas', 'upi', 'credited', 'रिफंड'],
  7: ['serum', 'oil', 'toner', 'kit', 'bridal', 'ubtan', 'face pack', 'gel', 'lotion', 'aloe', 'saffron', 'kumkumadi',
    'bhringraj', 'rose water', 'sandalwood', 'vegan', 'cruelty-free', 'cruelty free', 'paraben', 'oily', 'dry skin', 'skin type',
    'price', 'cost', 'ingredient', 'shelf life', 'expiry', 'beeswax', 'vitamin c', 'hair', 'किट', 'केसर', 'कीमत', 'वीगन'],
  8: ['eczema', 'psoriasis', 'acne', 'pimple', 'rash', 'reaction', 'allergy', 'allergic', 'allergies', 'pregnant', 'pregnancy',
    'breastfeeding', 'medical', 'medicine', 'doctor', 'dermatologist', 'cure', 'cured', 'treat', 'treatment', 'heal', 'disease',
    'infection', 'itching', 'itchy', 'burning', 'irritation', 'redness', 'swelling', 'patch test', 'sensitive', 'skin condition',
    'एक्जिमा', 'एग्जिमा', 'खुजली', 'एलर्जी', 'गर्भावस्था', 'प्रेग्नेंसी', 'इलाज', 'दाने', 'रैश'],
  9: ['contact', 'phone', 'call', 'whatsapp', 'support hours', 'working hours', 'business hours', 'partnership', 'collab',
    'wholesale', 'influencer', 'press', 'email address', 'संपर्क'],
};

// Things the FAQ does not answer. Reported so the agent can't pretend a nearby section covers them.
const UNCOVERED_TERMS = {
  'GST invoice': ['gst', 'gstin', 'gst invoice', 'tax invoice', 'invoice', 'जीएसटी', 'इनवॉइस', 'इन्वॉइस'],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function termRegex(term) {
  if (/^[\x00-\x7f]+$/.test(term)) return new RegExp(`\\b${escapeRe(term)}(?:s|es|ed|d|ing)?\\b`, 'i');
  return new RegExp(escapeRe(term));
}

const COMPILED = Object.fromEntries(
  Object.entries(SECTION_TERMS).map(([n, terms]) => [n, terms.map((t) => ({ t, re: termRegex(t) }))])
);
const COMPILED_UNCOVERED = Object.entries(UNCOVERED_TERMS).map(([topic, terms]) => ({
  topic,
  res: terms.map(termRegex),
}));

/** Split faq.md into { intro, sections: [{ number, title, content }] } on "## " headings. */
function parseFaqSections(faqMarkdown) {
  const text = String(faqMarkdown || '').replace(/\r\n/g, '\n');
  const parts = text.split(/^## /m);
  const clean = (s) => s.replace(/^---\s*$/gm, '').trim();
  const intro = clean(parts[0]);
  const sections = parts.slice(1).map((p) => {
    const nl = p.indexOf('\n');
    const heading = (nl === -1 ? p : p.slice(0, nl)).trim();
    const m = heading.match(/^(\d+)\.\s*(.*)$/);
    return {
      number: m ? Number(m[1]) : null,
      title: m ? m[2].trim() : heading,
      content: clean(nl === -1 ? '' : p.slice(nl + 1)),
    };
  });
  return { intro, sections };
}

function searchFaq(query, faqMarkdown) {
  const q = (typeof query === 'string' ? query : JSON.stringify(query || ''))
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’]/g, "'");
  const { sections } = parseFaqSections(faqMarkdown);

  const scored = sections
    .map((s) => ({ s, score: (COMPILED[s.number] || []).filter(({ re }) => re.test(q)).length }))
    .filter((x) => x.score > 0);

  const uncovered = COMPILED_UNCOVERED.filter(({ res }) => res.some((re) => re.test(q))).map((u) => u.topic);

  scored.sort((a, b) => b.score - a.score || a.s.number - b.s.number);
  let picked = scored.slice(0, MAX_SECTIONS);

  // Medical safety section is mandatory whenever a health keyword fired.
  const medical = scored.find((x) => x.s.number === MEDICAL_SECTION);
  if (medical && !picked.includes(medical)) picked = [...picked.slice(0, MAX_SECTIONS - 1), medical];

  if (picked.length === 0) {
    const out = { found: false, matched_sections: [], query, message: NOT_FOUND_MESSAGE };
    if (uncovered.length) out.uncovered_topics = uncovered;
    return out;
  }

  const out = {
    found: true,
    query,
    matched_sections: picked.map(({ s }) => ({ title: `${s.number}. ${s.title}`, content: s.content })),
  };
  if (uncovered.length) {
    out.uncovered_topics = uncovered;
    out.note = `The FAQ does NOT cover: ${uncovered.join(', ')}. Do not answer that part; a team member must follow up.`;
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseFaqSections, searchFaq, FAQ_URL, SECTION_TERMS };
}

// ---- n8n Custom Code Tool entry. `query` is injected by n8n; absent under Node tests. ----
if (typeof query !== 'undefined') {
  return (async () => {
    try {
      let md;
      if (typeof this !== 'undefined' && this && this.helpers && this.helpers.httpRequest) {
        md = await this.helpers.httpRequest({ method: 'GET', url: FAQ_URL, json: false });
      } else {
        md = await (await fetch(FAQ_URL)).text();
      }
      if (md && typeof md !== 'string') md = typeof md.body === 'string' ? md.body : String(md);
      return JSON.stringify(searchFaq(query, md));
    } catch (err) {
      return JSON.stringify({ found: false, matched_sections: [], message: 'FAQ lookup failed. Do NOT guess; escalate to a human.' });
    }
  })();
}
