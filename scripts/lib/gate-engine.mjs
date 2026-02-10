import { normalizeText, safeArray } from './fs-utils.mjs';

const DEFAULT_COUNT_PATTERNS = [
  '(?:at\\s+least|minimum\\s+of)\\s+(\\d+)\\s+([a-z][a-z\\- ]{1,30})',
  'add\\s+(\\d+)\\s+([a-z][a-z\\- ]{1,30})',
  '(\\d+)\\s+(?:remaining|left)\\b',
  'step\\s+(\\d+)\\s+of\\s+(\\d+)'
];

function toRegex(pattern) {
  try {
    return new RegExp(pattern, 'ig');
  } catch {
    return null;
  }
}

function parseNumericGates(text, patterns = []) {
  const source = String(text || '');
  const gates = [];

  for (const pattern of patterns) {
    const regex = toRegex(pattern);
    if (!regex) {
      continue;
    }

    let match;
    while ((match = regex.exec(source)) !== null) {
      if (/step\s+\d+\s+of\s+\d+/i.test(match[0])) {
        const current = Number(match[1] || 0);
        const total = Number(match[2] || 0);
        if (total > 0) {
          gates.push({
            gateType: 'wizard_step',
            signal: match[0],
            targetCount: total,
            currentCount: current,
            entityHint: 'step'
          });
        }
        continue;
      }

      const target = Number(match[1] || 0);
      if (!target || Number.isNaN(target)) {
        continue;
      }

      const hint = (match[2] || '').trim() || 'item';
      gates.push({
        gateType: 'count',
        signal: match[0],
        targetCount: target,
        currentCount: 0,
        entityHint: hint
      });
    }
  }

  return gates;
}

export function detectGates(input = {}, config = {}) {
  const diagnostics = input.diagnostics || {};
  const state = input.state || {};
  const patterns = safeArray(config?.gates?.countPatterns);
  const mergedPatterns = [...DEFAULT_COUNT_PATTERNS, ...patterns];

  const gates = [];
  const sourceText = `${state.textSample || ''} ${safeArray(diagnostics.disabledControls)
    .map((entry) => `${entry.label || ''} ${entry.helper || ''}`)
    .join(' ')}`;

  for (const gate of parseNumericGates(sourceText, mergedPatterns)) {
    gates.push(gate);
  }

  for (const disabled of safeArray(diagnostics.disabledControls)) {
    const label = normalizeText(`${disabled.label} ${disabled.helper}`);
    if (!label) {
      continue;
    }

    if (/select|choose|pick/.test(label)) {
      gates.push({
        gateType: 'required_selection',
        signal: `${disabled.label} ${disabled.helper}`.trim(),
        targetCount: 1,
        currentCount: 0,
        entityHint: 'selection'
      });
    }

    if (/required|fill|complete|missing/.test(label)) {
      gates.push({
        gateType: 'min_fields',
        signal: `${disabled.label} ${disabled.helper}`.trim(),
        targetCount: 1,
        currentCount: 0,
        entityHint: 'field'
      });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const gate of gates) {
    const key = normalizeText(`${gate.gateType}|${gate.signal}|${gate.targetCount}|${gate.entityHint}`);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(gate);
  }

  return deduped;
}

export function gateProgress(gate, input = {}) {
  const interactions = safeArray(input.interactions);
  const events = safeArray(input.events);

  if (gate.gateType === 'wizard_step') {
    const explicit = Number(gate.currentCount || 0);
    if (explicit > 0) {
      return explicit;
    }
    const stepEvents = events.filter((entry) => /next|continue|step/i.test(String(entry.actionLabel || '')));
    return stepEvents.length;
  }

  if (gate.gateType === 'count') {
    const hint = normalizeText(gate.entityHint || '');
    const matched = events.filter((entry) => {
      const text = normalizeText(`${entry.actionLabel || ''} ${entry.entity || ''}`);
      return hint ? text.includes(hint) : /add|create|new/.test(text);
    });
    return matched.length;
  }

  if (gate.gateType === 'required_selection') {
    const selected = events.some((entry) => /select|choose|pick|filter/.test(normalizeText(entry.actionLabel || '')));
    return selected ? 1 : 0;
  }

  if (gate.gateType === 'min_fields') {
    const filled = events.filter((entry) => entry.kind === 'form-fill').length;
    return filled;
  }

  return 0;
}

export function isGateSatisfied(gate, progressCount) {
  const target = Number(gate.targetCount || 0);
  if (target <= 0) {
    return progressCount > 0;
  }
  return Number(progressCount || 0) >= target;
}

export function selectGateActionHints(gate, interactions = []) {
  const list = safeArray(interactions);
  const hint = normalizeText(gate.entityHint || '');

  const sorted = [...list].sort((a, b) => {
    const score = (item) => {
      const text = normalizeText(`${item.text} ${item.ariaLabel} ${item.title} ${item.contextText}`);
      let value = 0;
      if (/add|new|create|insert|plus|continue|next|start|submit|save/.test(text)) {
        value += 5;
      }
      if (hint && text.includes(hint)) {
        value += 4;
      }
      if (/menu|more|options|ellipsis/.test(text)) {
        value += 2;
      }
      return value;
    };

    return score(b) - score(a);
  });

  return sorted.slice(0, 12);
}
