# Telnyx → Render → OpenAI Realtime GPT Bridge

Strict stack:

```text
Telnyx Call Control / media streaming
→ Render-hosted bridge
→ OpenAI Realtime GPT (`gpt-realtime-2` by default)
```

This bridge is dedicated to the demo line and contains no database, alternate voice provider, hosted-phone platform, or local tunnel dependency.

The default agent prompt and greeting are version-controlled in `agent-config.js`. The production service ignores legacy prompt environment variables unless `USE_ENV_PROMPT=true` is explicitly set.

Inbound demo calls are recorded as dual-channel MP3 files by default. The greeting discloses that the demo call may be recorded. Set `ENABLE_CALL_RECORDING=false` to disable recording.

## Environment variables

- `TELNYX_API_KEY`
- `OPENAI_API_KEY`
- `PUBLIC_BASE_URL` — Render service URL, e.g. `https://example.onrender.com`
- `REALTIME_MODEL` — default `gpt-realtime-2`
- `REALTIME_VOICE` — default `alloy`
- `USE_ENV_PROMPT` — default `false`; set to `true` only to use environment prompt overrides
- `AGENT_PROMPT` — optional override when `USE_ENV_PROMPT=true`
- `GREETING_INSTRUCTIONS` — optional override when `USE_ENV_PROMPT=true`
- `PROMPT_VERSION` — optional override when `USE_ENV_PROMPT=true`
- `ENABLE_CALL_RECORDING` — default `true`; records both sides as dual-channel MP3

## Endpoints

- `GET /health`
- `POST /telnyx/webhook`
- `WS /telnyx/stream`
