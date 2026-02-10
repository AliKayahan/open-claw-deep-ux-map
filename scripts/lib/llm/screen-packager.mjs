import { normalizeText, safeArray } from '../fs-utils.mjs';

function trimText(value, limit = 320) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export async function extractScreenDiagnostics(page) {
  return page.evaluate(() => {
    const pickText = (node) => {
      if (!node) {
        return '';
      }
      return (node.textContent || '').replace(/\s+/g, ' ').trim();
    };

    const disabledControls = Array.from(
      document.querySelectorAll(
        'button[disabled], [role="button"][aria-disabled="true"], input[disabled], select[disabled], textarea[disabled]'
      )
    )
      .map((node) => {
        const label = pickText(node) || node.getAttribute('aria-label') || node.getAttribute('title') || '';
        const helper = pickText(node.closest('form, section, article, div')?.querySelector('small, .help, .hint, [role="note"]'));

        return {
          label: label.slice(0, 180),
          helper: helper.slice(0, 220),
          tagName: node.tagName.toLowerCase(),
          type: node.getAttribute('type') || ''
        };
      })
      .filter((entry) => entry.label || entry.helper)
      .slice(0, 40);

    const progressHints = Array.from(
      document.querySelectorAll('[aria-valuenow], progress, [role="progressbar"], [data-step], [class*="step"]')
    )
      .map((node) => {
        const text = pickText(node);
        const valueNow = node.getAttribute('aria-valuenow') || '';
        const valueMax = node.getAttribute('aria-valuemax') || '';
        const dataStep = node.getAttribute('data-step') || '';
        return {
          text: text.slice(0, 180),
          valueNow,
          valueMax,
          dataStep
        };
      })
      .filter((entry) => entry.text || entry.valueNow || entry.dataStep)
      .slice(0, 30);

    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);

    return {
      disabledControls,
      progressHints,
      bodyText
    };
  });
}

export function buildScreenContext(input = {}) {
  const interactions = safeArray(input.interactions).slice(0, 80).map((item) => ({
    selector: item.selector,
    tagName: item.tagName,
    type: item.type,
    role: item.role,
    text: trimText(item.text, 120),
    ariaLabel: trimText(item.ariaLabel, 120),
    title: trimText(item.title, 120),
    placeholder: trimText(item.placeholder, 120),
    iconHint: trimText(item.iconHint, 120),
    contextText: trimText(item.contextText, 120),
    href: trimText(item.href, 180)
  }));

  const diagnostics = input.diagnostics || {};
  const state = input.state || {};

  const context = {
    url: state.url || '',
    routeTemplate: input.routeTemplate || '',
    title: trimText(state.title, 180),
    headline: trimText(state.headline, 220),
    modalTitles: safeArray(state.modalTitles).slice(0, 8),
    textSample: trimText(state.textSample, 1200),
    disabledControls: safeArray(diagnostics.disabledControls).slice(0, 30),
    progressHints: safeArray(diagnostics.progressHints).slice(0, 20),
    entityRegistry: input.entityRegistry?.latestValues || {},
    interactions,
    recentEvents: safeArray(input.recentEvents).slice(-8),
    journey: input.journey
      ? {
          id: input.journey.id,
          name: input.journey.name,
          intent: input.journey.intent,
          entity: input.journey.entity,
          stepCount: safeArray(input.journey.steps).length
        }
      : null
  };

  context.screenDigest = normalizeText(
    `${context.title} | ${context.headline} | ${context.url} | ${context.textSample.slice(0, 300)}`
  );

  return context;
}
