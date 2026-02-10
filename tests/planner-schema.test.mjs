import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlannerPlan } from '../scripts/lib/llm/planner-schema.mjs';

test('planner schema rejects invalid action types when strict validation enabled', () => {
  const result = validatePlannerPlan(
    {
      screenIntent: 'test',
      priorityActions: [
        {
          actionType: 'fly',
          target: { label: 'Submit' }
        }
      ]
    },
    { requirePlanSchemaValidation: true }
  );

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /actionType/);
});

test('planner schema normalizes valid action and gate payload', () => {
  const result = validatePlannerPlan(
    {
      screenIntent: 'complete wizard',
      priorityActions: [
        {
          actionType: 'next-step',
          target: { label: 'Next' },
          repeatPolicy: { times: 1, max: 5 }
        }
      ],
      gates: [
        {
          gateType: 'wizard_step',
          signal: 'Step 2 of 5',
          targetCount: 5,
          currentCount: 2
        }
      ]
    },
    { requirePlanSchemaValidation: true }
  );

  assert.equal(result.ok, true);
  assert.equal(result.plan.priorityActions[0].actionType, 'next-step');
  assert.equal(result.plan.gates[0].gateType, 'wizard_step');
  assert.equal(result.plan.gates[0].targetCount, 5);
});
