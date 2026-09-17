/**
 * assistantController.js
 *
 * Shared chat endpoint for the ShramikSetu AI Home & Service Assistant.
 * POST /api/workers/ai-assistant/chat   (worker role)
 * POST /api/customers/ai-assistant/chat (customer role)
 *
 * Worker messages also get access to the worker data-demand tools; customer
 * messages get service-problem diagnosis + booking CTA. Both use the same
 * provider-failover pipeline.
 */

const Worker = require('../../models/WorkerProfile');
const { asyncHandler, ApiError } = require('../../middleware/errorMiddleware');
const { chat } = require('../../services/ai/assistantService');

const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // ~4.5 MB base64 (~3.3 MB binary)
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/* Accepts a data URL like: data:image/jpeg;base64,iVBORw0KGgo… */
function parseImageData(imageData) {
  if (!imageData || typeof imageData !== 'string') return [];
  const match = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(imageData.trim());
  if (!match) return [];
  const [, mimeType, data] = match;
  if (!ALLOWED_IMAGE_MIMES.has(mimeType)) return [];
  if (data.length > MAX_IMAGE_BYTES) return [];
  return [{ mimeType, data }];
}

const chatHandler = asyncHandler(async (req, res) => {
  const { message, conversationHistory, language, imageData } = req.body;
  const role = req.user && req.user.role === 'worker' ? 'worker' : 'customer';

  if (!message || !String(message).trim()) {
    throw new ApiError('Message is required', 400);
  }

  let workerId = null;
  if (role === 'worker') {
    const worker = await Worker.findOne({ user: req.user._id });
    if (!worker) throw new ApiError('Worker profile not found', 404);
    workerId = worker._id;
  }

  const history = Array.isArray(conversationHistory)
    ? conversationHistory.slice(-24)
    : [];

  const attachments = parseImageData(imageData);

  const lang = String(language || 'en').toLowerCase();
  const response = await chat({
    role,
    message: String(message).trim(),
    conversationHistory: history,
    language: lang,
    workerId,
    attachments,
  });

  res.json({
    success: true,
    data: {
      reply: response.reply,
      dataUsed: response.dataUsed || [],
      actions: response.actions || [],
      diagnosis: response.diagnosis || null,
      errorCode: response.errorCode || null,
      errorKind: response.errorKind || null,
      retryable: Boolean(response.retryable),
      lastProvider: response.lastProvider || null,
    },
  });
});

module.exports = { chatHandler };