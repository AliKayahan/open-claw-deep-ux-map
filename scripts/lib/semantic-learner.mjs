import { normalizeText, safeArray } from './fs-utils.mjs';

const VERB_PATTERNS = [
  { verb: 'register', regex: /\b(sign up|register|create account|join)\b/i },
  { verb: 'login', regex: /\b(sign in|log in|login|continue)\b/i },
  { verb: 'logout', regex: /\b(log out|logout|sign out)\b/i },
  { verb: 'forgot_password', regex: /\b(forgot password|reset password|recover account)\b/i },
  { verb: 'verify', regex: /\b(verify|confirmation code|otp|two-factor|2fa)\b/i },
  { verb: 'create', regex: /\b(create|new|add|submit|publish|save)\b/i },
  { verb: 'view', regex: /\b(view|open|details|show|preview)\b/i },
  { verb: 'update', regex: /\b(edit|update|rename|change|modify)\b/i },
  { verb: 'delete', regex: /\b(delete|remove|trash|discard|archive)\b/i },
  { verb: 'invite', regex: /\b(invite|add member|share)\b/i },
  { verb: 'export', regex: /\b(export|download|save as)\b/i },
  { verb: 'filter', regex: /\b(filter|sort|search|refine)\b/i },
  { verb: 'navigate', regex: /\b(menu|tab|next|back|home|dashboard|settings|profile)\b/i }
];

const ENTITY_FROM_VERB_PHRASE = /\b(?:create|new|add|edit|update|delete|remove|invite|open|view|manage|save)\s+([a-z][a-z0-9\- ]{1,30})\b/i;
const ENTITY_ROUTE_SKIP = new Set(['app', 'dashboard', 'home', 'settings', 'new', 'edit', 'create', 'account']);

function singularize(word) {
  const normalized = normalizeText(word).replace(/[^a-z0-9\- ]/g, '').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.endsWith('ies')) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (normalized.endsWith('ses')) {
    return normalized.slice(0, -2);
  }
  if (normalized.endsWith('s') && !normalized.endsWith('ss')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function firstMeaningfulNoun(phrases = []) {
  for (const phrase of phrases) {
    const normalized = normalizeText(phrase);
    if (!normalized) {
      continue;
    }

    const match = normalized.match(ENTITY_FROM_VERB_PHRASE);
    if (match?.[1]) {
      const candidate = singularize(match[1].split(' ').slice(0, 3).join(' '));
      if (candidate && !ENTITY_ROUTE_SKIP.has(candidate)) {
        return candidate;
      }
    }

    const tokens = normalized.split(' ').filter(Boolean);
    for (const token of tokens) {
      if (token.length < 3 || ENTITY_ROUTE_SKIP.has(token)) {
        continue;
      }
      return singularize(token);
    }
  }

  return '';
}

function inferEntityFromUrl(url = '') {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname
      .split('/')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .filter((item) => !/^\d+$/.test(item));

    for (const part of parts.reverse()) {
      if (ENTITY_ROUTE_SKIP.has(part) || part.length < 3) {
        continue;
      }
      return singularize(part.replace(/[^a-z0-9\-]/g, ''));
    }
  } catch {
    return '';
  }
  return '';
}

function inferVerbFromText(text) {
  for (const { verb, regex } of VERB_PATTERNS) {
    if (regex.test(text)) {
      return verb;
    }
  }
  return 'unknown';
}

export function classifyAction(action, state, options = {}) {
  const texts = [
    action?.text,
    action?.ariaLabel,
    action?.title,
    action?.placeholder,
    action?.value,
    action?.contextText,
    state?.title,
    state?.headline,
    state?.url
  ].filter(Boolean);

  const combined = normalizeText(texts.join(' | '));
  const inferredVerb = inferVerbFromText(combined);
  const entity = firstMeaningfulNoun(texts) || inferEntityFromUrl(state?.url) || 'generic-item';

  let confidence = 0.25;
  if (inferredVerb !== 'unknown') {
    confidence += 0.35;
  }
  if (entity && entity !== 'generic-item') {
    confidence += 0.2;
  }
  if (action?.href) {
    confidence += 0.05;
  }
  if (safeArray(options.networkMutations).length > 0) {
    confidence += 0.15;
  }

  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

  return {
    verb: inferredVerb,
    entity,
    confidence,
    label: action?.text || action?.ariaLabel || action?.title || action?.selector || 'unnamed-action',
    destructiveHint:
      inferredVerb === 'delete' || /\b(delete|remove|trash|archive|discard)\b/i.test(combined),
    evidence: {
      url: state?.url || '',
      action: {
        selector: action?.selector,
        text: action?.text,
        ariaLabel: action?.ariaLabel,
        iconHint: action?.iconHint
      }
    }
  };
}

export function createKnowledgeBase(seed = {}) {
  const knowledge = {
    entities: {},
    actionCount: 0,
    lastUpdatedAt: null,
    ...seed
  };

  if (!knowledge.entities || typeof knowledge.entities !== 'object') {
    knowledge.entities = {};
  }

  return knowledge;
}

export function updateKnowledgeBase(knowledgeBase, classification, metadata = {}) {
  const knowledge = createKnowledgeBase(knowledgeBase);
  const entityKey = classification.entity || 'generic-item';

  if (!knowledge.entities[entityKey]) {
    knowledge.entities[entityKey] = {
      observedVerbs: {},
      samples: [],
      urls: []
    };
  }

  const entry = knowledge.entities[entityKey];
  entry.observedVerbs[classification.verb] = (entry.observedVerbs[classification.verb] || 0) + 1;

  if (classification.label && entry.samples.length < 30) {
    entry.samples.push({
      label: classification.label,
      verb: classification.verb,
      confidence: classification.confidence
    });
  }

  if (metadata.url && entry.urls.length < 30 && !entry.urls.includes(metadata.url)) {
    entry.urls.push(metadata.url);
  }

  knowledge.actionCount += 1;
  knowledge.lastUpdatedAt = new Date().toISOString();

  return knowledge;
}

const DEFAULT_EXPECTATION_RULES = {
  register: ['login', 'forgot_password', 'update', 'delete'],
  login: ['logout', 'forgot_password', 'update'],
  create: ['view', 'update', 'delete'],
  update: ['view'],
  delete: ['view'],
  invite: ['update', 'delete'],
  export: ['view']
};

export function deriveCapabilityExpectations(knowledgeBase, options = {}) {
  const rules = {
    ...DEFAULT_EXPECTATION_RULES,
    ...(options.rules || {})
  };

  const output = {};

  for (const [entity, data] of Object.entries(createKnowledgeBase(knowledgeBase).entities)) {
    const observed = new Set(Object.keys(data.observedVerbs || {}));
    const expected = new Set(observed);

    for (const verb of observed) {
      for (const sibling of safeArray(rules[verb])) {
        expected.add(sibling);
      }
    }

    output[entity] = {
      observed: Array.from(observed).sort(),
      expected: Array.from(expected).sort(),
      missing: Array.from(expected).filter((verb) => !observed.has(verb)).sort(),
      coveragePct:
        expected.size === 0
          ? 100
          : Number(((observed.size / expected.size) * 100).toFixed(2))
    };
  }

  return output;
}

export function buildJourneyName(verb, entity) {
  const readableVerb = verb.replace(/_/g, ' ');
  return `${readableVerb} ${entity}`
    .replace(/\s+/g, ' ')
    .trim();
}
