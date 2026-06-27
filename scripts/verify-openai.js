import { WebSocket } from 'ws';

const key = process.env.OPENAI_API_KEY;
const model = process.env.REALTIME_MODEL || 'gpt-realtime-2';
const voice = process.env.REALTIME_VOICE || 'alloy';
if (!key) throw new Error('Missing OPENAI_API_KEY');

const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
  headers: { Authorization: `Bearer ${key}` },
});

const timeout = setTimeout(() => {
  console.error('timeout waiting for OpenAI Realtime session.updated');
  ws.close();
  process.exit(1);
}, 15000);

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions: 'ALWAYS speak English. Keep responses short.',
      audio: {
        input: { format: { type: 'audio/pcmu' }, transcription: { model: 'whisper-1' }, turn_detection: { type: 'server_vad' } },
        output: { format: { type: 'audio/pcmu' }, voice },
      },
    },
  }));
});

ws.on('message', data => {
  const event = JSON.parse(data.toString());
  if (event.type === 'error') {
    clearTimeout(timeout);
    console.error(JSON.stringify(event.error || event));
    ws.close();
    process.exit(1);
  }
  if (event.type === 'session.updated') {
    clearTimeout(timeout);
    console.log(`verified OpenAI Realtime ${model} PCMU session.updated`);
    ws.close();
  }
});

ws.on('close', () => process.exit(0));
ws.on('error', err => {
  clearTimeout(timeout);
  console.error(err.message);
  process.exit(1);
});
