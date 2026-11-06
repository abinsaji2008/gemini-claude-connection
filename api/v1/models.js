const DEFAULT_MODEL_MAP = {
  'claude-opus-5-5': {
    upstream: 'gemini-3.1-pro',
    displayName: 'Claude Opus 5.5 (Gemini-backed)',
  },
  'claude-sonnet-5-5': {
    upstream: 'gemini-3.7-flash',
    displayName: 'Claude Sonnet 5.5 (Gemini-backed)',
  },
  'claude-haiku-5-5': {
    upstream: 'gemini-3.5-flash',
    displayName: 'Claude Haiku 5.5 (Gemini-backed)',
  },
};

function readModelMap() {
  if (!process.env.MODEL_MAP) return DEFAULT_MODEL_MAP;
  const parsed = JSON.parse(process.env.MODEL_MAP);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MODEL_MAP must be a JSON object.');
  }
  return parsed;
}

module.exports = function models(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.statusCode = 405;
    return res.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Method not allowed.' },
    }));
  }

  // Model IDs are non-sensitive metadata. Keep discovery public so desktop clients
  // can populate the model picker before applying credentials to inference calls.
  // All inference routes remain protected by GATEWAY_API_KEY.
  try {
    const data = Object.entries(readModelMap()).map(([id, entry]) => ({
      type: 'model',
      id,
      display_name: (entry && typeof entry === 'object' && entry.displayName) || id,
      created_at: '2026-01-01T00:00:00Z',
    }));
    res.statusCode = 200;
    return res.end(JSON.stringify({
      data,
      has_more: false,
      first_id: data[0] ? data[0].id : null,
      last_id: data.length ? data[data.length - 1].id : null,
    }));
  } catch (error) {
    res.statusCode = 500;
    return res.end(JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: error.message },
    }));
  }
};
