import crypto from 'node:crypto';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  AGENT_PROMPT as BUILT_IN_AGENT_PROMPT,
  GREETING_INSTRUCTIONS as BUILT_IN_GREETING_INSTRUCTIONS,
  PROMPT_VERSION as BUILT_IN_PROMPT_VERSION,
  TURN_DETECTION_CONFIG,
} from './agent-config.js';

const {
  TELNYX_API_KEY,
  OPENAI_API_KEY,
  PUBLIC_BASE_URL,
  DEMO_TO_NUMBER,
  REALTIME_MODEL = 'gpt-realtime-2.1',
  REALTIME_VOICE,
  AGENT_PROMPT: ENV_AGENT_PROMPT,
  GREETING_INSTRUCTIONS: ENV_GREETING_INSTRUCTIONS,
  PROMPT_VERSION: ENV_PROMPT_VERSION,
  USE_ENV_PROMPT = 'false',
  ENABLE_CALL_RECORDING = 'true',
  PORT = 3000,
} = process.env;

const useEnvPrompt = /^(1|true|yes|on)$/i.test(USE_ENV_PROMPT);
const recordingEnabled = !/^(0|false|no|off)$/i.test(ENABLE_CALL_RECORDING);
const AGENT_PROMPT = useEnvPrompt && ENV_AGENT_PROMPT?.trim()
  ? ENV_AGENT_PROMPT.trim()
  : BUILT_IN_AGENT_PROMPT;
const GREETING_INSTRUCTIONS = useEnvPrompt && ENV_GREETING_INSTRUCTIONS?.trim()
  ? ENV_GREETING_INSTRUCTIONS.trim()
  : BUILT_IN_GREETING_INSTRUCTIONS;
const PROMPT_VERSION = useEnvPrompt && ENV_PROMPT_VERSION?.trim()
  ? ENV_PROMPT_VERSION.trim()
  : BUILT_IN_PROMPT_VERSION;
const promptSource = useEnvPrompt ? 'environment' : 'versioned-code';

const requiredKeys = [
  'TELNYX_API_KEY',
  'OPENAI_API_KEY',
  'PUBLIC_BASE_URL',
  'DEMO_TO_NUMBER',
  'REALTIME_MODEL',
  'REALTIME_VOICE',
];

function getMissingEnv() {
  return requiredKeys.filter(key => !process.env[key] || !String(process.env[key]).trim());
}

function configReady() {
  return getMissingEnv().length === 0;
}

const promptHash = AGENT_PROMPT
  ? crypto.createHash('sha256').update(AGENT_PROMPT).digest('hex').slice(0, 12)
  : 'missing';
const app = express();
app.use(express.json({ type: '*/*' }));
app.use(express.urlencoded({ extended: false }));

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const calls = new Map();
const recordingStarted = new Set();
const MAX_PENDING_AUDIO_CHUNKS = 500;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sendJson(ws, obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function publicHttps(path) {
  return PUBLIC_BASE_URL.replace(/^wss:/, 'https:').replace(/\/$/, '') + path;
}

function publicWss(path) {
  return PUBLIC_BASE_URL.replace(/^https:/, 'wss:').replace(/\/$/, '') + path;
}

function normalizePhone(v = '') {
  return String(v).replace(/[^+\d]/g, '');
}

function isDemoNumber(to) {
  return normalizePhone(to) === normalizePhone(DEMO_TO_NUMBER);
}

async function telnyxCallAction(callControlId, action, body = {}) {
  if (!callControlId) throw new Error(`Cannot ${action}: missing callControlId`);
  const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  log(`[telnyx ${action}]`, response.status, text.slice(0, 600));
  if (!response.ok) throw new Error(`Telnyx ${action} failed: ${response.status} ${text}`);
  return text;
}

function endCallLater(callControlId, reason = 'agent_requested_end_call') {
  const clientState = Buffer.from(JSON.stringify({ reason, prompt_version: PROMPT_VERSION })).toString('base64');
  log('[end_call] scheduled', callControlId || 'missing', reason);
  setTimeout(() => {
    telnyxCallAction(callControlId, 'hangup', { client_state: clientState })
      .catch(err => log('[end_call error]', err?.stack || err?.message || err));
  }, 2500);
}

async function startCallRecording(callControlId) {
  if (!recordingEnabled || !callControlId || recordingStarted.has(callControlId)) return;
  recordingStarted.add(callControlId);
  const clientState = Buffer.from(JSON.stringify({
    purpose: 'americas_general_contractor_voice_demo',
    prompt_version: PROMPT_VERSION,
  })).toString('base64');

  try {
    await telnyxCallAction(callControlId, 'record_start', {
      format: 'mp3',
      channels: 'dual',
      recording_track: 'both',
      play_beep: false,
      client_state: clientState,
      command_id: `record-${callControlId.slice(-18)}`,
      custom_file_name: `americas-gc-demo-${Date.now()}`,
    });
    log('[recording] started', callControlId, 'dual-channel mp3');
  } catch (err) {
    recordingStarted.delete(callControlId);
    log('[recording error]', err?.stack || err?.message || err);
  }
}

app.get('/', (req, res) => res.type('text/plain').send("America's General Contractor demo Telnyx → OpenAI Realtime bridge OK"));

app.get('/health', (req, res) => {
  const missing = getMissingEnv();
  res.status(missing.length ? 503 : 200).json({
    ok: missing.length === 0,
    stack: 'americas-general-contractor-telnyx-render-openai-realtime',
    demo_to_number: DEMO_TO_NUMBER || null,
    model: REALTIME_MODEL || null,
    voice: REALTIME_VOICE || null,
    prompt_version: PROMPT_VERSION,
    prompt_source: promptSource,
    prompt_hash: promptHash,
    recording_enabled: recordingEnabled,
    recording_format: recordingEnabled ? 'mp3' : null,
    recording_channels: recordingEnabled ? 'dual' : null,
    turn_detection_type: TURN_DETECTION_CONFIG.type,
    turn_detection_eagerness: TURN_DETECTION_CONFIG.eagerness,
    missing_env: missing,
    webhook: PUBLIC_BASE_URL ? publicHttps('/telnyx/webhook') : null,
    stream: PUBLIC_BASE_URL ? publicWss('/telnyx/stream') : null,
  });
});

app.post('/telnyx/webhook', async (req, res) => {
  res.sendStatus(200);

  if (!configReady()) {
    log('[config missing] refusing webhook', getMissingEnv().join(','));
    return;
  }

  const event = req.body?.data || req.body;
  const eventType = event?.event_type;
  const payload = event?.payload || {};
  const callControlId = payload.call_control_id;
  log('[telnyx webhook]', eventType, callControlId || '', payload.from || '', '→', payload.to || '');

  if (eventType === 'call.recording.saved') {
    log(
      '[recording] saved',
      payload.recording_id || payload.id || 'unknown',
      callControlId || '',
      JSON.stringify(payload.recording_urls || payload.public_recording_urls || {}),
    );
    return;
  }

  if (eventType === 'call.recording.error') {
    log('[recording] Telnyx reported an error', callControlId || '', JSON.stringify(payload.errors || payload.error || {}));
    return;
  }

  if (eventType === 'call.hangup') {
    calls.delete(callControlId);
    recordingStarted.delete(callControlId);
    return;
  }

  if (eventType === 'call.answered') {
    const tracked = calls.get(callControlId);
    if (tracked || isDemoNumber(payload.to)) await startCallRecording(callControlId);
    return;
  }

  if (eventType !== 'call.initiated' || payload.direction !== 'incoming') return;
  if (!callControlId) return log('[guard] missing call_control_id');

  if (!isDemoNumber(payload.to)) {
    log('[guard] refusing non-demo inbound call; not answering', payload.to || 'unknown', 'expected', DEMO_TO_NUMBER);
    return;
  }

  calls.set(callControlId, { from: payload.from, to: payload.to, initiatedAt: Date.now() });

  const answerBody = {
    stream_url: publicWss('/telnyx/stream'),
    stream_track: 'inbound_track',
    stream_codec: 'PCMU',
    stream_bidirectional_mode: 'rtp',
    stream_bidirectional_codec: 'PCMU',
    stream_bidirectional_sampling_rate: 8000,
    send_silence_when_idle: true,
    client_state: Buffer.from(JSON.stringify({ from: payload.from, to: payload.to, prompt_version: PROMPT_VERSION })).toString('base64'),
    command_id: `answer-${callControlId.slice(-12)}-${Date.now()}`,
  };

  try {
    const answer = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/answer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(answerBody),
    });
    const body = await answer.text();
    log('[telnyx answer]', answer.status, body.slice(0, 600));
  } catch (err) {
    log('[telnyx answer error]', err?.stack || err?.message || err);
  }
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname !== '/telnyx/stream') return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => handleTelnyxStream(ws));
});

function handleTelnyxStream(telnyxWs) {
  const streamConnectedAt = Date.now();
  log('[telnyx stream] connected');

  let streamId = null;
  let callControlId = null;
  let latestMediaTimestamp = 0;
  let openaiReady = false;
  let greetingSent = false;
  let responseInProgress = false;
  let suppressAssistantAudio = false;
  let openaiWs = null;
  const pendingAudio = [];

  function connectOpenAI() {
    if (openaiWs) return;
    openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });

    openaiWs.on('open', () => {
      log('[openai] connected', REALTIME_MODEL, 'voice=' + REALTIME_VOICE, 'prompt=' + PROMPT_VERSION, 'hash=' + promptHash);
      sendJson(openaiWs, {
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          instructions: AGENT_PROMPT,
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              noise_reduction: { type: 'near_field' },
              transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
              turn_detection: TURN_DETECTION_CONFIG,
            },
            output: { format: { type: 'audio/pcmu' }, voice: REALTIME_VOICE },
          },
          tools: [
            {
              type: 'function',
              name: 'end_call',
              description: 'Politely end the current phone call after the caller is clearly finished or asks to end the call.',
              parameters: {
                type: 'object',
                properties: {
                  reason: { type: 'string', description: 'Short reason the call should be ended.' },
                },
                required: ['reason'],
              },
            },
          ],
          tool_choice: 'auto',
          max_output_tokens: 1200,
        },
      });
    });

    openaiWs.on('message', data => {
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }

      if (event.type === 'error') return log('[openai error]', JSON.stringify(event.error || event));

      if (event.type === 'session.updated') {
        openaiReady = true;
        log('[openai] session.updated', 'voice=' + REALTIME_VOICE, 'prompt=' + PROMPT_VERSION, 'hash=' + promptHash);
        for (const audio of pendingAudio.splice(0)) sendJson(openaiWs, { type: 'input_audio_buffer.append', audio });
        if (!greetingSent) {
          greetingSent = true;
          log('[openai] greeting.response.create');
          sendJson(openaiWs, {
            type: 'response.create',
            response: {
              instructions: GREETING_INSTRUCTIONS,
            },
          });
        }
        return;
      }

      if (event.type === 'response.created') {
        responseInProgress = true;
        suppressAssistantAudio = false;
      }
      if (event.type === 'response.done') responseInProgress = false;

      if (event.type === 'response.output_audio.delta' && streamId) {
        if (suppressAssistantAudio) return;
        sendJson(telnyxWs, { event: 'media', media: { payload: event.delta } });
        return;
      }

      if (event.type === 'response.output_audio.done' && streamId) {
        sendJson(telnyxWs, { event: 'mark', mark: { name: 'response_done' } });
        return;
      }

      if (event.type === 'input_audio_buffer.speech_started') {
        suppressAssistantAudio = true;
        sendJson(telnyxWs, { event: 'clear' });
        log('[barge-in] caller speech detected; suppressing assistant audio and cleared Telnyx playback queue', 'response_in_progress=' + responseInProgress);
      }

      if (event.type === 'response.function_call_arguments.done') {
        let args = {};
        try { args = JSON.parse(event.arguments || '{}'); } catch {}
        log('[tool]', event.name || 'unknown', JSON.stringify(args));

        if (event.name === 'end_call') {
          sendJson(openaiWs, {
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: event.call_id,
              output: JSON.stringify({ success: true, message: 'The call will be ended now.' }),
            },
          });
          endCallLater(callControlId, args.reason || 'agent_requested_end_call');
          return;
        }
      }

      if (event.type === 'response.output_audio_transcript.done') log('[agent]', event.transcript || '');
      if (event.type === 'conversation.item.input_audio_transcription.completed') log('[caller]', event.transcript || '');
    });

    openaiWs.on('close', (code, reason) => log('[openai] closed', code, reason?.toString?.() || ''));
    openaiWs.on('error', err => log('[openai socket error]', err.message));
  }

  telnyxWs.on('message', data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === 'connected') return log('[telnyx stream] handshake');

    if (msg.event === 'start') {
      streamId = msg.stream_id;
      callControlId = msg.start?.call_control_id;
      latestMediaTimestamp = 0;
      const to = msg.start?.to;
      log('[telnyx stream] start', streamId, callControlId || '', msg.start?.from || '', '→', to || '', JSON.stringify(msg.start?.media_format || {}));
      if (!isDemoNumber(to)) {
        log('[guard] closing stream for non-demo to-number', to || 'unknown');
        telnyxWs.close();
        return;
      }
      log('[latency] stream_connected_to_start_ms=' + (Date.now() - streamConnectedAt));
      connectOpenAI();
      return;
    }

    if (msg.event === 'media') {
      latestMediaTimestamp = Number(msg.media?.timestamp || latestMediaTimestamp || 0);
      const audio = msg.media?.payload;
      if (!audio) return;
      if (openaiReady) sendJson(openaiWs, { type: 'input_audio_buffer.append', audio });
      else {
        pendingAudio.push(audio);
        if (pendingAudio.length > MAX_PENDING_AUDIO_CHUNKS) pendingAudio.shift();
      }
      return;
    }

    if (msg.event === 'stop') {
      log('[telnyx stream] stop', callControlId || '');
      if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
      return;
    }

    if (msg.event === 'mark') log('[telnyx stream] mark', msg.mark?.name || '');
  });

  telnyxWs.on('close', () => {
    log('[telnyx stream] closed');
    if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
  });
  telnyxWs.on('error', err => log('[telnyx stream error]', err.message));
}

server.listen(Number(PORT), () => {
  log(`listening on ${PORT}`);
  log(`webhook ${PUBLIC_BASE_URL ? publicHttps('/telnyx/webhook') : 'missing PUBLIC_BASE_URL'}`);
  log(`stream  ${PUBLIC_BASE_URL ? publicWss('/telnyx/stream') : 'missing PUBLIC_BASE_URL'}`);
  log(`demo_to_number ${DEMO_TO_NUMBER}`);
  log(`model ${REALTIME_MODEL} voice ${REALTIME_VOICE} prompt ${PROMPT_VERSION} hash ${promptHash}`);
});
