import { deriveCapabilityExpectations } from './semantic-learner.mjs';

export function buildExpectedVsFoundReport(knowledgeBase, options = {}) {
  const entityExpectations = deriveCapabilityExpectations(knowledgeBase, options);

  const entities = Object.entries(entityExpectations).map(([entity, value]) => ({
    entity,
    ...value
  }));

  const missing = entities
    .filter((entry) => entry.missing.length > 0)
    .map((entry) => ({ entity: entry.entity, missing: entry.missing }));

  const overallCoverage =
    entities.length === 0
      ? 100
      : Number(
          (
            entities.reduce((sum, entry) => sum + (entry.coveragePct || 0), 0) /
            Math.max(1, entities.length)
          ).toFixed(2)
        );

  return {
    generatedAt: new Date().toISOString(),
    overallCoveragePct: overallCoverage,
    entityCount: entities.length,
    entities,
    missing
  };
}

export function buildCoverageFrontier(payload = {}) {
  const journeys = payload.journeys || [];
  const features = payload.features || [];
  const expectedVsFound = payload.expectedVsFound || { overallCoveragePct: 0, missing: [] };

  const completedJourneys = journeys.filter((journey) => journey.status === 'completed').length;

  return {
    generatedAt: new Date().toISOString(),
    journeys: {
      total: journeys.length,
      completed: completedJourneys,
      completionPct: journeys.length
        ? Number(((completedJourneys / journeys.length) * 100).toFixed(2))
        : 0
    },
    features: {
      total: features.length,
      uniqueRoutes: Array.from(new Set(features.map((feature) => feature.route))).length
    },
    expectations: {
      coveragePct: expectedVsFound.overallCoveragePct || 0,
      missingCount: (expectedVsFound.missing || []).length,
      missing: expectedVsFound.missing || []
    }
  };
}
