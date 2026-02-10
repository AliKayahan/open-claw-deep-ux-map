import test from 'node:test';
import assert from 'node:assert/strict';
import { critiqueScreenProgress } from '../scripts/lib/critic-engine.mjs';

test('critic proposes branch actions when flow stalls', () => {
  const recentEvents = [
    { actionLabel: 'Open', changed: false },
    { actionLabel: 'Open', changed: false },
    { actionLabel: 'Open', changed: false },
    { actionLabel: 'Open', changed: false }
  ];

  const interactions = [
    { selector: '#menu', text: 'More Options', ariaLabel: '', title: '', contextText: '' },
    { selector: '#tab', text: 'Filter', ariaLabel: '', title: '', contextText: '' }
  ];

  const out = critiqueScreenProgress({ recentEvents, interactions, gates: [] });
  assert.equal(out.shouldBranch, true);
  assert.ok(out.actions.length > 0);
});
