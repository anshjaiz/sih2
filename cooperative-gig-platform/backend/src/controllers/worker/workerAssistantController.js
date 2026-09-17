/**
 * workerAssistantController.js
 *
 * POST /api/workers/ai-assistant/chat
 * Gemini-powered chat endpoint for the ShramikSetu AI Assistant.
 */

const Worker = require('../../models/WorkerProfile');
const { asyncHandler, ApiError } = require('../../middleware/errorMiddleware');
const { chat } = require('../../services/ai/workerAssistantService');

const chatHandler = asyncHandler(async (req, res) => {
  const { message, conversationHistory, language } = req.body;
  if (!message || !String(message).trim()) {
    throw new ApiError('Message is required', 400);
  }

  const worker = await Worker.findOne({ user: req.user._id });
  if (!worker) throw new ApiError('Worker profile not found', 404);

  // Pass conversation history for multi-turn context
  const history = Array.isArray(conversationHistory)
    ? conversationHistory.slice(-24)
    : [];

  const lang = String(language || 'en').toLowerCase();
  const response = await chat(worker._id, String(message).trim(), history, lang);

  res.json({
    success: true,
    data: {
      reply: response.reply,
      dataUsed: response.dataUsed || [],
      actions: response.actions || [],
      // Optional error context so the UI can offer a "Retry in a minute"
      // button instead of showing a dead generic unavailability message.
      errorKind: response.errorKind || null,
      retryable: Boolean(response.retryable),
      lastProvider: response.lastProvider || null,
    },
  });
});

module.exports = { chatHandler };