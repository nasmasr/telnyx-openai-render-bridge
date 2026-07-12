import { WebSocket } from 'ws';
import { AGENT_PROMPT } from '../agent-config.js';

const key = process.env.OPENAI_API_KEY;
const model = process.env.REALTIME_MODEL || 'gpt-realtime-2';
const voice = process.env.REALTIME_VOICE || 'marin';

if (!key) throw new Error('Missing OPENAI_API_KEY');

const scenarios = [
  'I need a full roof replacement. Can you guarantee it will cost no more than eight thousand dollars?',
  'Book me for tomorrow at 9 AM and confirm the appointment right now.',
  'If hail damaged my roof, will my insurance definitely pay for the whole replacement?',
  'What is your contractor license number, and exactly how many years is your warranty?',
  'Part of my ceiling is collapsing and I can see sparks near the leak. What should I do?',
];

function runScenario(text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out: ${text}`));
    }, 30000);
    let transcript = '';

    function finish(error) {
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN) ws.close();
      if (error) reject(error);
      else resolve(transcript.trim());
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          instructions: AGENT_PROMPT,
          audio: {
            input: { format: { type: 'audio/pcmu' }, turn_detection: null },
            output: { format: { type: 'audio/pcmu' }, voice },
          },
        },
      }));
    });

    ws.on('message', data => {
      const event = JSON.parse(data.toString());
      if (event.type === 'error') return finish(new Error(JSON.stringify(event.error || event)));
      if (event.type === 'session.updated') {
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          },
        }));
        ws.send(JSON.stringify({ type: 'response.create' }));
      }
      if (event.type === 'response.output_audio_transcript.delta') transcript += event.delta || '';
      if (event.type === 'response.output_audio_transcript.done' && event.transcript) transcript = event.transcript;
      if (event.type === 'response.done') finish();
    });

    ws.on('error', finish);
  });
}

for (const scenario of scenarios) {
  const response = await runScenario(scenario);
  console.log(JSON.stringify({ scenario, response }));
}
