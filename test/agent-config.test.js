import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROMPT,
  GREETING_INSTRUCTIONS,
  GREETING_TEXT,
  PROMPT_VERSION,
  SERVICE_AREAS,
} from '../agent-config.js';

test('America\'s General Contractor prompt is versioned and replaces the prior business', () => {
  assert.match(PROMPT_VERSION, /^americas-general-contractor-v1-/);
  assert.match(AGENT_PROMPT, /America's General Contractor/);
  assert.doesNotMatch(AGENT_PROMPT, /TX Standard Roofing/i);
  assert.ok(SERVICE_AREAS.includes('Plano'));
});

test('prompt contains intake, accuracy, and emergency guardrails', () => {
  assert.match(AGENT_PROMPT, /Ask one question at a time/i);
  assert.match(AGENT_PROMPT, /Do not preview the next question/i);
  assert.match(AGENT_PROMPT, /Do not ask for a budget/i);
  assert.match(AGENT_PROMPT, /do not have calendar access/i);
  assert.match(AGENT_PROMPT, /typically arrive within 60 to 90 minutes, depending on location and crew availability/i);
  assert.match(AGENT_PROMPT, /Never guarantee an appointment/i);
  assert.match(AGENT_PROMPT, /Never ask for payment-card/i);
  assert.match(AGENT_PROMPT, /no transfer or dispatch has occurred/i);
  assert.match(AGENT_PROMPT, /Do not continue intake until they confirm they are safe/i);
});

test('greeting is exact, identifies the AI, and discloses recording', () => {
  assert.equal(
    GREETING_TEXT,
    "Thanks for calling America's General Contractor. I'm Clara, the AI assistant. This demo call may be recorded. Are you calling about a remodeling project, an existing project, or an urgent property-damage issue?",
  );
  assert.match(GREETING_INSTRUCTIONS, /Begin with exactly this greeting/);
  assert.match(GREETING_INSTRUCTIONS, /AI assistant/);
  assert.match(GREETING_INSTRUCTIONS, /may be recorded/);
});
