import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_PROMPT, GREETING_INSTRUCTIONS, PROMPT_VERSION } from '../agent-config.js';

test('demo prompt is versioned and contains factual guardrails', () => {
  assert.match(PROMPT_VERSION, /^tx-standard-roofing-v3-/);
  assert.match(AGENT_PROMPT, /Never invent prices/);
  assert.match(AGENT_PROMPT, /You do not have calendar access/);
  assert.match(AGENT_PROMPT, /cannot promise claim approval/);
  assert.match(AGENT_PROMPT, /ask one question at a time/i);
});

test('greeting identifies the AI and discloses recording', () => {
  assert.match(GREETING_INSTRUCTIONS, /AI assistant/);
  assert.match(GREETING_INSTRUCTIONS, /may be recorded/);
});
