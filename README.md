# Telnyx → Render → OpenAI Realtime GPT Bridge

Strict stack:

```text
Telnyx Call Control / media streaming
→ Render-hosted bridge
→ OpenAI Realtime GPT (`gpt-realtime-2` by default)
```

No Supabase, LiveKit, Grok/xAI, VAPI, or local tunnel is used by this bridge.

## Environment variables

- `TELNYX_API_KEY`
- `OPENAI_API_KEY`
- `PUBLIC_BASE_URL` — Render service URL, e.g. `https://example.onrender.com`
- `REALTIME_MODEL` — default `gpt-realtime-2`
- `REALTIME_VOICE` — default `alloy`
- `AGENT_PROMPT` — optional override

## Endpoints

- `GET /health`
- `POST /telnyx/webhook`
- `WS /telnyx/stream`
