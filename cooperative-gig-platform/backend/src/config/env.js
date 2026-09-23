const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const parseList = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

module.exports = {
  port: process.env.PORT || 5001,
  mongoURI: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cooperative_gig_platform',
  jwtSecret: process.env.JWT_SECRET || 'dev_secret_change_me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  clientURL: process.env.CLIENT_URL || 'http://localhost:5173',
  osrmBaseUrl: process.env.OSRM_BASE_URL || 'https://router.project-osrm.org',
  // ── Scheduling timezone ───────────────────────────────────────────
  // IANA timezone used to interpret customer chosen date + time-slot
  // (e.g. "Afternoon" = 12:00 → 17:00) into absolute instants. Pinned here so
  // the derived job window does NOT depend on the host/server timezone (hosts
  // often run UTC, which shifts an Indian 12pm request to 5:30pm UTC+0).
  timeZone: process.env.TIME_ZONE || 'Asia/Kolkata',
  // ── Pre-job navigation window ──────────────────────────────────────
  // How many minutes before a scheduled job's start time the worker may
  // begin navigation/travel (navigation_available_time = scheduled start
  // minus this buffer). Configurable per deployment; defaults to 60 minutes.
  preJobNavigationBufferMins: (() => {
    const n = parseFloat(process.env.PRE_JOB_NAVIGATION_BUFFER);
    return Number.isFinite(n) && n >= 0 ? n : 60;
  })(),
  // ── Payments (Razorpay TEST mode) ──────────────────────────────────
  // Leave RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET empty to run the
  // built-in MOCK gateway (instant success, safe for offline demo).
  // Sever-side only — never expose the secret to the frontend.
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  // Platform fee % override. When empty, the fee is read from the live
  // Cooperative settings collection (admin-configurable) instead.
  platformFeePercent: parseFloat(process.env.PLATFORM_FEE_PERCENTAGE) || 0,

  // ── AI Assistant providers ──────────────────────────────────────────
  // Provider API keys (added by the administrator; never hardcoded).
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  groqApiKey: process.env.GROQ_API_KEY || '',
  xaiApiKey: process.env.XAI_API_KEY || '',
  // Primary provider + ordered fallbacks. Supported: gemini, groq, xai.
  aiPrimaryProvider: process.env.AI_PRIMARY_PROVIDER || 'gemini',
  aiFallbackProviders: parseList(process.env.AI_FALLBACK_PROVIDERS || 'groq,xai'),
  // Optional per-provider model overrides.
  geminiModel: process.env.GEMINI_MODEL || '',
  groqModel: process.env.GROQ_MODEL || '',
  xaiModel: process.env.XAI_MODEL || '',
  // Token budgets. Free tiers are aggressly rate-limited (e.g. Groq on_demand
  // caps at ~8k tokens/minute), so we keep replies and tool rounds lean to
  // avoid burning the whole budget on one question.
  aiMaxOutputTokens: (() => {
    const n = parseInt(process.env.AI_MAX_OUTPUT_TOKENS, 10);
    return Number.isFinite(n) && n > 0 ? n : 1024;
  })(),
  aiMaxToolRounds: (() => {
    const n = parseInt(process.env.AI_MAX_TOOL_ROUNDS, 10);
    return Number.isFinite(n) && n >= 1 ? n : 3;
  })(),
};
