import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicPlan, searchKnowledge, needsApproval } from '../server.js';

test('planner includes a verification step', () => {
  const plan = deterministicPlan('Prepare a weekly operations brief');
  assert.ok(plan.some(step => step.tool === 'verification.check_result'));
});
test('sensitive actions are gated', () => {
  assert.equal(needsApproval('Send an email to the customer'), true);
  assert.equal(needsApproval('Summarize internal policy documents'), false);
});
test('knowledge search returns source identifiers for policy questions', () => {
  const results = searchKnowledge('external communication approval');
  assert.ok(results.length > 0);
  assert.ok(results.every(item => item.sourceId && item.snippet));
});
