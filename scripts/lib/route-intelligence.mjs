import { normalizeText, safeArray, nowIso } from './fs-utils.mjs';

const ID_KEY_REGEX = /(id|uuid|token|hash|code)$/i;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_LONG_REGEX = /^[0-9a-f]{16,}$/i;
const BASE64ISH_REGEX = /^[A-Za-z0-9_-]{14,}$/;

function singularize(word) {
  const normalized = normalizeText(word).replace(/[^a-z0-9]/g, '');
  if (!normalized) {
    return 'entity';
  }
  if (normalized.endsWith('ies')) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (normalized.endsWith('s') && !normalized.endsWith('ss')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

export function isLikelyIdKey(key = '') {
  return ID_KEY_REGEX.test(String(key));
}

export function isLikelyIdValue(value = '') {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }
  if (UUID_REGEX.test(text)) {
    return true;
  }
  if (/^[0-9]{6,}$/.test(text)) {
    return true;
  }
  if (HEX_LONG_REGEX.test(text)) {
    return true;
  }
  if (BASE64ISH_REGEX.test(text) && /[A-Za-z]/.test(text) && /[0-9]/.test(text)) {
    return true;
  }
  return false;
}

function inferEntityKeyFromPath(parts, index) {
  const prev = parts[index - 1] || 'entity';
  const singular = singularize(prev.replace(/[^a-zA-Z0-9]/g, ''));
  return `${singular}Id`;
}

export function extractEntityValuesFromUrl(rawUrl) {
  const found = {};
  if (!rawUrl) {
    return found;
  }

  try {
    const parsed = new URL(rawUrl);

    for (const [key, value] of parsed.searchParams.entries()) {
      if (isLikelyIdKey(key) || isLikelyIdValue(value)) {
        found[key] = value;
      }
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!isLikelyIdValue(part)) {
        continue;
      }
      const key = inferEntityKeyFromPath(parts, i);
      found[key] = part;
    }
  } catch {
    return found;
  }

  return found;
}

function extractEntityValuesFromObjectInternal(input, output, depth, maxDepth) {
  if (depth > maxDepth) {
    return;
  }

  if (Array.isArray(input)) {
    for (const item of input.slice(0, 30)) {
      extractEntityValuesFromObjectInternal(item, output, depth + 1, maxDepth);
    }
    return;
  }

  if (!input || typeof input !== 'object') {
    return;
  }

  for (const [key, value] of Object.entries(input)) {
    if (value == null) {
      continue;
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const valueStr = String(value).trim();
      if (!valueStr) {
        continue;
      }

      if (isLikelyIdKey(key) || isLikelyIdValue(valueStr)) {
        output[String(key)] = valueStr;
      }
      continue;
    }

    extractEntityValuesFromObjectInternal(value, output, depth + 1, maxDepth);
  }
}

export function extractEntityValuesFromObject(input, options = {}) {
  const maxDepth = options.maxDepth ?? 5;
  const output = {};
  extractEntityValuesFromObjectInternal(input, output, 0, maxDepth);
  return output;
}

function valueTemplateForKey(key) {
  return `:${key}`;
}

export function routeTemplateFromUrl(rawUrl) {
  if (!rawUrl) {
    return { template: '', requiredEntities: [], route: '' };
  }

  try {
    const parsed = new URL(rawUrl);
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    const templatedPath = pathParts.map((part, index) => {
      if (!isLikelyIdValue(part)) {
        return part;
      }
      const key = inferEntityKeyFromPath(pathParts, index);
      return valueTemplateForKey(key);
    });

    const requiredEntities = new Set();
    const queryParts = [];

    for (const [key, value] of parsed.searchParams.entries()) {
      if (isLikelyIdKey(key) || isLikelyIdValue(value)) {
        requiredEntities.add(key);
        queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(valueTemplateForKey(key))}`);
      } else {
        queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
    }

    const pathString = `/${templatedPath.join('/')}`;
    const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

    return {
      template: `${pathString}${queryString}`,
      requiredEntities: Array.from(requiredEntities).sort(),
      route: `${parsed.pathname}${parsed.search}`
    };
  } catch {
    return {
      template: rawUrl,
      requiredEntities: [],
      route: rawUrl
    };
  }
}

export function resolveTemplateUrl(templateUrl, entityRegistry) {
  if (!templateUrl) {
    return { resolvedUrl: templateUrl, missingEntities: [] };
  }

  const latest = entityRegistry?.latestValues || {};
  const missing = [];

  const resolved = String(templateUrl).replace(/:([a-zA-Z][a-zA-Z0-9_]*)/g, (_, key) => {
    const value = latest[key];
    if (value == null || value === '') {
      missing.push(key);
      return `:${key}`;
    }
    return encodeURIComponent(String(value));
  });

  return {
    resolvedUrl: resolved,
    missingEntities: Array.from(new Set(missing))
  };
}

export function createEntityRegistry(seed = {}) {
  return {
    version: 1,
    latestValues: {},
    entities: {},
    observedAt: nowIso(),
    ...seed
  };
}

export function upsertEntityValues(registryInput, values, metadata = {}) {
  const registry = createEntityRegistry(registryInput);
  const source = metadata.source || 'unknown';

  for (const [key, valueRaw] of Object.entries(values || {})) {
    const value = String(valueRaw || '').trim();
    if (!value) {
      continue;
    }

    if (!registry.entities[key]) {
      registry.entities[key] = {
        values: [],
        sources: [],
        updatedAt: nowIso()
      };
    }

    const entity = registry.entities[key];
    if (!entity.values.includes(value)) {
      entity.values.push(value);
    }
    if (!entity.sources.includes(source)) {
      entity.sources.push(source);
    }

    registry.latestValues[key] = value;
    entity.updatedAt = nowIso();
  }

  registry.observedAt = nowIso();
  return registry;
}

export function createRouteUniverse(seed = {}) {
  return {
    version: 1,
    routes: {},
    observedAt: nowIso(),
    ...seed
  };
}

export function upsertRouteObservation(universeInput, rawUrl, metadata = {}) {
  const universe = createRouteUniverse(universeInput);
  const derived = routeTemplateFromUrl(rawUrl);
  const key = derived.template || derived.route;

  if (!key) {
    return universe;
  }

  if (!universe.routes[key]) {
    universe.routes[key] = {
      template: key,
      routeSamples: [],
      requiredEntities: derived.requiredEntities || [],
      contexts: [],
      states: {},
      firstSeenAt: nowIso(),
      lastSeenAt: nowIso(),
      visits: 0
    };
  }

  const routeEntry = universe.routes[key];
  routeEntry.visits += 1;
  routeEntry.lastSeenAt = nowIso();

  const sampleRoute = derived.route || rawUrl;
  if (sampleRoute && !routeEntry.routeSamples.includes(sampleRoute) && routeEntry.routeSamples.length < 20) {
    routeEntry.routeSamples.push(sampleRoute);
  }

  for (const required of safeArray(derived.requiredEntities)) {
    if (!routeEntry.requiredEntities.includes(required)) {
      routeEntry.requiredEntities.push(required);
    }
  }

  const context = metadata.context || 'unknown';
  if (!routeEntry.contexts.includes(context)) {
    routeEntry.contexts.push(context);
  }

  const state = metadata.state || 'discovered';
  routeEntry.states[state] = (routeEntry.states[state] || 0) + 1;

  universe.observedAt = nowIso();
  return universe;
}

export function markRouteState(universeInput, template, state, metadata = {}) {
  const universe = createRouteUniverse(universeInput);
  if (!template || !universe.routes[template]) {
    return universe;
  }

  const route = universe.routes[template];
  route.states[state] = (route.states[state] || 0) + 1;
  route.lastSeenAt = nowIso();

  if (metadata.context && !route.contexts.includes(metadata.context)) {
    route.contexts.push(metadata.context);
  }

  universe.observedAt = nowIso();
  return universe;
}

export function buildRouteCoverage(universeInput) {
  const universe = createRouteUniverse(universeInput);
  const routes = Object.values(universe.routes || {});

  const total = routes.length;
  const covered = routes.filter((route) => {
    const states = route.states || {};
    return states.visited || states.executed || states.blocked_precondition || states.guarded || states.forbidden;
  }).length;

  const blocked = routes.filter((route) => (route.states?.blocked_precondition || 0) > 0).length;
  const executed = routes.filter((route) => (route.states?.executed || 0) > 0 || (route.states?.visited || 0) > 0).length;

  return {
    totalRoutes: total,
    coveredRoutes: covered,
    blockedRoutes: blocked,
    executedRoutes: executed,
    coveragePct: total === 0 ? 0 : Number(((covered / total) * 100).toFixed(2))
  };
}

export function createCopyInventory(seed = {}) {
  return {
    version: 1,
    entries: [],
    observedAt: nowIso(),
    ...seed
  };
}

export function addCopyEntry(copyInventoryInput, entry) {
  const inventory = createCopyInventory(copyInventoryInput);
  const normalizedKey = normalizeText(`${entry.url}|${entry.text}|${entry.context || ''}`);

  const exists = inventory.entries.some((item) => item.key === normalizedKey);
  if (!exists) {
    inventory.entries.push({
      key: normalizedKey,
      ...entry,
      observedAt: nowIso()
    });
  }

  inventory.observedAt = nowIso();
  return inventory;
}

export function buildJourneyDependencyGraph(journeys, routeUniverse, entityRegistry) {
  const nodes = safeArray(journeys).map((journey) => ({
    id: journey.id,
    name: journey.name,
    intent: journey.intent,
    entity: journey.entity,
    requiredEntities: safeArray(journey.requiredEntities),
    producedEntities: safeArray(journey.producedEntities),
    status: journey.status || 'discovered'
  }));

  const edges = [];
  const producers = {};

  for (const node of nodes) {
    for (const produced of node.producedEntities) {
      if (!producers[produced]) {
        producers[produced] = [];
      }
      producers[produced].push(node.id);
    }
  }

  for (const node of nodes) {
    for (const required of node.requiredEntities) {
      for (const producerId of safeArray(producers[required])) {
        if (producerId === node.id) {
          continue;
        }
        edges.push({
          from: producerId,
          to: node.id,
          entity: required
        });
      }
    }
  }

  const unresolvedEntities = [];
  for (const route of Object.values(createRouteUniverse(routeUniverse).routes || {})) {
    for (const key of safeArray(route.requiredEntities)) {
      if (entityRegistry?.latestValues?.[key]) {
        continue;
      }
      unresolvedEntities.push({ entity: key, routeTemplate: route.template });
    }
  }

  return {
    version: 1,
    generatedAt: nowIso(),
    nodes,
    edges,
    unresolvedEntities
  };
}
