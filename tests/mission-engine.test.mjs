import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMissionState,
  detectScreenSignals,
  missionProgressSummary,
  proposeMissionActions,
  updateMissionStateFromEvent
} from '../scripts/lib/mission-engine.mjs';

test('mission engine proposes platform-agnostic add/create action for count gate', () => {
  const state = createMissionState({ minRepeatableCreateTarget: 8, maxRepeatableCreateTarget: 10 });
  const interactions = [
    { selector: '#add', text: 'Add Item', ariaLabel: '', title: '', placeholder: '', contextText: '', iconHint: '', tagName: 'button' },
    { selector: '#next', text: 'Continue', ariaLabel: '', title: '', placeholder: '', contextText: '', iconHint: '', tagName: 'button' }
  ];

  const signals = detectScreenSignals(
    { title: 'Builder', headline: 'Create Items', textSample: 'Add at least 10 items to continue', disabledControls: [] },
    interactions,
    [{ gateType: 'count', signal: 'Add at least 10 items', targetCount: 10, currentCount: 0, entityHint: 'item' }]
  );

  const out = proposeMissionActions({
    missionState: state,
    interactions,
    gates: [{ gateType: 'count', signal: 'Add at least 10 items', targetCount: 10, currentCount: 0, entityHint: 'item' }],
    config: { maxMissionRepeat: 4 },
    recentEvents: [],
    screenSignals: signals
  });

  assert.ok(out.actions.some((a) => a.actionType === 'add-row'));
});

test('mission progress summary increases after generic events', () => {
  const state = createMissionState({ chatTurnsTarget: 2, branchExplorationTarget: 2 });

  updateMissionStateFromEvent(state, { actionLabel: 'Add item', entity: 'item' });
  updateMissionStateFromEvent(state, { actionLabel: 'Open menu options', entity: '' });
  updateMissionStateFromEvent(state, { actionLabel: 'Send message', entity: 'assistant' });

  const summary = missionProgressSummary(state);
  assert.ok(summary.progressPct > 0);
  assert.ok(summary.counters.createActions >= 1);
});
