import { normalizeText, slugify } from './fs-utils.mjs';

export function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function sameOrigin(urlA, urlB) {
  try {
    return new URL(urlA).origin === new URL(urlB).origin;
  } catch {
    return false;
  }
}

export async function capturePageState(page) {
  const state = await page.evaluate(() => {
    const pickText = (selector) => {
      const node = document.querySelector(selector);
      return node ? (node.textContent || '').trim() : '';
    };

    const title = document.title || '';
    const headline =
      pickText('h1') || pickText('[role="heading"]') || pickText('h2') || pickText('main');

    const modalTitles = Array.from(
      document.querySelectorAll('[role="dialog"] h1, [role="dialog"] h2, [role="dialog"] [aria-label], .modal h1, .modal h2')
    )
      .map((node) => (node.textContent || node.getAttribute('aria-label') || '').trim())
      .filter(Boolean)
      .slice(0, 4);

    const path = window.location.pathname;
    const search = window.location.search;

    return {
      title,
      headline,
      modalTitles,
      path,
      search,
      textSample: (document.body?.innerText || '').slice(0, 500)
    };
  });

  const url = sanitizeUrl(page.url());
  const fingerprint = normalizeText(`${url}|${state.title}|${state.headline}|${state.modalTitles.join('|')}`);

  return {
    url,
    ...state,
    fingerprint
  };
}

export async function extractInteractiveElements(page, options = {}) {
  const max = options.maxElements ?? 120;

  const items = await page.evaluate((limit) => {
    const SELECTOR = [
      'a[href]',
      'button',
      '[role="button"]',
      '[role="menuitem"]',
      '[role="tab"]',
      'summary',
      'input',
      'select',
      'textarea',
      '[aria-haspopup]'
    ].join(',');

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
        const classes = Array.from(current.classList).filter(Boolean).slice(0, 2);
        if (classes.length > 0) {
          segment += `.${classes.map((c) => CSS.escape(c)).join('.')}`;
        }

        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter(
              (child) => child.tagName === current.tagName
            )
          : [];

        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          segment += `:nth-of-type(${index})`;
        }

        parts.unshift(segment);
        current = current.parentElement;
        if (parts.length >= 5) {
          break;
        }
      }

      return parts.join(' > ');
    };

    const contextText = (node) => {
      let current = node;
      let hops = 0;
      while (current && hops < 4) {
        const heading = current.querySelector?.('h1, h2, h3, [role="heading"]');
        if (heading?.textContent?.trim()) {
          return heading.textContent.trim();
        }
        current = current.parentElement;
        hops += 1;
      }
      return '';
    };

    const iconHint = (node) => {
      const iconLike = node.querySelector?.('svg, i, [data-icon], [class*="icon"], [class*="trash"]');
      if (!iconLike) {
        return '';
      }
      return (
        iconLike.getAttribute?.('data-icon') ||
        iconLike.getAttribute?.('aria-label') ||
        iconLike.getAttribute?.('title') ||
        iconLike.className ||
        ''
      )
        .toString()
        .slice(0, 120);
    };

    const all = Array.from(document.querySelectorAll(SELECTOR));
    const unique = new Map();

    for (const node of all) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') {
        continue;
      }

      const rect = node.getBoundingClientRect();
      if (rect.width < 3 || rect.height < 3) {
        continue;
      }

      if (node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true') {
        continue;
      }

      const selector = toCssPath(node);
      if (!selector) {
        continue;
      }

      if (unique.has(selector)) {
        continue;
      }

      const text = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 180);
      const ariaLabel = (node.getAttribute('aria-label') || '').trim();
      const title = (node.getAttribute('title') || '').trim();
      const placeholder = (node.getAttribute('placeholder') || '').trim();
      const href = node.getAttribute('href') || '';
      const role = node.getAttribute('role') || '';
      const tagName = node.tagName.toLowerCase();
      const type = (node.getAttribute('type') || '').toLowerCase();
      const value = (node.value || '').toString().trim().slice(0, 80);

      unique.set(selector, {
        selector,
        tagName,
        type,
        role,
        text,
        ariaLabel,
        title,
        placeholder,
        href,
        value,
        iconHint: iconHint(node),
        contextText: contextText(node),
        bbox: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });

      if (unique.size >= limit) {
        break;
      }
    }

    return Array.from(unique.values());
  }, max);

  return items.map((item) => ({
    ...item,
    key: actionSignature(item)
  }));
}

export function actionSignature(action) {
  const label = normalizeText(
    `${action.text || ''} ${action.ariaLabel || ''} ${action.title || ''} ${action.placeholder || ''}`
  );
  return `${action.selector}|${action.tagName}|${action.role}|${label}`;
}

export function stateKeyFromState(state) {
  const path = (() => {
    try {
      const parsed = new URL(state.url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return state.url || '';
    }
  })();

  return normalizeText(`${path}|${state.headline}|${state.modalTitles?.join('|') || ''}`);
}

export function routeFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return rawUrl;
  }
}

export function screenshotName(prefix, url, suffix = '') {
  const route = routeFromUrl(url);
  const slug = slugify(route.replace(/\//g, '-'), 'route');
  const tail = suffix ? `-${slugify(suffix)}` : '';
  return `${slugify(prefix)}-${slug}${tail}.png`;
}

export function mightBeFormInput(action) {
  if (action.tagName === 'textarea') {
    return true;
  }

  if (action.tagName === 'input') {
    const blocked = new Set(['button', 'submit', 'checkbox', 'radio', 'file', 'image']);
    return !blocked.has((action.type || '').toLowerCase());
  }

  return false;
}

export function inputSampleFor(action) {
  const label = normalizeText(
    `${action.placeholder || ''} ${action.ariaLabel || ''} ${action.text || ''}`
  );

  if (/email/.test(label)) {
    return 'mapbot@example.com';
  }
  if (/name|title/.test(label)) {
    return 'MapBot Test';
  }
  if (/search/.test(label)) {
    return 'test';
  }
  if (/password/.test(label)) {
    return 'Passw0rd!';
  }

  return 'test';
}

export function isLikelyNavigation(action) {
  if (action.tagName === 'a' && action.href) {
    return true;
  }

  return /\b(tab|menu|next|back|open|view|settings|profile|dashboard)\b/i.test(
    `${action.text} ${action.ariaLabel}`
  );
}

export function isDestructiveCandidate(action, config) {
  const combined = normalizeText(
    `${action.text} ${action.ariaLabel} ${action.title} ${action.iconHint}`
  );

  for (const keyword of config?.safety?.destructiveKeywords || []) {
    if (combined.includes(normalizeText(keyword))) {
      return true;
    }
  }

  return /\b(delete|remove|trash|archive|discard)\b/.test(combined);
}
