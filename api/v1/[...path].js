const crypto = require('node:crypto');

const BASE_URL = (process.env.UPSTREAM_BASE_URL || 'https://api.abihomelabs.dpdns.org/v1').replace(/\/+$/, '');

const DEFAULT_MODEL_MAP = {
  // These are Claude-style model IDs for Claude Desktop's model picker.
  // They are aliases only: requests are routed to the Gemini IDs below.
  'claude-opus-5-5': { upstream: 'gemini-3.1-pro', displayName: 'Claude Opus 5.5 (Gemini-backed)' },
  'claude-sonnet-5-5': { upstream: 'gemini-3.7-flash', displayName: 'Claude Sonnet 5.5 (Gemini-backed)' },
  'claude-haiku-5-5': { upstream: 'gemini-3.5-flash', displayName: 'Claude Haiku 5.5 (Gemini-backed)' },
};

function getModelMap() {
  const raw = process.env.MODEL_MAP;
  if (!raw) return DEFAULT_MODEL_MAP;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('MODEL_MAP must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    throw new Error('Invalid MODEL_MAP JSON: ' + error.message);
  }
}

function resolveUpstreamModel(modelId) {
  const entry = getModelMap()[modelId];
  if (!entry) return modelId;
  return typeof entry === 'string' ? entry : entry.upstream;
}

function modelDisplayName(modelId, entry) {
  return (entry && typeof entry === 'object' && entry.displayName) || modelId;
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function anthropicError(res, status, message, type) {
  const mapped = type || (status === 401 || status === 403 ? 'authentication_error'
    : status === 429 ? 'rate_limit_error'
    : status >= 500 ? 'api_error' : 'invalid_request_error');
  return json(res, status, { type: 'error', error: { type: mapped, message } });
}

function getIncomingKey(req) {
  const auth = req.headers.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  return bearer ? bearer[1].trim() : String(req.headers['x-api-key'] || '').trim();
}

function requireGatewayAuth(req, res) {
  const expected = process.env.GATEWAY_API_KEY;
  if (!expected) {
    anthropicError(res, 503, 'Gateway is not configured: GATEWAY_API_KEY is missing.', 'api_error');
    return false;
  }
  const supplied = getIncomingKey(req);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    anthropicError(res, 401, 'Invalid gateway API key.', 'authentication_error');
    return false;
  }
  return true;
}

function getUpstreamHeaders(jsonContent = true) {
  const key = process.env.UPSTREAM_API_KEY;
  if (!key) throw new Error('UPSTREAM_API_KEY is not configured in Vercel.');
  const headerName = process.env.UPSTREAM_AUTH_HEADER || 'Authorization';
  const prefix = process.env.UPSTREAM_AUTH_PREFIX === undefined
    ? (headerName.toLowerCase() === 'authorization' ? 'Bearer ' : '')
    : process.env.UPSTREAM_AUTH_PREFIX;
  const headers = { Accept: 'application/json' };
  if (jsonContent) headers['Content-Type'] = 'application/json';
  headers[headerName] = prefix + key;
  return headers;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n');
}

function contentToOpenAI(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text || '' });
    } else if (block.type === 'image' && block.source) {
      if (block.source.type === 'base64' && block.source.data) {
        const mime = block.source.media_type || 'image/jpeg';
        out.push({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + block.source.data } });
      } else if (block.source.type === 'url' && block.source.url) {
        out.push({ type: 'image_url', image_url: { url: block.source.url } });
      }
    }
  }
  if (out.every((x) => x.type === 'text')) return out.map((x) => x.text).join('\n');
  return out;
}

function toOpenAIMessages(body) {
  const messages = [];
  if (body.system) {
    const systemText = typeof body.system === 'string' ? body.system : textFromContent(body.system);
    if (systemText) messages.push({ role: 'system', content: systemText });
  }
  for (const message of (body.messages || [])) {
    if (!message || !['user', 'assistant'].includes(message.role)) continue;
    const blocks = Array.isArray(message.content) ? message.content : null;
    if (!blocks) {
      messages.push({ role: message.role, content: message.content ?? '' });
      continue;
    }
    const textAndImages = contentToOpenAI(blocks);
    const toolUses = blocks.filter((x) => x && x.type === 'tool_use');
    const toolResults = blocks.filter((x) => x && x.type === 'tool_result');
    if (message.role === 'assistant') {
      const assistant = { role: 'assistant' };
      if (typeof textAndImages === 'string' ? textAndImages.length : textAndImages.length) assistant.content = textAndImages;
      if (toolUses.length) {
        assistant.tool_calls = toolUses.map((tool) => ({
          id: tool.id || 'call_' + crypto.randomUUID().replace(/-/g, ''),
          type: 'function',
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.input || {}),
          },
        }));
      }
      if (assistant.content !== undefined || assistant.tool_calls) messages.push(assistant);
    } else {
      if (textAndImages && (typeof textAndImages !== 'string' || textAndImages.length)) {
        messages.push({ role: 'user', content: textAndImages });
      }
      for (const result of toolResults) {
        let output = result.content;
        if (Array.isArray(output)) output = textFromContent(output);
        if (output !== undefined && typeof output !== 'string') output = JSON.stringify(output);
        messages.push({ role: 'tool', tool_call_id: result.tool_use_id, content: output || '' });
      }
    }
  }
  return messages;
}

function toOpenAIToolChoice(choice) {
  if (!choice || typeof choice === 'string') return choice;
  if (choice.type === 'tool' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  if (choice.type === 'any') return 'required';
  if (choice.type === 'auto') return 'auto';
  return 'auto';
}

function toOpenAIRequest(body) {
  const request = {
    model: resolveUpstreamModel(body.model),
    messages: toOpenAIMessages(body),
    stream: Boolean(body.stream),
  };
  if (Number.isInteger(body.max_tokens)) request.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) request.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    request.tools = body.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    }));
    request.tool_choice = toOpenAIToolChoice(body.tool_choice);
    if (body.parallel_tool_use !== undefined) request.parallel_tool_calls = body.parallel_tool_use !== 'none';
  }
  return request;
}

function estimateTokens(value) {
  const chars = typeof value === 'string' ? value.length : JSON.stringify(value || {}).length;
  return Math.max(1, Math.ceil(chars / 4));
}

function mapStopReason(reason) {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'content_filter') return 'end_turn';
  return 'end_turn';
}

function makeAnthropicMessage(completion, requestedModel, requestBody) {
  const choice = completion.choices?.[0] || {};
  const source = choice.message || {};
  const content = [];
  if (typeof source.content === 'string' && source.content.length) {
    content.push({ type: 'text', text: source.content });
  } else if (Array.isArray(source.content)) {
    for (const block of source.content) {
      if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text });
    }
  }
  for (const call of (source.tool_calls || [])) {
    let input = {};
    try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: call.id || 'toolu_' + crypto.randomUUID().replace(/-/g, ''), name: call.function?.name || 'tool', input });
  }
  const usage = completion.usage || {};
  return {
    id: completion.id ? 'msg_' + completion.id.replace(/[^a-zA-Z0-9_-]/g, '') : 'msg_' + crypto.randomUUID().replace(/-/g, ''),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? estimateTokens({ system: requestBody.system, messages: requestBody.messages }),
      output_tokens: usage.completion_tokens ?? estimateTokens(content),
    },
  };
}

function streamAnthropicMessage(res, message) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  sseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: message.id,
      type: 'message',
      role: 'assistant',
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: 0,
      },
    },
  });

  let index = 0;
  for (const block of (message.content || [])) {
    if (block.type === 'text') {
      sseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      if (block.text) {
        sseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        });
      }
    } else if (block.type === 'tool_use') {
      sseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      });
      sseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) },
      });
    }
    sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index });
    index++;
  }

  sseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason || 'end_turn',
      stop_sequence: null,
    },
    usage: { output_tokens: message.usage.output_tokens || 0 },
  });
  sseEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('Request body must be valid JSON.'); }
}

async function handleModels(req, res) {
  try {
    const modelMap = getModelMap();
    const data = Object.entries(modelMap).map(([id, entry]) => ({
      type: 'model',
      id,
      display_name: modelDisplayName(id, entry),
      created_at: '2026-01-01T00:00:00Z',
    }));
    return json(res, 200, {
      data,
      has_more: false,
      first_id: data[0]?.id || null,
      last_id: data.at(-1)?.id || null,
    });
  } catch (error) {
    return anthropicError(res, 500, error.message, 'api_error');
  }
}

function sseEvent(res, event, data) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

async function streamCompletion(upstream, req, res, body) {
  const messageId = 'msg_' + crypto.randomUUID().replace(/-/g, '');
  const inputTokens = estimateTokens({ system: body.system, messages: body.messages });
  const model = body.model;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  sseEvent(res, 'message_start', { type: 'message_start', message: {
    id: messageId, type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 0 },
  } });

  let buffer = '';
  let textIndex = null;
  let textOpen = false;
  let outputText = '';
  let stopReason = 'end_turn';
  let outputTokens = 0;
  const toolCalls = new Map();
  let sawDone = false;

  const processData = (dataLine) => {
    if (!dataLine || dataLine === '[DONE]') { if (dataLine === '[DONE]') sawDone = true; return; }
    let chunk;
    try { chunk = JSON.parse(dataLine); } catch { return; }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      if (!textOpen) {
        textIndex = toolCalls.size;
        textOpen = true;
        sseEvent(res, 'content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
      }
      outputText += delta.content;
      sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } });
    }
    for (const toolDelta of (delta.tool_calls || [])) {
      const idx = toolDelta.index ?? 0;
      const current = toolCalls.get(idx) || { id: '', name: '', arguments: '' };
      if (toolDelta.id) current.id = toolDelta.id;
      if (toolDelta.function?.name) current.name += toolDelta.function.name;
      if (toolDelta.function?.arguments) current.arguments += toolDelta.function.arguments;
      toolCalls.set(idx, current);
    }
    if (choice?.finish_reason) stopReason = mapStopReason(choice.finish_reason);
    if (chunk.usage?.completion_tokens != null) outputTokens = chunk.usage.completion_tokens;
  };

  try {
    if (!upstream.body) throw new Error('Upstream returned an empty streaming body.');
    for await (const chunk of upstream.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) processData(line.slice(5).trim());
      }
    }
    if (buffer.startsWith('data:')) processData(buffer.slice(5).trim());

    if (textOpen) sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: textIndex });
    let nextIndex = textOpen ? textIndex + 1 : 0;
    for (const [, tool] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      const id = tool.id || 'toolu_' + crypto.randomUUID().replace(/-/g, '');
      let input = {};
      try { input = JSON.parse(tool.arguments || '{}'); } catch { input = {}; }
      sseEvent(res, 'content_block_start', { type: 'content_block_start', index: nextIndex, content_block: { type: 'tool_use', id, name: tool.name || 'tool', input: {} } });
      sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: nextIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: nextIndex });
      nextIndex++;
    }
    if (stopReason === 'end_turn' && toolCalls.size) stopReason = 'tool_use';
    if (!outputTokens) outputTokens = estimateTokens(outputText);
    sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
    sseEvent(res, 'message_stop', { type: 'message_stop' });
    res.end();
  } catch (error) {
    sseEvent(res, 'error', { type: 'error', error: { type: 'api_error', message: error.message } });
    res.end();
  }
}

async function handleMessages(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (error) { return anthropicError(res, 400, error.message); }
  if (!body.model || !Array.isArray(body.messages)) return anthropicError(res, 400, 'Both model and messages are required.');
  let headers;
  try { headers = getUpstreamHeaders(true); }
  catch (error) { return anthropicError(res, 503, error.message, 'api_error'); }
  const payload = toOpenAIRequest(body);
  // Some OpenAI-compatible Gemini gateways accept stream=true but return a
  // non-SSE body, causing clients such as Claude Desktop to show a blank reply.
  // Fetch a complete JSON completion and emit valid Anthropic SSE ourselves.
  payload.stream = false;
  try {
    const upstream = await fetch(BASE_URL + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(105000),
    });
    if (!upstream.ok) {
      const raw = await upstream.text();
      let message = raw.slice(0, 1600);
      try {
        const parsed = JSON.parse(raw);
        message = parsed.error?.message || parsed.message || message;
      } catch { /* keep raw upstream error */ }
      if (upstream.status === 401 || upstream.status === 403) {
        return anthropicError(
          res,
          502,
          'The upstream Gemini-compatible API rejected UPSTREAM_API_KEY (HTTP ' + upstream.status + '): ' + message +
            ' Check the upstream key and its required authentication header/prefix in Vercel.',
          'api_error'
        );
      }
      return anthropicError(res, upstream.status, 'Upstream API error: ' + message);
    }
    const completion = await upstream.json();
    const message = makeAnthropicMessage(completion, body.model, body);
    if (body.stream) return streamAnthropicMessage(res, message);
    return json(res, 200, message);
  } catch (error) {
    return anthropicError(res, 502, 'Could not reach upstream chat endpoint: ' + error.message, 'api_error');
  }
}

module.exports = async function handler(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/api/, '');
  if (req.method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/v1/health')) {
    return json(res, 200, { ok: true, service: 'anthropic-openai-compat-bridge', upstream: BASE_URL });
  }
  if (!requireGatewayAuth(req, res)) return;
  if (req.method === 'GET' && pathname === '/v1/models') return handleModels(req, res);
  if (req.method === 'POST' && pathname === '/v1/messages/count_tokens') {
    try {
      const body = await readBody(req);
      return json(res, 200, { input_tokens: estimateTokens({ system: body.system, messages: body.messages, tools: body.tools }) });
    } catch (error) {
      return anthropicError(res, 400, error.message);
    }
  }
  if (req.method === 'POST' && pathname === '/v1/messages') return handleMessages(req, res);
  return anthropicError(res, 404, 'Unsupported route: ' + req.method + ' ' + pathname);
};
