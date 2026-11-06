# Anthropic ↔ OpenAI-compatible gateway

This small Vercel project exposes the Anthropic Messages API expected by Claude Desktop's **Developer → Configure Third-Party Inference** gateway connection. It translates requests to an OpenAI-compatible `/v1/chat/completions` upstream and translates responses back to Anthropic message/SSE formats.

## Routes

- `GET /health` — health check (no auth)
- `GET /v1/models` — translates the upstream OpenAI model list to an Anthropic-style model list
- `POST /v1/messages` — converts Anthropic Messages requests to OpenAI Chat Completions
- `POST /v1/messages/count_tokens` — approximate token counter

## Vercel environment variables

Set all of these in **Project → Settings → Environment Variables**, for Production and Preview:

- `GATEWAY_API_KEY`: a strong, private key entered in Claude Desktop as the Gateway API Key.
- `UPSTREAM_BASE_URL`: `https://api.abihomelabs.dpdns.org/v1`
- `UPSTREAM_API_KEY`: the actual key accepted by your existing API server. The literal text `your-own-secret-api-key` is only a placeholder unless that exact value has been configured and accepted by your upstream server.

By default, the bridge sends `Authorization: Bearer <UPSTREAM_API_KEY>`. If your upstream requires a different header, set `UPSTREAM_AUTH_HEADER` (for example `x-api-key`) and `UPSTREAM_AUTH_PREFIX` (empty for raw key, or `Bearer ` if required).

After adding or changing environment variables, redeploy the project so the new deployment receives them.

## Claude Desktop configuration

- Connection type: **Gateway**
- Credential kind: **Static API key**
- Gateway API key: the value of `GATEWAY_API_KEY`
- Gateway auth scheme: **Bearer**
- Gateway base URL: `https://YOUR-VERCEL-DEPLOYMENT.vercel.app` (no `/v1` suffix)
- Add your upstream model ID exactly as listed by `GET /v1/models`, e.g. `gemini-3.7-flash` only if the upstream lists it.

## Notes / limitations

- This is a protocol bridge, not a Gemini-to-Claude model conversion. It forwards model IDs to your existing OpenAI-compatible gateway.
- Tool use and image inputs are translated for common OpenAI-compatible implementations. Provider-specific extensions, audio, video, prompt caching, and extended thinking are not translated.
- Token counts returned by the count-token endpoint are estimates. Non-streaming calls use upstream usage when available.
- Do not commit real API keys to source control. Keep them in Vercel environment variables.


## Claude-style model aliases

Claude Desktop's gateway configuration expects model IDs that look like Claude IDs. This bridge therefore publishes Claude-style aliases and translates them to Gemini model IDs. **These are naming aliases, not actual Anthropic Claude models**; all inference still runs on the Gemini upstream.

Default aliases:

| Claude Desktop model ID | Display name | Gemini upstream model |
|---|---|---|
| `claude-opus-5-5` | Claude Opus 5.5 (Gemini-backed) | `gemini-3.1-pro` |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 (Gemini-backed) | `gemini-3.7-flash` |
| `claude-haiku-5-5` | Claude Haiku 5.5 (Gemini-backed) | `gemini-3.5-flash` |

You can override these aliases with a `MODEL_MAP` JSON object in Vercel, for example:

```json
{
  "claude-opus-5-5": {"upstream":"gemini-3.1-pro","displayName":"Claude Opus 5.5 (Gemini-backed)"},
  "claude-sonnet-5-5": {"upstream":"gemini-3.7-flash","displayName":"Claude Sonnet 5.5 (Gemini-backed)"},
  "claude-haiku-5-5": {"upstream":"gemini-3.5-flash","displayName":"Claude Haiku 5.5 (Gemini-backed)"}
}
```

After changing code or environment variables, create a fresh Production deployment from the latest `main` branch commit. A redeploy of an older deployment can retain its original environment-variable snapshot.


## Model discovery and authentication

- `GET /v1/models` is intentionally public so Claude Desktop can discover configured model aliases before inference.
- `POST /v1/messages` remains protected by `GATEWAY_API_KEY`.
- The gateway key and `UPSTREAM_API_KEY` are different credentials. A successful model-list request does not verify the upstream API key.
