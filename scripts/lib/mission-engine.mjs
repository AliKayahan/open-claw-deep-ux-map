import { normalizeText, safeArray } from './fs-utils.mjs';

function norm(value) {
  return normalizeText(value || '');
}

function textOf(item) {
  return norm(`${item?.text || ''} ${item?.ariaLabel || ''} ${item?.title || ''} ${item?.placeholder || ''} ${item?.contextText || ''} ${item?.iconHint || ''}`);
}

function hasKeyword(text, list = []) {
  return safeArray(list).some((keyword) => text.includes(norm(keyword)));
}

function pickAction(interactions, include = [], fallback = []) {
  const candidates = safeArray(interactions)
    .map((item) => ({ item, text: textOf(item) }))
    .filter((entry) => entry.text.length > 0);

  for (const keyword of include) {
    const key = norm(keyword);
    const found = candidates.find((entry) => entry.text.includes(key));
    if (found) {
      return found.item;
    }
  }

  for (const keyword of fallback) {
    const key = norm(keyword);
    const found = candidates.find((entry) => entry.text.includes(key));
    if (found) {
      return found.item;
    }
  }

  return null;
}

function toPlanAction(item, actionType, repeatMax = 1, inputValue = '') {
  if (!item) {
    return null;
  }

  return {
    actionType,
    target: {
      selector: item.selector,
      label: item.text || item.ariaLabel || item.title || '',
      contains: item.contextText || ''
    },
    inputValuePolicy: inputValue
      ? {
          mode: 'fixed',
          value: inputValue
        }
      : {
          mode: 'auto',
          value: ''
        },
    repeatPolicy: {
      times: 1,
      max: Math.max(1, repeatMax),
      untilCondition: ''
    }
  };
}

export function createMissionState(config = {}) {
  const minRepeatableCreateTarget = Math.max(1, Number(config.minRepeatableCreateTarget || 8));
  const maxRepeatableCreateTarget = Math.max(minRepeatableCreateTarget, Number(config.maxRepeatableCreateTarget || 10));

  return {
    profile: 'human-like-platform-agnostic',
    goals: {
      repeatableCreateTarget: Math.min(maxRepeatableCreateTarget, 12),
      chatTurnsTarget: Math.max(1, Number(config.chatTurnsTarget || 3)),
      branchExplorationTarget: Math.max(2, Number(config.branchExplorationTarget || 6))
    },
    counters: {
      createActions: 0,
      wizardAdvances: 0,
      selectionActions: 0,
      chatTurns: 0,
      branchExplores: 0
    },
    signals: {
      repeatableCreateSurfaceSeen: false,
      wizardSurfaceSeen: false,
      gatedCtaSeen: false,
      chatSurfaceSeen: false
    },
    completedGoals: [],
    lastPhase: 'explore'
  };
}

export function detectScreenSignals(screenContext, interactions = [], gates = []) {
  const text = norm(
    `${screenContext?.title || ''} ${screenContext?.headline || ''} ${screenContext?.textSample || ''} ${
      safeArray(screenContext?.disabledControls).map((item) => `${item.label || ''} ${item.helper || ''}`).join(' ')
    }`
  );

  const interactionText = safeArray(interactions).map((item) => textOf(item)).join(' ');

  const repeatableCreateSurface =
    hasKeyword(`${text} ${interactionText}`, ['add', 'new', 'create', 'insert', 'plus']) &&
    safeArray(interactions).some((item) => ['button', 'a'].includes(item.tagName));

  const wizardSurface =
    hasKeyword(`${text} ${interactionText}`, ['step', 'next', 'continue', 'back', 'wizard']) ||
    safeArray(gates).some((gate) => gate.gateType === 'wizard_step');

  const gatedSurface = safeArray(gates).length > 0 || hasKeyword(text, ['required', 'remaining', 'at least', 'minimum']);

  const chatSurface =
    safeArray(interactions).some((item) => {
      const t = textOf(item);
      return ['textarea', 'input'].includes(item.tagName) && hasKeyword(t, ['message', 'ask', 'prompt', 'chat']);
    }) || hasKeyword(`${text} ${interactionText}`, ['assistant', 'chat', 'message']);

  return {
    repeatableCreateSurface,
    wizardSurface,
    gatedSurface,
    chatSurface
  };
}

export function proposeMissionActions(params = {}) {
  const {
    missionState,
    interactions,
    gates = [],
    config = {},
    recentEvents = [],
    screenSignals
  } = params;

  const actions = [];
  const notes = [];

  if (screenSignals.repeatableCreateSurface) {
    missionState.signals.repeatableCreateSurfaceSeen = true;
  }
  if (screenSignals.wizardSurface) {
    missionState.signals.wizardSurfaceSeen = true;
  }
  if (screenSignals.gatedSurface) {
    missionState.signals.gatedCtaSeen = true;
  }
  if (screenSignals.chatSurface) {
    missionState.signals.chatSurfaceSeen = true;
  }

  const missionRepeatCap = Math.max(1, Number(config.maxMissionRepeat || 4));

  const countGate = safeArray(gates).find((gate) => gate.gateType === 'count');
  if (countGate) {
    const addAction = pickAction(
      interactions,
      [
        `add ${countGate.entityHint || ''}`,
        `create ${countGate.entityHint || ''}`,
        'add',
        'new',
        'create',
        'plus'
      ],
      ['add', 'new', 'create']
    );
    const remaining = Math.max(1, Number(countGate.targetCount || missionState.goals.repeatableCreateTarget) - missionState.counters.createActions);
    const action = toPlanAction(addAction, 'add-row', Math.min(remaining, missionRepeatCap));
    if (action) {
      actions.push(action);
      notes.push(`count-gate:${countGate.signal}`);
      missionState.lastPhase = 'gate-count';
    }
  }

  const wizardGate = safeArray(gates).find((gate) => gate.gateType === 'wizard_step');
  if (wizardGate || screenSignals.wizardSurface) {
    const nextAction = pickAction(interactions, ['next', 'continue', 'proceed', 'start'], ['next', 'continue']);
    const action = toPlanAction(nextAction, 'next-step', 1);
    if (action) {
      actions.push(action);
      notes.push('wizard-advance');
      missionState.lastPhase = 'wizard';
    }
  }

  const selectionGate = safeArray(gates).find((gate) => gate.gateType === 'required_selection');
  if (selectionGate) {
    const selectAction = pickAction(interactions, ['select', 'choose', 'pick', 'filter'], ['select', 'choose', 'filter']);
    const action = toPlanAction(selectAction, selectAction?.tagName === 'select' ? 'select' : 'click', 1);
    if (action) {
      actions.push(action);
      notes.push(`selection-gate:${selectionGate.signal}`);
      missionState.lastPhase = 'selection';
    }
  }

  if (screenSignals.chatSurface && missionState.counters.chatTurns < missionState.goals.chatTurnsTarget) {
    const messageField = safeArray(interactions).find((item) => {
      const text = textOf(item);
      return ['textarea', 'input'].includes(item.tagName) && hasKeyword(text, ['message', 'ask', 'prompt', 'chat']);
    });

    if (messageField) {
      const prompts = [
        'Summarize this step and next action.',
        'What can I validate on this screen?',
        'List possible edge-cases before proceeding.'
      ];
      const fillAction = toPlanAction(messageField, 'fill', 1, prompts[missionState.counters.chatTurns % prompts.length]);
      if (fillAction) {
        actions.push(fillAction);
      }

      const sendAction = pickAction(interactions, ['send', 'ask', 'submit'], ['send', 'submit']);
      const send = toPlanAction(sendAction, 'submit', 1);
      if (send) {
        actions.push(send);
      }

      notes.push('chat-turn');
      missionState.lastPhase = 'chat';
    }
  }

  const repeatedLabels = safeArray(recentEvents).slice(-6).map((event) => norm(event.actionLabel || ''));
  const repeatedLoop = repeatedLabels.length >= 4 && new Set(repeatedLabels).size <= 2;
  if (repeatedLoop || missionState.counters.branchExplores < missionState.goals.branchExplorationTarget) {
    const branch = pickAction(interactions, ['more', 'options', 'menu', 'ellipsis', 'tab', 'filter', 'search'], ['menu', 'tab', 'filter']);
    const branchAction = toPlanAction(branch, hasKeyword(textOf(branch), ['menu', 'options', 'ellipsis']) ? 'open-menu' : 'click', 1);
    if (branchAction) {
      actions.push(branchAction);
      notes.push('branch-explore');
      missionState.lastPhase = 'branch';
    }
  }

  return {
    actions: actions.filter(Boolean),
    notes,
    signals: screenSignals
  };
}

export function updateMissionStateFromEvent(missionState, event) {
  const label = norm(`${event?.actionLabel || ''} ${event?.entity || ''}`);

  if (/add|create|new|insert|plus/.test(label)) {
    missionState.counters.createActions += 1;
  }
  if (/next|continue|proceed|step|wizard/.test(label)) {
    missionState.counters.wizardAdvances += 1;
  }
  if (/select|choose|pick|filter/.test(label)) {
    missionState.counters.selectionActions += 1;
  }
  if (/chat|message|assistant|send|ask|prompt/.test(label)) {
    missionState.counters.chatTurns += 1;
  }
  if (/menu|options|tab|filter|search|branch/.test(label)) {
    missionState.counters.branchExplores += 1;
  }

  if (
    missionState.counters.createActions >= missionState.goals.repeatableCreateTarget &&
    !missionState.completedGoals.includes('repeatableCreateTarget')
  ) {
    missionState.completedGoals.push('repeatableCreateTarget');
  }
  if (
    missionState.counters.chatTurns >= missionState.goals.chatTurnsTarget &&
    !missionState.completedGoals.includes('chatTurnsTarget')
  ) {
    missionState.completedGoals.push('chatTurnsTarget');
  }
  if (
    missionState.counters.branchExplores >= missionState.goals.branchExplorationTarget &&
    !missionState.completedGoals.includes('branchExplorationTarget')
  ) {
    missionState.completedGoals.push('branchExplorationTarget');
  }

  return missionState;
}

export function missionProgressSummary(missionState) {
  const goals = missionState.goals;
  const counters = missionState.counters;

  const progressPoints = [
    Math.min(1, counters.createActions / Math.max(1, goals.repeatableCreateTarget)),
    Math.min(1, counters.chatTurns / Math.max(1, goals.chatTurnsTarget)),
    Math.min(1, counters.branchExplores / Math.max(1, goals.branchExplorationTarget))
  ];

  const progressPct = Number(((progressPoints.reduce((sum, value) => sum + value, 0) / progressPoints.length) * 100).toFixed(2));

  return {
    progressPct,
    counters,
    goals,
    completedGoals: safeArray(missionState.completedGoals),
    signals: missionState.signals,
    lastPhase: missionState.lastPhase
  };
}
