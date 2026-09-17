/**
 * aiAdapters.js
 *
 * Provider-neutral adapters for the ShramikSetu AI Assistant.
 *
 * Every adapter exposes the SAME interface:
 *   {
 *     name: string,
 *     isConfigured(): boolean,
 *     async send({ messages, systemPrompt, tools }):
 *       messages      — canonical conversation [{ role, content, toolCalls?, toolCallId?, name?, response? }]
 *       systemPrompt  — string system instruction
 *       tools         — Gemini-format function declarations
 *       -> Promise<{ content: string|null, toolCalls: [{ id, name, args }] }>
 *   }
 *
 * Adapters are fully independent of MongoDB / worker / job / demand data.
 * The tool-calling loop that executes ShramikSetu data handlers lives in
 * aiOrchestrator.js — not here.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const REQUEST_TIMEOUT_MS = 60000;

class ProviderError extends Error {
  constructor(provider, message, kind = 'HTTP') {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind; // 'CONFIG' | 'QUOTA' | 'NETWORK' | 'SAFETY' | 'HTTP'
  }
}

/* Convert Gemini-format function declarations to OpenAI-format tools. */
function toOpenAIFormattedTools(declarations) {
  return (declarations || []).map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    },
  }));
}

/* ─────────────── Gemini adapter (uses @google/generative-ai SDK) ─────────────── */

function createGeminiAdapter({ apiKey, model, maxOutputTokens = 1024 }) {
  const resolvedModel = model || 'gemini-3.6-flash';
  let genModel = null;

  const isConfigured = () => Boolean(apiKey);

  function parseResponse(response) {
    const parts = response?.candidates?.[0]?.content?.parts || [];
    let content = null;
    const toolCalls = [];
    parts.forEach((part, i) => {
      if (part.text) content = (content || '') + part.text;
      if (part.functionCall) {
        toolCalls.push({ id: `gemini-${i}`, name: part.functionCall.name, args: part.functionCall.args || {} });
      }
    });
    return { content, toolCalls };
  }

  function classify(err) {
    const m = err?.message || String(err);
    if (m.includes('API key') || m.includes('api_key') || m.includes('Not Found') || m.includes('permission')) {
      return new ProviderError('gemini', err.message, 'CONFIG');
    }
    if (m.includes('quota') || m.includes('429')) return new ProviderError('gemini', err.message, 'QUOTA');
    if (m.includes('SAFETY') || m.includes('blocked') || m.includes('Candidate was blocked')) {
      return new ProviderError('gemini', err.message, 'SAFETY');
    }
    if (m.includes('aborted') || m.includes('timeout') || m.includes('Network') || m.includes('fetch')) {
      return new ProviderError('gemini', err.message, 'NETWORK');
    }
    return new ProviderError('gemini', err.message, 'HTTP');
  }

  return {
    name: 'gemini',
    isConfigured,
    async send({ messages, systemPrompt, tools }) {
      if (!genModel) {
        genModel = new GoogleGenerativeAI(apiKey).getGenerativeModel({
          model: resolvedModel,
          generationConfig: { temperature: 0.7, topP: 0.9, topK: 40, maxOutputTokens },
        });
      }

      const contents = [];
      for (const msg of messages) {
        if (msg.role === 'system') continue; // handled via systemInstruction
        if (msg.role === 'user') {
          const parts = [];
          if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
            for (const att of msg.attachments) {
              if (att && att.mimeType && att.data) {
                parts.push({ inlineData: { mimeType: att.mimeType, data: att.data } });
              }
            }
          }
          parts.push({ text: msg.content });
          contents.push({ role: 'user', parts });
        } else if (msg.role === 'assistant') {
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            contents.push({
              role: 'model',
              parts: msg.toolCalls.map((tc) => ({ functionCall: { name: tc.name, args: tc.args || {} } })),
            });
          } else {
            contents.push({ role: 'model', parts: [{ text: msg.content || '' }] });
          }
        } else if (msg.role === 'tool') {
          contents.push({
            role: 'function',
            parts: [{ functionResponse: { name: msg.name, response: msg.response ?? {} } }],
          });
        }
      }

      try {
        const result = await genModel.generateContent({
          contents,
          systemInstruction: systemPrompt,
          tools: tools && tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
        });
        return parseResponse(result.response);
      } catch (err) {
        throw classify(err);
      }
    },
  };
}

/* ─────────────── OpenAI-compatible adapter (Groq, xAI, OpenAI via fetch) ─────────────── */

function createOpenAICompatibleAdapter({ name, apiKey, baseUrl, model, maxOutputTokens = 1024 }) {
  const resolvedModel = model || 'gpt-4o-mini';
  const isConfigured = () => Boolean(apiKey);

  function toOpenAIMessages(messages) {
    const out = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        out.push({ role: 'system', content: msg.content });
      } else if (msg.role === 'user') {
        out.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          out.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
            })),
          });
        } else {
          out.push({ role: 'assistant', content: msg.content });
        }
      } else if (msg.role === 'tool') {
        out.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content: JSON.stringify(msg.response ?? {}),
        });
      }
    }
    return out;
  }

  function parseResponse(message) {
    let content = null;
    const toolCalls = [];
    if (typeof message.content === 'string' && message.content.trim()) content = message.content;
    for (const tc of message.tool_calls || []) {
      let args = {};
      try {
        args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch (e) { /* leave empty args */ }
      toolCalls.push({ id: tc.id, name: tc.function?.name, args });
    }
    return { content, toolCalls };
  }

  async function send({ messages, systemPrompt, tools }) {
    const body = {
      model: resolvedModel,
      messages: toOpenAIMessages([{ role: 'system', content: systemPrompt }, ...messages]),
      temperature: 0.7,
      max_tokens: maxOutputTokens,
    };
    if (tools && tools.length > 0) {
      body.tools = toOpenAIFormattedTools(tools);
      body.tool_choice = 'auto';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new ProviderError(name, err.message || 'Network error', 'NETWORK');
    }
    clearTimeout(timer);

    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j?.error?.message || ''; } catch (e) { /* ignore */ }
      const kind = res.status === 429 ? 'QUOTA' : res.status >= 500 ? 'HTTP' : 'CONFIG';
      throw new ProviderError(name, `HTTP ${res.status}${detail ? `: ${detail}` : ''}`, kind);
    }

    const json = await res.json();
    const choice = json?.choices?.[0];
    if (!choice) throw new ProviderError(name, 'No completion choices returned', 'HTTP');
    return parseResponse(choice.message);
  }

  return { name, isConfigured, send };
}

module.exports = {
  ProviderError,
  createGeminiAdapter,
  createOpenAICompatibleAdapter,
};