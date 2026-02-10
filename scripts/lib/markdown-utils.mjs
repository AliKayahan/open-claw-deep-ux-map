import { escapeMd } from './fs-utils.mjs';

export function renderJourneyMarkdown(journeys) {
  const header = [
    '# Journey Map',
    '',
    '| id | name | intent | entity | confidence | status | entry |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ];

  const rows = (journeys || []).map((journey) => {
    return `| ${escapeMd(journey.id)} | ${escapeMd(journey.name)} | ${escapeMd(
      journey.intent
    )} | ${escapeMd(journey.entity)} | ${escapeMd(journey.confidence)} | ${escapeMd(
      journey.status
    )} | ${escapeMd(journey.entryUrl)} |`;
  });

  return `${header.concat(rows).join('\n')}\n`;
}

export function renderFeatureMarkdown(features) {
  const header = [
    '# Feature Map',
    '',
    '| id | journey | route | verb | entity | action | outcome |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ];

  const rows = (features || []).map((feature) => {
    return `| ${escapeMd(feature.id)} | ${escapeMd(feature.journeyId)} | ${escapeMd(
      feature.route
    )} | ${escapeMd(feature.verb)} | ${escapeMd(feature.entity)} | ${escapeMd(
      feature.actionLabel
    )} | ${escapeMd(feature.outcome)} |`;
  });

  return `${header.concat(rows).join('\n')}\n`;
}

export function renderExpectedVsFoundMarkdown(report) {
  const lines = ['# Expected vs Found', ''];
  lines.push(`Overall Coverage: ${report.overallCoveragePct ?? 0}%`);
  lines.push('');
  lines.push('| entity | observed | expected | missing | coverage |');
  lines.push('| --- | --- | --- | --- | --- |');

  for (const entry of report.entities || []) {
    lines.push(
      `| ${escapeMd(entry.entity)} | ${escapeMd((entry.observed || []).join(', '))} | ${escapeMd(
        (entry.expected || []).join(', ')
      )} | ${escapeMd((entry.missing || []).join(', '))} | ${escapeMd(`${entry.coveragePct}%`)} |`
    );
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}
