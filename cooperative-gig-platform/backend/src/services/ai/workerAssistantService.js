/**
 * workerAssistantService.js
 *
 * ShramikSetu AI Assistant — general-purpose conversational AI powered by an
 * AI provider with automatic failover (primary → fallbacks).
 *
 * Architecture:
 *   Worker question → chatWithFallback (aiOrchestrator)
 *     → primary provider (Gemini by default)
 *     → on failure → next configured provider (Groq → xAI → OpenAI)
 *   When the question needs ShramikSetu data, the provider calls tools and
 *   the orchestrator queries MongoDB through geminiDataTools.
 */

const { chatWithFallback } = require('./aiOrchestrator');

const MAX_HISTORY_MESSAGES = 12;

/* Tools whose use indicates this answer is about demand/location — the
   platform can then offer a "View on Heatmap" action. */
const DEMAND_TOOLS = new Set([
  'getNearbyDemand',
  'getDemandBySkill',
  'getDemandTrend',
  'getAvailableJobs',
]);

/* Tool action labels stay in English (UI tooltip), but the reply follows the
   worker's selected language. */
function buildActions(dataUsed) {
  if (Array.isArray(dataUsed) && dataUsed.some((t) => DEMAND_TOOLS.has(t))) {
    return [{ type: 'VIEW_HEATMAP', label: 'View on Heatmap' }];
  }
  return [];
}

function buildLanguagePrompt(language) {
  const norm = String(language || '').toLowerCase();
  if (norm.startsWith('bn') || norm === 'bengali') {
    return "Respond in **Bengali (বাংলা)**. Use the Bengali script throughout your reply.";
  }
  if (norm === 'hi' || norm === 'hindi') {
    return "Respond in **Hindi (हिंदी)**. Use the Devanagari script throughout your reply.";
  }
  if (norm === 'hinglish') {
    return "Respond in **Hinglish** — Hindi words written in the Latin (Roman) script, the way Indian workers talk on chat. Keep numbers and English tech-terms in English.";
  }
  return "Respond in **English**.";
}

/* ───────────────── System prompt ──────────────────────────────────── */

const SYSTEM_PROMPT = `You are the **ShramikSetu AI Assistant**, a helpful, friendly, and knowledgeable personal AI for service workers (plumbers, electricians, carpenters, cleaners, appliance repair workers, etc.) on the ShramikSetu platform in India.

## Your Role
- You are a supportive assistant that helps workers grow their career, earn more, learn new skills, and manage their jobs.
- You understand English, Hindi, Hinglish, and Bengali. Respond naturally in the SAME language/script the worker uses.
- Be warm, encouraging, and practical. Use simple language a service worker can understand.
- Use Markdown formatting for structured responses (bold, bullet points, headers).

## ShramikSetu Platform Data
You have access to the worker's personal data and platform demand data through tool calls. Use these tools ONLY when the question actually needs platform-specific data.

**When to call tools:**
- Questions about the worker's own earnings, jobs, ratings, skills → call the relevant tool
- Questions about demand, which area to go, what skill to learn → call demand/skill tools
- Questions about a specific job (booking number) → call getJobDetails
- Questions about when to work → call getDemandTrend
- Earning / job-volume questions ("How can I earn more?", "Why am I getting fewer jobs?") → combine getWorkerEarnings with getWorkerPerformance, getWorkerAvailability, getDemandTrend, and getDemandBySkill so the advice is backed by real data (peak hours, schedule gaps, in-demand skills, high-demand areas)
- Skill-learning questions ("Which skill should I learn?") → combine getWorkerProfile with getDemandBySkill and getNearbyDemand to compare the worker's skills against demand and competition

**When NOT to call tools:**
- General knowledge questions (GST, English, math, technical concepts)
- Learning requests (teach me plumbing, explain AC repair)
- Communication help (write a message to customer)
- Translation requests
- Career advice not requiring personal data

**View on Heatmap:**
- The platform offers an interactive demand heatmap (built from the same real demand data your tools read).
- When your answer involves demand or location guidance, you can mention there is a heatmap, and the app will automatically offer a "View on Heatmap" action beneath your response.

## Data Honesty Rules — CRITICAL
- NEVER fabricate numbers, percentages, earnings, or job statistics
- ONLY use numbers that come from tool call results
- If data is insufficient, say: "I don't have enough ShramikSetu data yet to make a reliable recommendation. As more jobs are completed, your insights will become more personalized."
- Clearly distinguish between general AI knowledge and ShramikSetu platform data
- Never guarantee income. Use phrases like "potential opportunity", "may increase chances", "higher demand"

## Privacy Rules — CRITICAL
- NEVER reveal other workers' private information
- NEVER reveal customer addresses or personal details beyond what's necessary
- NEVER mention API keys, database details, or technical backend info
- Only discuss the current worker's own data
- If asked about another worker's data, politely decline

## Language & Tone
- Respond in the same language/script the worker uses (English, Hindi, Hinglish, Bengali)
- Be concise but helpful
- Use emoji sparingly for warmth (📍, 💰, 🎯, 📊, ⭐, 💡, 🔧)
- Format key numbers in bold
- When giving advice, always explain WHY based on the data

## Safety
- Do not help with anything illegal or harmful
- If the worker asks about sensitive account issues, direct them to ShramikSetu support
- Do not auto-accept or auto-reject jobs — the worker decides
`;

/* ───────────────── Conversation history formatting ────────────────── */

/**
 * Normalise the frontend's [{role, text}] history into the canonical
 * [{role: 'user'|'assistant', content}] shape the orchestrator expects.
 */
function formatHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return [];

  const trimmed = history.slice(-MAX_HISTORY_MESSAGES * 2);
  return trimmed
    .filter((m) => m && m.role && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.text,
    }));
}

/* ───────────────── Main chat function ─────────────────────────────── */

/**
 * Chat with the ShramikSetu AI Assistant.
 *
 * @param {ObjectId} workerId - The worker's profile ID
 * @param {string} message - The worker's message
 * @param {Array} conversationHistory - Previous messages [{role, text}]
 * @param {string} language - Preferred response language ('en', 'hi', 'hinglish', 'bn', ...)
 * @returns {{ reply: string, dataUsed: string[], actions: Array }}
 */
async function chat(workerId, message, conversationHistory = [], language = 'en') {
  if (!message || !message.trim()) {
    return { reply: 'Please type a question and I\'ll help!', dataUsed: [], actions: [] };
  }

  const history = formatHistory(conversationHistory);
  const langInstruction = buildLanguagePrompt(language);
  const fullSystemPrompt = SYSTEM_PROMPT + `\n\n## Active Language Instruction\n${langInstruction}\n\nThis instruction overrides any conflicting language guidance above.`;

  try {
    const { reply, dataUsed } = await chatWithFallback({
      systemPrompt: fullSystemPrompt,
      history,
      message: message.trim(),
      workerId,
    });
    return { reply, dataUsed, actions: buildActions(dataUsed) };
  } catch (err) {
    // The orchestrator returns nothing raw — friendly messages only.
    if (err.code === 'NO_PROVIDER') {
      return {
        reply: 'The AI assistant is not configured yet. Please ask the administrator to set at least one provider API key (for example GEMINI_API_KEY) in the environment variables.',
        dataUsed: [],
        actions: [],
      };
    }

    // ALL_PROVIDERS_FAILED — every configured provider failed. err.kind tells
    // us WHY (QUOTA / RATE_LIMIT / NETWORK / CONFIG / HTTP) so the UI can offer
    // a "wait and retry" action instead of an unhelpful dead generic message.
    const kind = err?.kind || (err.code === 'ALL_PROVIDERS_FAILED' ? 'HTTP' : undefined);
    const retryable = ['QUOTA', 'RATE_LIMIT', 'NETWORK', 'HTTP'].includes(kind);
    if (err.code === 'ALL_PROVIDERS_FAILED') {
      const reply = retryable
        ? 'The AI provider is temporarily rate-limited. Please wait about a minute and try again — your request was not lost.'
        : 'AI Assistant is temporarily unavailable. Please try again shortly.';
      return { reply, dataUsed: [], actions: [], errorKind: kind, retryable };
    }

    console.error('[AI Assistant] All providers failed:', err.message);
    return {
      reply: 'AI Assistant is temporarily unavailable. Please try again shortly.',
      dataUsed: [],
      actions: [],
    };
  }
}

module.exports = { chat, formatHistory, SYSTEM_PROMPT, buildLanguagePrompt };