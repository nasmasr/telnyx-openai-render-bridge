import crypto from 'node:crypto';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const {
  TELNYX_API_KEY,
  OPENAI_API_KEY,
  PUBLIC_BASE_URL,
  DEMO_TO_NUMBER,
  REALTIME_MODEL = 'gpt-realtime-2',
  REALTIME_VOICE,
  AGENT_PROMPT,
  GREETING_INSTRUCTIONS,
  PROMPT_VERSION = 'unset',
  PORT = 3000,
} = process.env;

const required = {
  TELNYX_API_KEY,
  OPENAI_API_KEY,
  PUBLIC_BASE_URL,
  DEMO_TO_NUMBER,
  REALTIME_MODEL,
  REALTIME_VOICE,
  AGENT_PROMPT,
  GREETING_INSTRUCTIONS,
};
for (const [key, value] of Object.entries(required)) {
  if (!value || !String(value).trim()) throw new Error(`${key} is required`);
}

const promptHash = crypto.createHash('sha256').update(AGENT_PROMPT).digest('hex').slice(0, 12);
const app = express();
app.use(express.json({ type: '*/*' }));
app.use(express.urlencoded({ extended: false }));

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const calls = new Map();

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

app.get('/', (req, res) => res.type('text/plain').send('Dedicated lead demo Telnyx → OpenAI Realtime bridge OK'));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    stack: 'dedicated-lead-demo-telnyx-render-openai-realtime-gpt',
    demo_to_number: DEMO_TO_NUMBER,
    model: REALTIME_MODEL,
    voice: REALTIME_VOICE,
    prompt_version: PROMPT_VERSION,
    prompt_hash: promptHash,
    webhook: publicHttps('/telnyx/webhook'),
    stream: publicWss('/telnyx/stream'),
  });
});

app.post('/telnyx/webhook', async (req, res) => {
  res.sendStatus(200);

  const event = req.body?.data || req.body;
  const eventType = event?.event_type;
  const payload = event?.payload || {};
  const callControlId = payload.call_control_id;
  log('[telnyx webhook]', eventType, callControlId || '', payload.from || '', '→', payload.to || '');

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
              transcription: { model: 'whisper-1' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.45,
                prefix_padding_ms: 250,
                silence_duration_ms: 400,
              },
            },
            output: { format: { type: 'audio/pcmu' }, voice: REALTIME_VOICE },
          },
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

      if (event.type === 'response.output_audio.delta' && streamId) {
        sendJson(telnyxWs, { event: 'media', media: { payload: event.delta } });
        return;
      }

      if (event.type === 'response.output_audio.done' && streamId) {
        sendJson(telnyxWs, { event: 'mark', mark: { name: 'response_done' } });
        return;
      }

      if (event.type === 'input_audio_buffer.speech_started') {
        // Do not send OpenAI truncate until Telnyx/OpenAI timestamp domains are reconciled.
        // Previous implementation sent impossible truncate times and degraded barge-in.
        sendJson(telnyxWs, { event: 'clear' });
        log('[barge-in] caller speech detected; cleared Telnyx playback queue');
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
      else pendingAudio.push(audio);
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
  log(`webhook ${publicHttps('/telnyx/webhook')}`);
  log(`stream  ${publicWss('/telnyx/stream')}`);
  log(`demo_to_number ${DEMO_TO_NUMBER}`);
  log(`model ${REALTIME_MODEL} voice ${REALTIME_VOICE} prompt ${PROMPT_VERSION} hash ${promptHash}`);
});
