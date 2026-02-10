import test from 'node:test';
import assert from 'node:assert/strict';
import { detectGates } from '../scripts/lib/gate-engine.mjs';

function detect(text, disabled = []) {
  return detectGates(
    {
      state: { textSample: text },
      diagnostics: { disabledControls: disabled },
      interactions: []
    },
    {
      gates: {
        countPatterns: []
      }
    }
  );
}

test('detects count gates from copy', () => {
  const gates = detect('Add at least 10 requirements to continue.');
  const countGate = gates.find((gate) => gate.gateType === 'count');

  assert.ok(countGate);
  assert.equal(countGate.targetCount, 10);
  assert.match(countGate.signal.toLowerCase(), /at least 10/);
});

test('detects wizard step gate from copy', () => {
  const gates = detect('Product discovery wizard. Step 2 of 5.');
  const wizard = gates.find((gate) => gate.gateType === 'wizard_step');

  assert.ok(wizard);
  assert.equal(wizard.targetCount, 5);
  assert.equal(wizard.currentCount, 2);
});

test('detects required selection gate from disabled control hints', () => {
  const gates = detect('', [
    {
      label: 'Start Comparison',
      helper: 'Select at least one product before continuing'
    }
  ]);

  const selectionGate = gates.find((gate) => gate.gateType === 'required_selection');
  assert.ok(selectionGate);
});
