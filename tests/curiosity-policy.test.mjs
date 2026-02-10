import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoopGuard, prioritizeInteractions } from '../scripts/lib/policy/curiosity-policy.mjs';

test('prioritizeInteractions favors deepening actions like Add/New over generic actions', () => {
  const interactions = [
    { key: 'a', text: 'Open', ariaLabel: '', title: '', iconHint: '', tagName: 'button' },
    { key: 'b', text: 'Add Requirement', ariaLabel: '', title: '', iconHint: '', tagName: 'button' },
    { key: 'c', text: 'More Options', ariaLabel: '', title: '', iconHint: '', tagName: 'button' }
  ];

  const sorted = prioritizeInteractions(interactions, { visitedSignatures: new Set() });
  assert.equal(sorted[0].key, 'b');
});

test('loop guard stops on repeated action cap', () => {
  const guard = createLoopGuard({ maxRepeatedActionCount: 2, maxNoopStreak: 10 });

  const first = guard.register('same-action', true);
  const second = guard.register('same-action', false);
  const third = guard.register('same-action', false);

  assert.equal(first.shouldStop, false);
  assert.equal(second.shouldStop, false);
  assert.equal(third.shouldStop, true);
  assert.equal(third.reason, 'repeated-action-cap');
});
