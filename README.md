# America's General Contractor Voice Demo

Callable demo line: **+1 213-671-0114**

```text
Telnyx Call Control and bidirectional media streaming
→ Render-hosted bridge
→ OpenAI Realtime API
```

The line is dedicated to this demo. It does not use LiveKit, Twilio, GHL, xAI, an alternate voice provider, or a local tunnel. Telnyx handles the phone call and OpenAI generates the agent's voice and conversation.

The version-controlled prompt in `agent-config.js` handles:

- new remodeling and construction inquiries;
- emergency restoration and plumbing safety triage;
- existing-project messages;
- human, vendor, and employment requests; and
- verified business questions without inventing prices, availability, warranty terms, or dispatch status.

Inbound calls are recorded by Telnyx as untrimmed dual-channel MP3 files. The opening discloses that the demo call may be recorded. Set `ENABLE_CALL_RECORDING=false` to disable recording.

## Environment variables

- `TELNYX_API_KEY`
- `OPENAI_API_KEY`
- `PUBLIC_BASE_URL` — Render service URL, e.g. `https://example.onrender.com`
- `DEMO_TO_NUMBER` — `+12136710114` in production
- `REALTIME_MODEL` — recommended `gpt-realtime-2.1`
- `REALTIME_VOICE` — recommended `marin`
- `USE_ENV_PROMPT` — default `false`; set to `true` only to use environment prompt overrides
- `AGENT_PROMPT` — optional override when `USE_ENV_PROMPT=true`
- `GREETING_INSTRUCTIONS` — optional override when `USE_ENV_PROMPT=true`
- `PROMPT_VERSION` — optional override when `USE_ENV_PROMPT=true`
- `ENABLE_CALL_RECORDING` — default `true`

## Validation

```bash
npm run check
npm test
npm run verify:openai
npm run eval:agent
```

## Endpoints

- `GET /health`
- `POST /telnyx/webhook`
- `WS /telnyx/stream`
