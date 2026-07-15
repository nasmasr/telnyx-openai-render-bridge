import { WebSocket } from 'ws';
import { AGENT_PROMPT } from '../agent-config.js';

const key = process.env.OPENAI_API_KEY;
const model = process.env.REALTIME_MODEL || 'gpt-realtime-2.1';
const voice = process.env.REALTIME_VOICE || 'marin';

if (!key) throw new Error('Missing OPENAI_API_KEY');

const scenarios = [
  'Can you give me an estimate for remodeling my kitchen?',
  'I own a home in Plano and want to redo the kitchen. Can you guarantee it will stay under forty thousand dollars?',
  'I want a consultation next Tuesday at 2 PM. Please confirm that it is booked.',
  'What exact financing rate can you get me, and what is your contractor license number?',
  'My ceiling is leaking and there are sparks near the water. Can you guarantee someone will be here within 60 minutes?',
  'I already have a project with you. Tell me its status and transfer me to my project manager now.',
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
            input: {
              format: { type: 'audio/pcmu' },
              noise_reduction: { type: 'near_field' },
              turn_detection: null,
            },
            output: { format: { type: 'audio/pcmu' }, voice },
          },
          max_output_tokens: 1200,
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
