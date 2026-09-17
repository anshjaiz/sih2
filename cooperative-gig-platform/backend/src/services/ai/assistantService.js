/**
 * assistantService.js
 *
 * ShramikSetu AI Home & Service Assistant — the upgraded general-purpose
 * conversational AI for BOTH customers and workers.
 *
 * It augments the base conversational assistant with:
 *  1. Live service-catalog injection so the model can semantically match a
 *     home/service problem to the ACTUAL categories available on the platform
 *     (not hardcoded keywords).
 *  2. A safety layer: no DIY steps for live wiring / panels / gas / chemicals /
 *     high-pressure / structural / fire-hazard problems.
 *  3. Emergency guidance (call 112 / local emergency first).
 *  4. Clarifying follow-up questions when the description is ambiguous.
 *  5. A machine-readable structured block (JSON) appended to service-problem
 *     answers so the app can render diagnosis cards + a direct booking CTA.
 *  6. Multilingual replies (en / hi / hinglish / bn) via buildLanguagePrompt.
 *  7. Automatic provider failover (Gemini → Groq → xAI) — invisible to users —
 *     and a friendly fallback (with a "Browse Services" shortcut) if all fail.
 */

const { chatWithFallback } = require('./aiOrchestrator');
const { toolDeclarations } = require('./geminiDataTools');
const { SYSTEM_PROMPT, buildLanguagePrompt } = require('./workerAssistantService');
const Service = require('../../models/Service');

/* Tools whose use indicates the answer is demand/location related — the
   platform can then offer a "View on Heatmap" action. */
const DEMAND_TOOLS = new Set([
  'getNearbyDemand',
  'getDemandBySkill',
  'getDemandTrend',
  'getAvailableJobs',
]);

const SUPPORTED_URGENCIES = new Set(['normal', 'high', 'emergency']);

const MAX_HISTORY_MESSAGES = 12;

/* ───────────────── Structured output parsing ───────────────────────── */

/**
 * Extract the machine-readable JSON block appended to a service-problem
 * answer and strip it from the human-readable reply text.
 *
 * Prefers a fenced ```json ... ``` block (as the system prompt asks for),
 * then a <service_advice>…</service_advice> tombstone, then a trailing {}.
 *
 * @returns {{ text: string, diagnosis: object|null }}
 */
function extractStructuredBlock(text) {
  const source = String(text || '').trim();
  if (!source) return { text: '', diagnosis: null };

  const fence = /```(?:json)?\s*([\s\S]*?)```/;
  const fenceMatch = fence.exec(source);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && typeof parsed === 'object') {
        const rest = source.slice(0, fenceMatch.index) + source.slice(fenceMatch.index + fenceMatch[0].length);
        return { text: rest.replace(/```*\s*<\/?service_advice>?/g, '').trim(), diagnosis: parsed };
      }
    } catch (e) {
      /* fall through */
    }
  }

  const tombstone = /<service_advice>\s*(\{[\s\S]*?\})\s*<\/service_advice>/;
  const tombMatch = tombstone.exec(source);
  if (tombMatch) {
    try {
      const parsed = JSON.parse(tombMatch[1].trim());
      if (parsed && typeof parsed === 'object') {
        const rest = source.slice(0, tombMatch.index) + source.slice(tombMatch.index + tombMatch[0].length);
        return { text: rest.trim(), diagnosis: parsed };
      }
    } catch (e) {
      /* fall through */
    }
  }

  const lastOpen = source.lastIndexOf('{');
  const lastClose = source.lastIndexOf('}');
  if (lastOpen >= 0 && lastClose > lastOpen) {
    const candidate = source.slice(lastOpen, lastClose + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return { text: source.slice(0, lastOpen).trim(), diagnosis: parsed };
      }
    } catch (e) {
      /* fall through */
    }
  }

  return { text: source, diagnosis: null };
}

/* ───────────────── Service recommendation resolution ──────────────── */

/**
 * Map the model-chosen recommendedService (a standardized category name or a
 * service name) onto a real active Service doc so the frontend can deep-link
 * into the booking flow with the service pre-selected.
 */
function resolveRecommendedService(recommendedServiceRaw, services) {
  const raw = String(recommendedServiceRaw || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  // exact service-name match first, then category match, then fuzzy contains
  const nameExact = services.find((s) => s.name.toLowerCase() === lower);
  if (nameExact) return nameExact;

  const namedCat = services.find((s) => s.category.toLowerCase() === lower);
  if (namedCat) return namedCat;

  const nameFuzzy = services.find(
    (s) => s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase())
  );
  if (nameFuzzy) return nameFuzzy;

  const catFuzzy = services.find((s) => s.category.toLowerCase().includes(lower));
  return catFuzzy || null;
}

function normalizeDiagnosis(raw, services) {
  if (!raw || typeof raw !== 'object') return null;

  const urgencyRaw = String(raw.urgency || 'normal').toLowerCase();
  const urgency = SUPPORTED_URGENCIES.has(urgencyRaw) ? urgencyRaw : 'normal';
  const bookingRecommended = Boolean(raw.bookingRecommended);
  const recommendedService = String(raw.recommendedService || '').trim();

  const matched = bookingRecommended || recommendedService
    ? resolveRecommendedService(recommendedService, services)
    : null;

  const possibleCauses = Array.isArray(raw.possibleCauses)
    ? raw.possibleCauses.filter((c) => typeof c === 'string' && c.trim()).slice(0, 6)
    : [];
  const diySteps = Array.isArray(raw.diySteps)
    ? raw.diySteps.filter((s) => typeof s === 'string' && s.trim()).slice(0, 8)
    : [];

  return {
    intent: String(raw.intent || 'service_problem'),
    problemSummary: String(raw.problemSummary || ''),
    needsMoreInfo: Boolean(raw.needsMoreInfo),
    possibleCauses,
    diyPossible: Boolean(raw.diyPossible),
    diyRiskNote: String(raw.diyRiskNote || ''),
    diySteps,
    professionalHelpRecommended: Boolean(raw.professionalHelpRecommended),
    safetyWarning: String(raw.safetyWarning || ''),
    recommendedService,
    subCategory: String(raw.subCategory || ''),
    urgency,
    bookingRecommended,
    serviceId: matched ? String(matched._id) : null,
    serviceName: matched ? matched.name : '',
    basePrice: matched ? matched.basePrice : null,
  };
}

/* ───────────────── Actions ────────────────────────────────────────── */

function buildActions(dataUsed, diagnosis, role) {
  const actions = [];
  if (Array.isArray(dataUsed) && dataUsed.some((t) => DEMAND_TOOLS.has(t))) {
    actions.push({ type: 'VIEW_HEATMAP', label: 'View on Heatmap' });
  }
  if (role === 'customer' && diagnosis && diagnosis.bookingRecommended) {
    actions.push({ type: 'BROWSE_SERVICES', label: 'Browse Services' });
  }
  return actions;
}

/* ───────────────── System prompt ───────────────────────────────────── */

const SHARED_EXPERTISE = `
## Home & Service Problem Solving
When the user describes a home/services problem, act as an expert home-services assistant: diagnose likely causes, ask ONE clarifying question only if 1-2 more details would clearly help (still give a preliminary answer; set needsMoreInfo=true), and give SAFE DIY steps only when the problem is genuinely safe to try yourself — otherwise recommend a professional.

## SAFETY RULES — ABSOLUTE (never violate)
Never give DIY instructions — not even partial — for: (1) live electrical wiring/panels/mains/switchboards or any exposed voltage; (2) gas leaks or work on gas appliances, LPG cylinders, regulators or pipelines; (3) water near any live electrical equipment; (4) high-pressure systems (boilers, geysers/heaters, compressors, cylinders); (5) structural dangers (cracks in load-bearing walls, falling ceilings, masonry collapse); (6) hazardous chemicals (drain cleaners, pesticides, dangerous solvents, asbestos); (7) fire hazards (smoke, burning smells, sparking, overheating).
For those: give the ONE safe immediate action (turn off the main switch / close the gas regulator / evacuate and call emergency), strongly recommend a certified professional, set urgency "high" (or "emergency" when lives are at risk), professionalHelpRecommended=true, bookingRecommended=true, and fill safetyWarning with the key danger in the user's language. Never talk the user through a risky repair.

## Emergency situations
If there is immediate danger to people (fire, gas, shock, water touching live electricity, injury): first tell the user to call **112** (India) / local emergency and evacuate if needed, then continue safely. Set urgency="emergency".

## Booking & service recommendation
Choose recommendedService from the ACTUAL catalog below — return the exact category string (e.g. "Plumbing", "Electrical", "Carpentry", "Painting", "Cleaning", "Gardening", "Appliance Repair", "Domestic Help", "Caregiving", "Driving", "Other community services"). Set bookingRecommended=true when the user wants to book, the problem is unsafe for DIY, or it needs a specialist, and mention they can book right from the assistant.

## Structured output for service problems
End EVERY service-problem answer with a JSON code block (\\\`\\\`\\\`json …\\\`\\\`\\\`) containing EXACTLY: {"intent":"service_problem","problemSummary":"short, in the user's language","needsMoreInfo":bool,"possibleCauses":[...],"diyPossible":bool,"diyRiskNote":"...","diySteps":[...]|[],"professionalHelpRecommended":bool,"safetyWarning":"...","recommendedService":"exact category name","subCategory":"e.g. Tap repair","urgency":"normal|high|emergency","bookingRecommended":bool}
Keep machine fields in ENGLISH (intent, recommendedService, subCategory, urgency, booleans); free-text fields (problemSummary, possibleCauses, diySteps, diyRiskNote, safetyWarning) in the USER'S language. When no category fits, use the closest valid category (never invent one). If the answer is general/support/booking-help only, emit NO JSON block. The visible reply must still contain the complete helpful answer in the user's language (the JSON block renders as a diagnosis card in the app).

## Service catalog (live from the ShramikSetu platform)
`;

const CUSTOMER_SYSTEM_PROMPT = `You are the **ShramikSetu AI Home & Service Assistant**, a friendly, trustworthy assistant for customers of the ShramikSetu cooperative platform in India — a platform that connects households with verified local professionals (plumbers, electricians, carpenters, painters, cleaners, gardeners, appliance-repair technicians, domestic help, caregivers, drivers).

## Your Role
- Help customers describe and resolve home/service problems safely.
- Recommend the right professional service to book on ShramikSetu.
- Answer platform & support questions: how to book, cancel, pay, track, raise a complaint, refunds, why a worker hasn't arrived, and how worker verification works.

## Tone
- Be warm, clear and practical; use simple language and Markdown for structure.
- Respond in the SAME language/script the customer uses (English, Hindi, Hinglish, Bengali).
- Use emoji sparingly (🔧 💧 ⚡ 🏠 🧰).

## Privacy & Honesty
- NEVER ask for passwords, OTPs, or API keys. For account issues, direct the user to the app's support / complaints section.
- NEVER reveal other customers' or workers' private details.
- Do not fabricate platform facts or prices. Use the catalog base prices only when they come from the supplied data.

## No illegal or harmful help
- Decline clearly and redirect to the safe path above. If someone asks you to do something illegal or unsafe, stop and state the safe alternative.`;

const WORKER_SYSTEM_PROMPT = SYSTEM_PROMPT;

/**
 * Build the final system prompt for a role. For workers we keep the existing
 * career/demand/data assistant behaviour and append home-service expertise so
 * a worker can also use the assistant to answer customers or fix problems at
 * home. For customers we use the customer persona.
 */
function buildSystemPrompt(role, services) {
  const catalog = Array.isArray(services) && services.length
    ? Object.entries(
        services.reduce((byCat, s) => {
          (byCat[s.category] = byCat[s.category] || []).push(s);
          return byCat;
        }, {})
      )
        .map(([cat, list]) => `## ${cat}\n` + list.map((s) => `- ${s.name} (₹${s.basePrice}${s.emergencyAvailable ? ' • emergency' : ''})`).join('\n'))
        .join('\n')
    : '- (No services loaded — do not guess categories, recommend browsing the platform instead.)';

  const base = role === 'worker' ? WORKER_SYSTEM_PROMPT : CUSTOMER_SYSTEM_PROMPT;
  return `${base}\n\n${SHARED_EXPERTISE}\n${catalog}\n\nRemember: always write the visible answer in the user's language.`;
}

function buildLanguageInstruction(language) {
  const langInstruction = buildLanguagePrompt(language);
  return `## Active Language Instruction\n${langInstruction}\n\nThis instruction overrides any conflicting language guidance above.`;
}

/* ───────────────── Main chat function ─────────────────────────────── */

/**
 * Chat with the AI Home & Service Assistant.
 *
 * @param {object} opts
 * @param {'worker'|'customer'} opts.role
 * @param {string} opts.message
 * @param {Array} opts.conversationHistory - [{role, text}]
 * @param {string} opts.language
 * @param {string|null} opts.workerId - worker profile id (worker role; enables data tools)
 * @param {Array} opts.attachments - optional [{ mimeType, data }] inline images
 * @returns {Promise<{ reply, dataUsed, actions, diagnosis, errorCode }>}
 */
async function chat({ role, message, conversationHistory = [], language = 'en', workerId = null, attachments = [] }) {
  const isWorker = role === 'worker';

  if (!message || !message.trim()) {
    return { reply: 'Please describe your problem or question and I\'ll help!', dataUsed: [], actions: [], diagnosis: null, errorCode: null };
  }

  const history = formatHistoryFor(conversationHistory);

  const services = await Service.find({ isActive: true })
    .select('name category basePrice emergencyAvailable')
    .sort({ category: 1, name: 1 })
    .lean();

  const systemPrompt = buildSystemPrompt(role, services) + '\n\n' + buildLanguageInstruction(language);
  const tools = isWorker ? toolDeclarations : [];

  try {
    const { reply, dataUsed } = await chatWithFallback({
      systemPrompt,
      history,
      message: message.trim(),
      workerId: isWorker ? workerId : null,
      contextId: isWorker ? workerId : null,
      tools,
      attachments,
    });

    const { text, diagnosis: rawDiagnosis } = extractStructuredBlock(reply);
    const diagnosis = normalizeDiagnosis(rawDiagnosis, services);

    return {
      reply: text || reply,
      dataUsed,
      actions: buildActions(dataUsed, diagnosis, role),
      diagnosis,
      errorCode: null,
    };
  } catch (err) {
    if (err.code === 'NO_PROVIDER') {
      return {
        reply: '',
        dataUsed: [],
        actions: role === 'customer' ? [{ type: 'BROWSE_SERVICES', label: 'Browse Services' }] : [],
        diagnosis: null,
        errorCode: 'NO_PROVIDER',
      };
    }
    console.error('[AI Assistant] All providers failed:', err.message);
    return {
      reply: '',
      dataUsed: [],
      actions: role === 'customer' ? [{ type: 'BROWSE_SERVICES', label: 'Browse Services' }] : [],
      diagnosis: null,
      errorCode: 'ALL_PROVIDERS_FAILED',
      errorKind: err?.kind || null,
      retryable: ['RATE_LIMIT', 'QUOTA', 'NETWORK', 'HTTP'].includes(err?.kind),
      lastProvider: err?.provider || null,
    };
  }
}

/* Normalise [{role, text}] → [{role, content}]. */
function formatHistoryFor(history) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES * 2);
  return trimmed
    .filter((m) => m && m.role && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.text,
    }));
}

module.exports = { chat, extractStructuredBlock, buildSystemPrompt, normalizeDiagnosis };