import { nowIso, safeArray, normalizeText } from './fs-utils.mjs';

function scoreJourney(journey) {
  const requiredWeight = safeArray(journey.requiredEntities).length * 3;
  const producedWeight = safeArray(journey.producedEntities).length * 4;
  const stepWeight = safeArray(journey.steps).length;
  const destructiveWeight = safeArray(journey.steps).filter((step) => step.destructiveHint).length * 2;
  const gateWeight = Number(journey.gatesSatisfied || 0) * 4;
  const milestoneWeight = Number(journey.milestonesCompleted || 0) * 2;
  const statusWeight =
    journey.status === 'completed'
      ? 3
      : journey.status === 'degraded_planning'
        ? 1
        : journey.status === 'failed'
          ? -2
          : journey.status === 'blocked'
            ? -1
            : 0;

  return requiredWeight + producedWeight + stepWeight + destructiveWeight + gateWeight + milestoneWeight + statusWeight;
}

export function buildCriticalPaths(journeys, options = {}) {
  const maxItems = options.maxItems ?? 12;
  const entries = safeArray(journeys)
    .map((journey) => ({
      journeyId: journey.id,
      name: journey.name,
      intent: journey.intent,
      entity: journey.entity,
      status: journey.status,
      requiredEntities: safeArray(journey.requiredEntities),
      producedEntities: safeArray(journey.producedEntities),
      stepCount: safeArray(journey.steps).length,
      milestonesCompleted: Number(journey.milestonesCompleted || 0),
      gatesSatisfied: Number(journey.gatesSatisfied || 0),
      blockedReason: journey.blockedReason || '',
      score: scoreJourney(journey)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems);

  return {
    version: 1,
    generatedAt: nowIso(),
    entries
  };
}

function normalizeStep(step) {
  return {
    navigateTo: step.fromUrlTemplate || step.fromUrl,
    action: {
      selector: step.selector,
      label: step.label,
      destructive: Boolean(step.destructiveHint)
    }
  };
}

export function buildE2ESpecs(journeys, entityRegistry, options = {}) {
  const includeStatuses = new Set(options.includeStatuses || ['completed', 'discovered', 'degraded_planning']);

  const specs = safeArray(journeys)
    .filter((journey) => includeStatuses.has(journey.status || 'discovered'))
    .map((journey) => ({
      id: `e2e-${journey.id}`,
      title: journey.name,
      journeyId: journey.id,
      intent: journey.intent,
      entity: journey.entity,
      preconditions: {
        requiredEntities: safeArray(journey.requiredEntities),
        satisfiedEntities: safeArray(journey.requiredEntities).filter((key) => entityRegistry?.latestValues?.[key]),
        setupActions: [
          Number(journey.gatesSatisfied || 0) > 0
            ? `Satisfy ${journey.gatesSatisfied} gate prerequisite(s) before final CTA.`
            : null,
          journey.blockedReason && String(journey.blockedReason).startsWith('missing_entities:')
            ? `Create prerequisite entities: ${String(journey.blockedReason).replace('missing_entities:', '')}`
            : null
        ].filter(Boolean)
      },
      steps: safeArray(journey.steps).map(normalizeStep),
      assertions: [
        {
          type: 'url_or_state_change',
          description: 'After each action, route or page state should change as expected.'
        },
        {
          type: 'unlock_assertion',
          description:
            Number(journey.gatesSatisfied || 0) > 0
              ? `Verify locked actions become enabled after satisfying ${journey.gatesSatisfied} prerequisite gate(s).`
              : 'Verify final call-to-action is enabled before completion.'
        },
        {
          type: 'repeat_count_assertion',
          description:
            Number(journey.milestonesCompleted || 0) > 0
              ? `Verify repeated progression actions can be performed through ${journey.milestonesCompleted} milestone(s).`
              : 'Verify repeated actions do not silently no-op.'
        }
      ]
    }));

  return {
    version: 1,
    generatedAt: nowIso(),
    specs
  };
}

export function buildSmokeSuite(e2eSpecs, criticalPaths, options = {}) {
  const maxCases = options.maxCases ?? 10;
  const preferredJourneyIds = new Set(
    safeArray(criticalPaths?.entries)
      .slice(0, maxCases)
      .map((entry) => entry.journeyId)
  );

  const cases = safeArray(e2eSpecs?.specs)
    .filter((spec) => preferredJourneyIds.has(spec.journeyId))
    .slice(0, maxCases)
    .map((spec) => ({
      id: `smoke-${spec.journeyId}`,
      e2eSpecId: spec.id,
      title: spec.title,
      mode: 'happy-path',
      stepCount: safeArray(spec.steps).length
    }));

  return {
    version: 1,
    generatedAt: nowIso(),
    cases
  };
}

export function buildCopyIssueHints(copyInventory, options = {}) {
  const entries = safeArray(copyInventory?.entries);
  const maxHints = options.maxHints ?? 200;

  const hints = [];

  for (const entry of entries) {
    const text = String(entry.text || '').trim();
    if (!text) {
      continue;
    }

    if (/\b(undefined|null|nan)\b/i.test(text)) {
      hints.push({
        kind: 'runtime-placeholder-leak',
        text,
        url: entry.url,
        context: entry.context || ''
      });
    }

    if (/\s{2,}/.test(text)) {
      hints.push({
        kind: 'double-spacing',
        text,
        url: entry.url,
        context: entry.context || ''
      });
    }

    if (/[A-Z]{4,}/.test(text) && text.length > 12) {
      hints.push({
        kind: 'readability-tone',
        text,
        url: entry.url,
        context: entry.context || ''
      });
    }

    if (/(at least|minimum|required|remaining|left|step\\s+\\d+\\s+of\\s+\\d+)/i.test(text)) {
      hints.push({
        kind: 'gate-copy-friction',
        text,
        url: entry.url,
        context: entry.context || ''
      });
    }

    if (hints.length >= maxHints) {
      break;
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const hint of hints) {
    const key = normalizeText(`${hint.kind}|${hint.url}|${hint.text}`);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(hint);
  }

  return {
    version: 1,
    generatedAt: nowIso(),
    hints: deduped
  };
}
