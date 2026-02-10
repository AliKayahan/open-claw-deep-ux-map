import { safeArray } from '../fs-utils.mjs';

export const ACTION_TYPES = new Set([
  'click',
  'fill',
  'select',
  'toggle',
  'submit',
  'add-row',
  'next-step',
  'open-menu'
]);

export const GATE_TYPES = new Set([
  'count',
  'min_fields',
  'wizard_step',
  'required_selection',
  'dependency'
]);

export function normalizePlannerPlan(input = {}) {
  const plan = input && typeof input === 'object' ? input : {};
  const normalized = {
    screenIntent: String(plan.screenIntent || '').trim() || 'explore-screen',
    priorityActions: safeArray(plan.priorityActions)
      .map((action) => ({
        actionType: String(action?.actionType || '').trim(),
        target: {
          selector: String(action?.target?.selector || '').trim(),
          label: String(action?.target?.label || '').trim(),
          contains: String(action?.target?.contains || '').trim()
        },
        inputValuePolicy: {
          mode: String(action?.inputValuePolicy?.mode || '').trim(),
          value: action?.inputValuePolicy?.value
        },
        repeatPolicy: {
          times: Number(action?.repeatPolicy?.times || 1),
          max: Number(action?.repeatPolicy?.max || action?.repeatPolicy?.times || 1),
          untilCondition: String(action?.repeatPolicy?.untilCondition || '').trim()
        }
      }))
      .filter((action) => action.actionType),
    gates: safeArray(plan.gates)
      .map((gate) => ({
        gateType: String(gate?.gateType || '').trim(),
        signal: String(gate?.signal || '').trim(),
        targetCount: Number(gate?.targetCount || 0),
        entityHint: String(gate?.entityHint || '').trim(),
        currentCount: Number(gate?.currentCount || 0)
      }))
      .filter((gate) => gate.gateType),
    expectedOutcome: String(plan.expectedOutcome || '').trim(),
    fallbackAction: plan.fallbackAction && typeof plan.fallbackAction === 'object'
      ? {
        actionType: String(plan.fallbackAction.actionType || '').trim(),
        target: {
          selector: String(plan.fallbackAction.target?.selector || '').trim(),
          label: String(plan.fallbackAction.target?.label || '').trim(),
          contains: String(plan.fallbackAction.target?.contains || '').trim()
        }
      }
      : null
  };

  for (const action of normalized.priorityActions) {
    action.repeatPolicy.times = Math.max(1, action.repeatPolicy.times || 1);
    action.repeatPolicy.max = Math.max(action.repeatPolicy.times, action.repeatPolicy.max || action.repeatPolicy.times);
  }

  return normalized;
}

export function validatePlannerPlan(input, options = {}) {
  const requireSchema = options.requirePlanSchemaValidation !== false;
  const plan = normalizePlannerPlan(input);
  const errors = [];

  if (!plan.screenIntent) {
    errors.push('screenIntent is required');
  }

  for (const [index, action] of plan.priorityActions.entries()) {
    if (!ACTION_TYPES.has(action.actionType)) {
      errors.push(`priorityActions[${index}].actionType must be one of ${Array.from(ACTION_TYPES).join(', ')}`);
    }
    if (!action.target.selector && !action.target.label && !action.target.contains) {
      errors.push(`priorityActions[${index}].target requires selector, label, or contains`);
    }
    if (action.repeatPolicy.max > 100) {
      errors.push(`priorityActions[${index}].repeatPolicy.max is too high`);
    }
  }

  for (const [index, gate] of plan.gates.entries()) {
    if (!GATE_TYPES.has(gate.gateType)) {
      errors.push(`gates[${index}].gateType must be one of ${Array.from(GATE_TYPES).join(', ')}`);
    }
    if (!gate.signal) {
      errors.push(`gates[${index}].signal is required`);
    }
    if (Number.isNaN(gate.targetCount) || gate.targetCount < 0) {
      errors.push(`gates[${index}].targetCount must be >= 0`);
    }
  }

  if (plan.fallbackAction?.actionType && !ACTION_TYPES.has(plan.fallbackAction.actionType)) {
    errors.push(`fallbackAction.actionType must be one of ${Array.from(ACTION_TYPES).join(', ')}`);
  }

  if (requireSchema && errors.length > 0) {
    return {
      ok: false,
      errors,
      plan
    };
  }

  return {
    ok: true,
    errors,
    plan
  };
}
