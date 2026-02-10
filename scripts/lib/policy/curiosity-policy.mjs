import { normalizeText, safeArray } from '../fs-utils.mjs';

function actionText(item) {
  return normalizeText(`${item.text || ''} ${item.ariaLabel || ''} ${item.title || ''} ${item.iconHint || ''}`);
}

export function scoreInteraction(item, context = {}) {
  const text = actionText(item);
  let score = 0;

  if (item.tagName === 'input' || item.tagName === 'textarea' || item.tagName === 'select') {
    score += 6;
  }
  if (/add|new|create|submit|save|next|continue|start|compare|generate|search|filter|sort/.test(text)) {
    score += 5;
  }
  if (/menu|more|ellipsis|options/.test(text)) {
    score += 4;
  }
  if (/tab|step|wizard|back|forward/.test(text)) {
    score += 3;
  }
  if (item.href) {
    score += 2;
  }

  if (context.entityHint) {
    const hint = normalizeText(context.entityHint);
    if (hint && text.includes(hint)) {
      score += 3;
    }
  }

  if (context.visitedSignatures?.has(item.key)) {
    score -= 5;
  }

  return score;
}

export function prioritizeInteractions(interactions = [], context = {}) {
  return [...safeArray(interactions)]
    .sort((a, b) => scoreInteraction(b, context) - scoreInteraction(a, context));
}

export function createLoopGuard(config = {}) {
  const maxRepeatedActionCount = Number(config.maxRepeatedActionCount || 4);
  const maxNoopStreak = Number(config.maxNoopStreak || 4);
  const seen = new Map();
  let noopStreak = 0;

  return {
    seen,
    register(actionSignature, changed) {
      const key = actionSignature || 'unknown';
      const nextCount = (seen.get(key) || 0) + 1;
      seen.set(key, nextCount);

      if (changed) {
        noopStreak = 0;
      } else {
        noopStreak += 1;
      }

      return {
        actionCount: nextCount,
        noopStreak,
        shouldStop: nextCount > maxRepeatedActionCount || noopStreak >= maxNoopStreak,
        reason: nextCount > maxRepeatedActionCount ? 'repeated-action-cap' : noopStreak >= maxNoopStreak ? 'noop-streak' : ''
      };
    }
  };
}
