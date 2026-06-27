import express from 'express';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const {
  TELNYX_API_KEY,
  OPENAI_API_KEY,
  PUBLIC_BASE_URL,
  REALTIME_MODEL = 'gpt-realtime-2',
  REALTIME_VOICE = 'alloy',
  AGENT_PROMPT,
  PORT = 3000,
} = process.env;

if (!TELNYX_API_KEY) throw new Error('Missing TELNYX_API_KEY');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
if (!PUBLIC_BASE_URL) throw new Error('Missing PUBLIC_BASE_URL, e.g. https://service.onrender.com');

const PROMPT = AGENT_PROMPT || `ALWAYS speak English. Never switch languages.
You are a concise phone voice agent for Conversion Labs.
Say exactly: "Hey, thanks for calling Conversion Labs! How can I help?"
After the greeting, never say "Conversion Labs" again; say "we", "here", or "our team".
Keep every reply to 1 short sentence unless asked for detail.
We build AI voice agents for service businesses that answer calls, answer questions, and book appointments 24/7.
Pricing is $99 first month, then $250 per month. No contracts.`;

const app = express();
app.use(express.json({ type: '*/*' }));
app.use(express.urlencoded({ extended: false }));

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

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

app.get('/', (req, res) => res.type('text/plain').send('Telnyx → OpenAI Realtime bridge OK'));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    stack: 'telnyx-call-control-media-streaming-render-openai-realtime-gpt',
    model: REALTIME_MODEL,
    voice: REALTIME_VOICE,
    webhook: publicHttps('/telnyx/webhook'),
    stream: publicWss('/telnyx/stream'),
  });
});

app.post('/telnyx/webhook', async (req, res) => {
  res.sendStatus(200);

  const event = req.body?.data || req.body;
  const eventType = event?.event_type;
  const payload = event?.payload || {};
  log('[telnyx webhook]', eventType, payload.call_control_id || '', payload.from || '', '→', payload.to || '');

  if (eventType !== 'call.initiated' || payload.direction !== 'incoming') return;
  if (!payload.call_control_id) return log('[telnyx webhook] missing call_control_id');

  const answerBody = {
    stream_url: publicWss('/telnyx/stream'),
    stream_track: 'inbound_track',
    stream_codec: 'PCMU',
    stream_bidirectional_mode: 'rtp',
    stream_bidirectional_codec: 'PCMU',
    stream_bidirectional_sampling_rate: 8000,
    send_silence_when_idle: true,
    client_state: Buffer.from(JSON.stringify({ from: payload.from, to: payload.to })).toString('base64'),
    command_id: `answer-${payload.call_control_id.slice(-12)}-${Date.now()}`,
  };

  try {
    const answer = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(payload.call_control_id)}/actions/answer`, {
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
  log('[telnyx stream] connected');

  let streamId = null;
  let latestMediaTimestamp = 0;
  let openaiReady = false;
  let openaiWs = null;
  let lastAssistantItem = null;
  let responseStartTimestamp = null;
  const pendingAudio = [];

  function connectOpenAI() {
    if (openaiWs) return;
    openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });

    openaiWs.on('open', () => {
      log('[openai] connected', REALTIME_MODEL);
      sendJson(openaiWs, {
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          instructions: PROMPT,
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              transcription: { model: 'whisper-1' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
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
        log('[openai] session.updated');
        for (const audio of pendingAudio.splice(0)) sendJson(openaiWs, { type: 'input_audio_buffer.append', audio });
        sendJson(openaiWs, { type: 'response.create' });
        return;
      }

      if (event.type === 'response.output_item.added' && event.item?.id) {
        lastAssistantItem = event.item.id;
        responseStartTimestamp = latestMediaTimestamp;
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
        if (lastAssistantItem && responseStartTimestamp !== null && latestMediaTimestamp !== null) {
          sendJson(openaiWs, {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: Math.max(0, latestMediaTimestamp - responseStartTimestamp),
          });
        }
        sendJson(telnyxWs, { event: 'clear' });
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
      latestMediaTimestamp = 0;
      log('[telnyx stream] start', streamId, msg.start?.from || '', '→', msg.start?.to || '', JSON.stringify(msg.start?.media_format || {}));
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
      log('[telnyx stream] stop');
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
});
