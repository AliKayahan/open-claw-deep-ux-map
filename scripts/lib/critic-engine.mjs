import { normalizeText, safeArray } from './fs-utils.mjs';

function textOf(item) {
  return normalizeText(`${item?.text || ''} ${item?.ariaLabel || ''} ${item?.title || ''} ${item?.contextText || ''}`);
}

function makeAction(item, actionType) {
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
    inputValuePolicy: {
      mode: 'auto',
      value: ''
    },
    repeatPolicy: {
      times: 1,
      max: 1,
      untilCondition: ''
    }
  };
}

export function critiqueScreenProgress(params = {}) {
  const {
    recentEvents = [],
    interactions = [],
    gates = []
  } = params;

  const output = {
    shouldBranch: false,
    blockedHypothesis: '',
    actions: []
  };

  const tail = safeArray(recentEvents).slice(-8);
  const changedCount = tail.filter((event) => event.changed).length;
  const noChangeStreak = tail.length >= 4 && changedCount <= 1;

  if (!noChangeStreak && safeArray(gates).length === 0) {
    return output;
  }

  output.shouldBranch = true;
  output.blockedHypothesis = safeArray(gates).length > 0 ? `gate:${gates[0].gateType}` : 'stalled:no-change';

  const candidates = safeArray(interactions)
    .map((item) => ({ item, text: textOf(item) }))
    .sort((a, b) => {
      const score = (entry) => {
        let value = 0;
        if (/more|options|menu|ellipsis/.test(entry.text)) {
          value += 6;
        }
        if (/tab|filter|sort|search/.test(entry.text)) {
          value += 5;
        }
        if (/next|continue|start|submit/.test(entry.text)) {
          value += 4;
        }
        if (/add|new|create/.test(entry.text)) {
          value += 3;
        }
        return value;
      };
      return score(b) - score(a);
    });

  for (const candidate of candidates.slice(0, 3)) {
    const text = candidate.text;
    const actionType = /menu|options|ellipsis/.test(text)
      ? 'open-menu'
      : /filter|sort/.test(text)
        ? 'select'
        : /next|continue|submit|start/.test(text)
          ? 'next-step'
          : 'click';

    const action = makeAction(candidate.item, actionType);
    if (action) {
      output.actions.push(action);
    }
  }

  return output;
}
