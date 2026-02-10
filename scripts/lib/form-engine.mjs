import { inputSampleFor } from './page-utils.mjs';
import { normalizeText, safeArray } from './fs-utils.mjs';

function coerceString(value, fallback = '') {
  if (value == null) {
    return fallback;
  }
  return String(value);
}

function fallbackValue(field, index = 0) {
  const syntheticAction = {
    placeholder: field.placeholder,
    ariaLabel: field.label,
    text: field.label,
    type: field.type,
    tagName: field.tagName
  };

  const base = inputSampleFor(syntheticAction);
  const label = normalizeText(`${field.label} ${field.placeholder}`);

  if (/date/.test(field.type) || /date/.test(label)) {
    return '2026-01-15';
  }
  if (/number|qty|quantity|count/.test(field.type) || /number|qty|quantity|count/.test(label)) {
    return String(5 + index);
  }
  if (/url|website/.test(label)) {
    return `https://example.com/item-${index + 1}`;
  }

  return `${base}-${index + 1}`;
}

export async function collectFormCandidates(page, options = {}) {
  const maxForms = options.maxForms ?? 5;

  return page.evaluate((max) => {
    const SELECTOR = 'input, textarea, select';

    const toCssPath = (node) => {
      if (!(node instanceof Element)) {
        return '';
      }
      if (node.id && !/^\d/.test(node.id)) {
        return `#${CSS.escape(node.id)}`;
      }

      const parts = [];
      let current = node;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        let segment = current.tagName.toLowerCase();
        const classes = Array.from(current.classList || []).filter(Boolean).slice(0, 2);
        if (classes.length > 0) {
          segment += `.${classes.map((item) => CSS.escape(item)).join('.')}`;
        }

        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter((candidate) => candidate.tagName === current.tagName)
          : [];
        if (siblings.length > 1) {
          segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }

        parts.unshift(segment);
        current = current.parentElement;
        if (parts.length >= 6) {
          break;
        }
      }

      return parts.join(' > ');
    };

    const visible = (node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 4 && rect.height > 4;
    };

    const getFieldLabel = (field) => {
      const id = field.getAttribute('id');
      if (id) {
        const byFor = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (byFor?.textContent?.trim()) {
          return byFor.textContent.trim();
        }
      }

      const parentLabel = field.closest('label');
      if (parentLabel?.textContent?.trim()) {
        return parentLabel.textContent.trim();
      }

      const aria = field.getAttribute('aria-label');
      if (aria) {
        return aria;
      }

      return '';
    };

    const containers = Array.from(document.querySelectorAll('form, [role="form"], section, article, div'));
    const candidates = [];

    for (const container of containers) {
      const fields = Array.from(container.querySelectorAll(SELECTOR)).filter((field) => {
        if (!visible(field)) {
          return false;
        }

        const type = (field.getAttribute('type') || '').toLowerCase();
        if (['hidden', 'button', 'submit', 'reset', 'file', 'image'].includes(type)) {
          return false;
        }

        if (field.hasAttribute('disabled') || field.getAttribute('aria-disabled') === 'true') {
          return false;
        }

        return true;
      });

      if (fields.length === 0) {
        continue;
      }

      const submit = container.querySelector('button[type="submit"], input[type="submit"], button:not([disabled])');
      const formSelector = toCssPath(container);
      if (!formSelector) {
        continue;
      }

      const payload = {
        formSelector,
        fieldCount: fields.length,
        submitSelector: submit ? toCssPath(submit) : '',
        fields: fields.slice(0, 30).map((field) => ({
          selector: toCssPath(field),
          tagName: field.tagName.toLowerCase(),
          type: (field.getAttribute('type') || '').toLowerCase(),
          name: field.getAttribute('name') || '',
          label: getFieldLabel(field).slice(0, 160),
          placeholder: (field.getAttribute('placeholder') || '').slice(0, 160),
          required: field.hasAttribute('required') || field.getAttribute('aria-required') === 'true'
        }))
      };

      candidates.push(payload);
      if (candidates.length >= max) {
        break;
      }
    }

    const unique = new Map();
    for (const candidate of candidates) {
      const key = `${candidate.formSelector}|${candidate.fieldCount}`;
      if (!unique.has(key)) {
        unique.set(key, candidate);
      }
    }

    return Array.from(unique.values());
  }, maxForms);
}

export function chooseFormCandidate(forms = []) {
  const candidates = safeArray(forms)
    .filter((item) => item.fieldCount > 0)
    .sort((a, b) => {
      const aRequired = safeArray(a.fields).filter((field) => field.required).length;
      const bRequired = safeArray(b.fields).filter((field) => field.required).length;
      if (bRequired !== aRequired) {
        return bRequired - aRequired;
      }
      return b.fieldCount - a.fieldCount;
    });

  return candidates[0] || null;
}

export function buildFormPromptContext(form, screenContext) {
  return {
    screen: {
      url: screenContext.url,
      title: screenContext.title,
      headline: screenContext.headline
    },
    form: {
      formSelector: form.formSelector,
      fieldCount: form.fieldCount,
      fields: safeArray(form.fields).map((field) => ({
        key: field.name || field.selector,
        name: field.name,
        tagName: field.tagName,
        type: field.type,
        label: field.label,
        placeholder: field.placeholder,
        required: field.required
      }))
    }
  };
}

export async function executeFormEpisode(params) {
  const {
    page,
    form,
    plannerClient,
    screenContext,
    config,
    ledgerPath,
    runMeta,
    appendJsonl
  } = params;

  const values = {};
  let llmUsed = false;
  let llmError = null;

  if (plannerClient?.available && config?.forms?.strategy === 'llm-generated') {
    const llmResult = await plannerClient.generateFormValues(buildFormPromptContext(form, screenContext));
    if (llmResult.ok && llmResult.json?.values && typeof llmResult.json.values === 'object') {
      Object.assign(values, llmResult.json.values);
      llmUsed = true;
    } else if (llmResult.error) {
      llmError = llmResult.error;
    }
  }

  const fieldOutcomes = [];
  let filled = 0;

  for (let i = 0; i < safeArray(form.fields).length; i += 1) {
    const field = form.fields[i];
    const key = field.name || field.selector;
    const locator = page.locator(field.selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    let value = values[key];
    if (value == null || value === '') {
      value = fallbackValue(field, i);
      values[key] = value;
    }

    const tag = (field.tagName || '').toLowerCase();
    const type = (field.type || '').toLowerCase();

    try {
      if (tag === 'select') {
        const didSelect = await locator.evaluate((node) => {
          if (!(node instanceof HTMLSelectElement)) {
            return false;
          }
          const option = Array.from(node.options).find((item) => !item.disabled && item.value !== node.value && item.value !== '');
          if (!option) {
            return false;
          }
          node.value = option.value;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        });

        fieldOutcomes.push({ field: key, action: 'select', success: Boolean(didSelect) });
        if (didSelect) {
          filled += 1;
        }
        continue;
      }

      if (type === 'checkbox') {
        await locator.check({ force: true }).catch(async () => {
          await locator.click({ force: true });
        });
        fieldOutcomes.push({ field: key, action: 'check', success: true });
        filled += 1;
        continue;
      }

      if (type === 'radio') {
        await locator.check({ force: true }).catch(async () => {
          await locator.click({ force: true });
        });
        fieldOutcomes.push({ field: key, action: 'radio', success: true });
        filled += 1;
        continue;
      }

      await locator.fill(coerceString(value), { timeout: config.browser.actionTimeoutMs });
      await locator.blur().catch(() => {});
      fieldOutcomes.push({ field: key, action: 'fill', success: true, value: coerceString(value).slice(0, 80) });
      filled += 1;
    } catch (error) {
      fieldOutcomes.push({ field: key, action: 'fill', success: false, error: error.message });
    }
  }

  let submitted = false;
  const submitHeuristics = safeArray(config?.forms?.submitHeuristics);
  for (const heuristic of submitHeuristics) {
    if (submitted) {
      break;
    }

    if (heuristic === 'button') {
      const submitSelector = form.submitSelector || `${form.formSelector} button[type="submit"]`;
      const submit = page.locator(submitSelector).first();
      if (await submit.isVisible().catch(() => false)) {
        await submit.click({ timeout: config.browser.actionTimeoutMs }).catch(() => {});
        submitted = true;
      }
    }

    if (heuristic === 'enter' && !submitted) {
      const firstField = page.locator(safeArray(form.fields)[0]?.selector || '').first();
      if (await firstField.isVisible().catch(() => false)) {
        await firstField.press('Enter').catch(() => {});
        submitted = true;
      }
    }
  }

  const result = {
    ok: filled > 0,
    formSelector: form.formSelector,
    fieldCount: form.fieldCount,
    fieldsFilled: filled,
    submitted,
    llmUsed,
    llmError,
    fieldOutcomes
  };

  appendJsonl(ledgerPath, {
    at: new Date().toISOString(),
    runId: runMeta.runId,
    journeyId: runMeta.journeyId,
    url: screenContext.url,
    result
  });

  return result;
}
