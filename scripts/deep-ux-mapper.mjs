#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import {
  appendJsonl,
  appendLearning,
  ensureDir,
  ensureFile,
  ensureLearningsFile,
  mergeUniqueBy,
  nowIso,
  normalizeText,
  readJson,
  safeArray,
  slugify,
  writeJson
} from './lib/fs-utils.mjs';
import {
  classifyAction,
  createKnowledgeBase,
  updateKnowledgeBase,
  buildJourneyName
} from './lib/semantic-learner.mjs';
import { buildCoverageFrontier, buildExpectedVsFoundReport } from './lib/expectation-engine.mjs';
import {
  capturePageState,
  extractInteractiveElements,
  inputSampleFor,
  isDestructiveCandidate,
  mightBeFormInput,
  routeFromUrl,
  sameOrigin,
  screenshotName,
  stateKeyFromState
} from './lib/page-utils.mjs';
import {
  renderExpectedVsFoundMarkdown,
  renderFeatureMarkdown,
  renderJourneyMarkdown
} from './lib/markdown-utils.mjs';
import {
  addCopyEntry,
  buildJourneyDependencyGraph,
  buildRouteCoverage,
  createCopyInventory,
  createEntityRegistry,
  createRouteUniverse,
  extractEntityValuesFromObject,
  extractEntityValuesFromUrl,
  resolveTemplateUrl,
  routeTemplateFromUrl,
  upsertEntityValues,
  upsertRouteObservation
} from './lib/route-intelligence.mjs';
import {
  buildCopyIssueHints,
  buildCriticalPaths,
  buildE2ESpecs,
  buildSmokeSuite
} from './lib/artifact-builders.mjs';

const DEFAULT_CONFIG = {
  version: 2,
  target: {
    baseUrl: 'https://app.example.com',
    loginUrl: 'https://app.example.com/login',
    credentials: {
      email: '',
      password: ''
    },
    otp: {
      enabled: true,
      mode: 'manual',
      timeoutMs: 300_000,
      inputSelectors: [
        'input[name="token"]',
        'input[name="otp"]',
        'input[autocomplete="one-time-code"]',
        'input[inputmode="numeric"]'
      ],
      submitSelectors: ['button[type="submit"]', 'button:has-text("Verify")', 'button:has-text("Continue")']
    },
    loginSelectors: {
      email: ['input[type="email"]', 'input[name="email"]', 'input[autocomplete="username"]'],
      password: ['input[type="password"]', 'input[name="password"]'],
      submit: ['button[type="submit"]', 'button:has-text("Sign in")', 'button:has-text("Login")']
    }
  },
  contexts: [
    {
      name: 'guest',
      auth: false,
      seedPaths: ['/', '/auth/sign-in', '/share', '/invite', '/workspace-invite']
    },
    {
      name: 'auth',
      auth: true,
      seedPaths: ['/', '/dashboard']
    }
  ],
  browser: {
    headed: true,
    slowMoMs: 0,
    navigationTimeoutMs: 30_000,
    actionTimeoutMs: 8_000
  },
  discovery: {
    maxStates: 220,
    maxDepth: 5,
    maxActionsPerState: 45,
    sameOriginOnly: true,
    includePaths: ['/'],
    excludePaths: ['/logout']
  },
  mapping: {
    concurrency: 2,
    maxJourneySteps: 40,
    waitAfterActionMs: 900,
    screenshot: true
  },
  semantics: {
    minConfidence: 0.45
  },
  coverage: {
    mode: 'agnostic-runtime',
    targetPct: 95,
    stagnationRounds: 3
  },
  safety: {
    allowDestructiveConfirm: true,
    alwaysTryCancelBranch: true,
    destructiveKeywords: ['delete', 'remove', 'trash', 'archive', 'discard'],
    confirmTexts: ['Delete', 'Remove', 'Confirm', 'Yes', 'Continue', 'Save'],
    cancelTexts: ['Cancel', 'No', 'Keep', 'Close', 'Back'],
    skipActionTexts: ['logout', 'sign out', 'quit']
  },
  artifacts: {
    root: 'artifacts',
    learningsFile: 'artifacts/learnings.md'
  }
};

const DEFAULT_STATE = {
  version: 2,
  createdAt: nowIso(),
  lastRunAt: null,
  lastCommand: null,
  discovery: {
    completedAt: null,
    stateCount: 0,
    edgeCount: 0,
    candidateJourneyCount: 0,
    routeCoveragePct: 0
  },
  mapping: {
    completedAt: null,
    completedJourneyCount: 0,
    failedJourneyCount: 0,
    blockedJourneyCount: 0,
    routeCoveragePct: 0
  }
};

function normalizeStateShape(inputState) {
  const state = inputState || {};
  return {
    ...DEFAULT_STATE,
    ...state,
    version: 2,
    discovery: {
      ...DEFAULT_STATE.discovery,
      ...(state.discovery || {})
    },
    mapping: {
      ...DEFAULT_STATE.mapping,
      ...(state.mapping || {})
    }
  };
}

function parseArgs(argv) {
  const result = {
    command: argv[2] || 'run',
    flags: {}
  };

  for (let i = 3; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      result.flags[key] = true;
      continue;
    }

    result.flags[key] = next;
    i += 1;
  }

  return result;
}

function resolvePath(cwd, inputPath) {
  if (!inputPath) {
    return null;
  }
  return path.isAbsolute(inputPath) ? inputPath : path.join(cwd, inputPath);
}

function pathsFromConfig(projectRoot, config) {
  const root = resolvePath(projectRoot, config.artifacts.root) || path.join(projectRoot, 'artifacts');

  return {
    cwd: projectRoot,
    root,
    learnings: resolvePath(projectRoot, config.artifacts.learningsFile) || path.join(root, 'learnings.md'),
    lock: path.join(root, 'tmp', 'learnings.lock'),
    state: path.join(root, 'state.json'),
    knowledge: path.join(root, 'knowledge.json'),
    edges: path.join(root, 'graph-edges.jsonl'),
    journeys: path.join(root, 'journeys.json'),
    journeysMd: path.join(root, 'journeys.md'),
    journeyCandidates: path.join(root, 'journey-candidates.jsonl'),
    features: path.join(root, 'features.json'),
    featuresMd: path.join(root, 'features.md'),
    featureEvents: path.join(root, 'feature-events.jsonl'),
    expectedVsFound: path.join(root, 'expected-vs-found.json'),
    expectedVsFoundMd: path.join(root, 'expected-vs-found.md'),
    coverageFrontier: path.join(root, 'coverage-frontier.json'),
    authState: path.join(root, 'auth-storage-state.json'),
    runs: path.join(root, 'runs'),
    routeUniverse: path.join(root, 'route-universe.json'),
    entityRegistry: path.join(root, 'entity-registry.json'),
    journeyGraph: path.join(root, 'journey-graph.json'),
    criticalPaths: path.join(root, 'critical-paths.json'),
    e2eSpecs: path.join(root, 'e2e-specs.json'),
    smokeSuite: path.join(root, 'smoke-suite.json'),
    copyInventory: path.join(root, 'copy-inventory.json'),
    copyIssues: path.join(root, 'copy-issues.json')
  };
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    ensureDir(path.dirname(configPath));
    writeJson(configPath, DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }

  const loaded = readJson(configPath, DEFAULT_CONFIG);
  return {
    ...DEFAULT_CONFIG,
    ...loaded,
    target: {
      ...DEFAULT_CONFIG.target,
      ...(loaded.target || {}),
      credentials: {
        ...DEFAULT_CONFIG.target.credentials,
        ...(loaded.target?.credentials || {})
      },
      otp: {
        ...DEFAULT_CONFIG.target.otp,
        ...(loaded.target?.otp || {})
      },
      loginSelectors: {
        ...DEFAULT_CONFIG.target.loginSelectors,
        ...(loaded.target?.loginSelectors || {})
      }
    },
    contexts: safeArray(loaded.contexts).length > 0 ? loaded.contexts : DEFAULT_CONFIG.contexts,
    browser: {
      ...DEFAULT_CONFIG.browser,
      ...(loaded.browser || {})
    },
    discovery: {
      ...DEFAULT_CONFIG.discovery,
      ...(loaded.discovery || {})
    },
    mapping: {
      ...DEFAULT_CONFIG.mapping,
      ...(loaded.mapping || {})
    },
    semantics: {
      ...DEFAULT_CONFIG.semantics,
      ...(loaded.semantics || {})
    },
    coverage: {
      ...DEFAULT_CONFIG.coverage,
      ...(loaded.coverage || {})
    },
    safety: {
      ...DEFAULT_CONFIG.safety,
      ...(loaded.safety || {})
    },
    artifacts: {
      ...DEFAULT_CONFIG.artifacts,
      ...(loaded.artifacts || {})
    }
  };
}

function validateConfig(config) {
  const errors = [];

  if (!config.target?.baseUrl) {
    errors.push('target.baseUrl is required');
  }

  try {
    if (config.target?.baseUrl) {
      new URL(config.target.baseUrl);
    }
  } catch {
    errors.push('target.baseUrl must be a valid URL');
  }

  if (Number(config.discovery.maxStates) <= 0) {
    errors.push('discovery.maxStates must be > 0');
  }

  if (Number(config.mapping.concurrency) <= 0) {
    errors.push('mapping.concurrency must be > 0');
  }

  if (Number(config.coverage.targetPct) <= 0 || Number(config.coverage.targetPct) > 100) {
    errors.push('coverage.targetPct must be > 0 and <= 100');
  }

  return errors;
}

function initializeWorkspace(paths, configPath, config) {
  ensureDir(paths.root);
  ensureDir(path.join(paths.root, 'tmp'));
  ensureDir(paths.runs);

  ensureFile(paths.state, `${JSON.stringify(DEFAULT_STATE, null, 2)}\n`);
  ensureFile(paths.knowledge, `${JSON.stringify(createKnowledgeBase(), null, 2)}\n`);
  ensureFile(paths.journeys, `${JSON.stringify({ version: 2, journeys: [] }, null, 2)}\n`);
  ensureFile(paths.features, `${JSON.stringify({ version: 2, features: [] }, null, 2)}\n`);
  ensureFile(paths.expectedVsFound, `${JSON.stringify({ version: 2, entities: [] }, null, 2)}\n`);
  ensureFile(paths.coverageFrontier, `${JSON.stringify({ version: 2 }, null, 2)}\n`);
  ensureFile(paths.edges, '');
  ensureFile(paths.journeyCandidates, '');
  ensureFile(paths.featureEvents, '');
  ensureFile(paths.routeUniverse, `${JSON.stringify(createRouteUniverse(), null, 2)}\n`);
  ensureFile(paths.entityRegistry, `${JSON.stringify(createEntityRegistry(), null, 2)}\n`);
  ensureFile(paths.journeyGraph, `${JSON.stringify({ version: 2, nodes: [], edges: [] }, null, 2)}\n`);
  ensureFile(paths.criticalPaths, `${JSON.stringify({ version: 2, entries: [] }, null, 2)}\n`);
  ensureFile(paths.e2eSpecs, `${JSON.stringify({ version: 2, specs: [] }, null, 2)}\n`);
  ensureFile(paths.smokeSuite, `${JSON.stringify({ version: 2, cases: [] }, null, 2)}\n`);
  ensureFile(paths.copyInventory, `${JSON.stringify(createCopyInventory(), null, 2)}\n`);
  ensureFile(paths.copyIssues, `${JSON.stringify({ version: 2, hints: [] }, null, 2)}\n`);
  ensureLearningsFile(paths.learnings);

  const migratedState = normalizeStateShape(readJson(paths.state, DEFAULT_STATE));
  writeJson(paths.state, migratedState);

  if (!fs.existsSync(configPath)) {
    writeJson(configPath, config);
  }
}

function updateState(paths, patch) {
  const current = normalizeStateShape(readJson(paths.state, DEFAULT_STATE));
  const next = {
    ...current,
    ...patch,
    discovery: {
      ...current.discovery,
      ...(patch.discovery || {})
    },
    mapping: {
      ...current.mapping,
      ...(patch.mapping || {})
    },
    lastRunAt: nowIso()
  };

  writeJson(paths.state, next);
  return next;
}

async function launchBrowser(config) {
  return chromium.launch({
    headless: !config.browser.headed,
    slowMo: Number(config.browser.slowMoMs || 0)
  });
}

async function firstVisibleLocator(page, selectors = []) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible()) {
        return locator;
      }
    } catch {
      // keep trying
    }
  }
  return null;
}

async function runLoginIfNeeded(page, config, logPrefix = '[auth]') {
  const loginUrl = config.target.loginUrl || config.target.baseUrl;

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: config.browser.navigationTimeoutMs });
  await page.waitForTimeout(500);

  const email = config.target.credentials?.email;
  const password = config.target.credentials?.password;

  if (!email || !password) {
    console.log(`${logPrefix} credentials missing, skipping auto-login`);
    return;
  }

  const emailInput = await firstVisibleLocator(page, config.target.loginSelectors.email);
  const passwordInput = await firstVisibleLocator(page, config.target.loginSelectors.password);

  if (!emailInput || !passwordInput) {
    console.log(`${logPrefix} login inputs not found, continuing without form submission`);
    return;
  }

  await emailInput.fill(email);
  await passwordInput.fill(password);

  const submit = await firstVisibleLocator(page, config.target.loginSelectors.submit);
  if (submit) {
    await submit.click({ timeout: config.browser.actionTimeoutMs });
  }

  await page.waitForTimeout(1_000);

  if (config.target.otp?.enabled) {
    const otpInput = await firstVisibleLocator(page, config.target.otp.inputSelectors);
    if (otpInput) {
      console.log(`${logPrefix} OTP detected. Complete OTP in browser within ${config.target.otp.timeoutMs}ms.`);
      const startedAt = Date.now();
      while (Date.now() - startedAt < config.target.otp.timeoutMs) {
        const stillVisible = await otpInput.isVisible().catch(() => false);
        if (!stillVisible) {
          break;
        }
        await page.waitForTimeout(1_500);
      }
    }
  }
}

async function ensureAuthStorageState(browser, config, paths) {
  if (fs.existsSync(paths.authState)) {
    return paths.authState;
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  await runLoginIfNeeded(page, config);
  await page.goto(config.target.baseUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.browser.navigationTimeoutMs
  });

  await context.storageState({ path: paths.authState });
  await context.close();
  return paths.authState;
}

async function openContext(browser, contextDef, paths) {
  if (contextDef.auth && fs.existsSync(paths.authState)) {
    return browser.newContext({ storageState: paths.authState });
  }
  return browser.newContext();
}

function shouldQueueUrl(url, baseUrl, config) {
  if (!url) {
    return false;
  }

  if (config.discovery.sameOriginOnly && !sameOrigin(url, baseUrl)) {
    return false;
  }

  const route = routeFromUrl(url);
  if (safeArray(config.discovery.excludePaths).some((prefix) => route.startsWith(prefix))) {
    return false;
  }

  if (!safeArray(config.discovery.includePaths).length) {
    return true;
  }

  return safeArray(config.discovery.includePaths).some((prefix) => route.startsWith(prefix));
}

function shouldSkipByText(action, config) {
  const text = normalizeText(`${action.text} ${action.ariaLabel} ${action.title}`);
  return safeArray(config.safety.skipActionTexts).some((item) => text.includes(normalizeText(item)));
}

async function locateAction(page, action) {
  if (action.selector) {
    const bySelector = page.locator(action.selector).first();
    if (await bySelector.isVisible().catch(() => false)) {
      return bySelector;
    }
  }

  const labels = [action.text, action.ariaLabel, action.title].filter(Boolean);
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const byButtonText = page
      .locator('button, [role="button"], a, [role="menuitem"], [role="tab"]')
      .filter({ hasText: new RegExp(escaped, 'i') })
      .first();

    if (await byButtonText.isVisible().catch(() => false)) {
      return byButtonText;
    }
  }

  return null;
}

async function selectAlternateValue(locator) {
  const values = await locator.evaluate((node) => {
    if (!(node instanceof HTMLSelectElement)) {
      return [];
    }

    return Array.from(node.options)
      .map((option) => option.value)
      .filter((value) => value !== node.value);
  });

  if (!values.length) {
    return false;
  }

  await locator.selectOption(values[0]);
  return true;
}

async function performAction(page, action, config) {
  const locator = await locateAction(page, action);
  if (!locator) {
    return { performed: false, reason: 'missing-locator' };
  }

  if (shouldSkipByText(action, config)) {
    return { performed: false, reason: 'skip-text' };
  }

  if (action.tagName === 'select') {
    const switched = await selectAlternateValue(locator);
    return switched
      ? { performed: true, kind: 'select', reason: 'selected-alternate-option' }
      : { performed: false, reason: 'select-no-options' };
  }

  if (mightBeFormInput(action)) {
    const sample = inputSampleFor(action);
    await locator.fill(sample, { timeout: config.browser.actionTimeoutMs });
    return { performed: true, kind: 'fill', sample };
  }

  await locator.click({ timeout: config.browser.actionTimeoutMs });
  return { performed: true, kind: 'click' };
}

async function captureScreenshotIfEnabled(page, config, outputDir, prefix, url, suffix = '') {
  if (!config.mapping.screenshot) {
    return null;
  }

  ensureDir(outputDir);
  const fileName = screenshotName(prefix, url, suffix);
  const fullPath = path.join(outputDir, fileName);
  await page.screenshot({ path: fullPath, fullPage: true });
  return fullPath;
}

async function collectNetworkEntityValues(page, actionRunner, waitMs) {
  const mutationRequests = [];
  const entityPayloads = [];
  const responseTasks = [];

  const requestListener = (request) => {
    const method = request.method();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      mutationRequests.push({
        at: nowIso(),
        method,
        url: request.url()
      });
    }
  };

  const responseListener = (response) => {
    const req = response.request();
    const type = req.resourceType();
    if (!['xhr', 'fetch'].includes(type)) {
      return;
    }

    const task = (async () => {
      try {
        const contentType = response.headers()['content-type'] || '';
        if (!/json/i.test(contentType)) {
          return;
        }
        const json = await response.json();
        const entities = extractEntityValuesFromObject(json, { maxDepth: 6 });
        if (Object.keys(entities).length > 0) {
          entityPayloads.push({
            url: response.url(),
            status: response.status(),
            entities
          });
        }
      } catch {
        // Ignore parse failures.
      }
    })();

    responseTasks.push(task);
  };

  page.on('requestfinished', requestListener);
  page.on('response', responseListener);

  try {
    const actionResult = await actionRunner();
    await page.waitForTimeout(waitMs);
    await Promise.allSettled(responseTasks);
    return { actionResult, mutationRequests, entityPayloads };
  } finally {
    page.off('requestfinished', requestListener);
    page.off('response', responseListener);
  }
}

function deriveProducedEntityKeys(beforeValues, afterValues) {
  const keys = new Set();

  for (const [key, value] of Object.entries(afterValues || {})) {
    if (!value) {
      continue;
    }

    if (!beforeValues[key] || String(beforeValues[key]) !== String(value)) {
      keys.add(key);
    }
  }

  return Array.from(keys).sort();
}

async function probeActionTransition(params) {
  const {
    page,
    stateItem,
    beforeState,
    action,
    config,
    runOutputDir,
    minConfidence,
    contextName
  } = params;

  const startedAt = Date.now();
  const beforeEntities = extractEntityValuesFromUrl(beforeState.url);

  let actionResult;
  let afterState;
  let screenshot;
  let mutationRequests = [];
  let entityPayloads = [];

  try {
    const networkOutcome = await collectNetworkEntityValues(
      page,
      () => performAction(page, action, config),
      config.mapping.waitAfterActionMs
    );

    actionResult = networkOutcome.actionResult;
    mutationRequests = networkOutcome.mutationRequests;
    entityPayloads = networkOutcome.entityPayloads;

    afterState = await capturePageState(page);

    if (actionResult.performed) {
      screenshot = await captureScreenshotIfEnabled(
        page,
        config,
        runOutputDir,
        'probe',
        afterState.url,
        action.text || action.ariaLabel || action.title || action.selector
      );
    }
  } catch (error) {
    actionResult = { performed: false, reason: `error:${error.message}` };
    afterState = await capturePageState(page).catch(() => beforeState);
  }

  const afterEntities = {
    ...extractEntityValuesFromUrl(afterState.url)
  };

  for (const payload of entityPayloads) {
    Object.assign(afterEntities, payload.entities);
  }

  const producedEntityKeys = deriveProducedEntityKeys(beforeEntities, afterEntities);

  const classification = classifyAction(action, beforeState, { networkMutations: mutationRequests });
  const changed =
    actionResult.performed &&
    (beforeState.fingerprint !== afterState.fingerprint || beforeState.url !== afterState.url || mutationRequests.length > 0);

  const fromTemplate = routeTemplateFromUrl(beforeState.url);
  const toTemplate = routeTemplateFromUrl(afterState.url);

  const edge = {
    id: `edge-${slugify(`${beforeState.url}-${action.selector || action.text}-${Date.now()}`)}`,
    observedAt: nowIso(),
    durationMs: Date.now() - startedAt,
    context: contextName,
    from: {
      url: beforeState.url,
      routeTemplate: fromTemplate.template,
      requiredEntities: fromTemplate.requiredEntities,
      fingerprint: beforeState.fingerprint,
      route: routeFromUrl(beforeState.url)
    },
    to: {
      url: afterState.url,
      routeTemplate: toTemplate.template,
      requiredEntities: toTemplate.requiredEntities,
      fingerprint: afterState.fingerprint,
      route: routeFromUrl(afterState.url)
    },
    action,
    actionResult,
    semantic: classification,
    networkMutations: mutationRequests,
    networkEntityPayloads: entityPayloads,
    extractedEntities: afterEntities,
    producedEntityKeys,
    changed,
    screenshot,
    trail: [...safeArray(stateItem.trail), {
      fromUrl: beforeState.url,
      fromUrlTemplate: fromTemplate.template,
      requiredEntities: fromTemplate.requiredEntities,
      selector: action.selector,
      label: classification.label,
      verb: classification.verb,
      entity: classification.entity,
      destructiveHint: classification.destructiveHint
    }]
  };

  if (classification.confidence >= minConfidence) {
    await appendLearning(
      params.learningsPath,
      params.lockPath,
      'Entities inferred',
      `Action "${classification.label}" suggests ${classification.verb} on entity "${classification.entity}"`,
      { runId: params.runId, url: beforeState.url }
    );
  }

  return edge;
}

function mergeJourneyCandidates(existing, generated) {
  const byKey = new Map();
  const combined = [...safeArray(existing), ...safeArray(generated)];

  for (const journey of combined) {
    const key = `${journey.intent}|${journey.entity}|${journey.entryTemplate || journey.entryUrl}|${journey.targetTemplate || journey.targetUrl || ''}`;
    const current = byKey.get(key);
    if (!current || (journey.confidence || 0) > (current.confidence || 0)) {
      byKey.set(key, journey);
    }
  }

  return Array.from(byKey.values())
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .map((journey, index) => ({
      ...journey,
      id: journey.id || `journey-${String(index + 1).padStart(3, '0')}`
    }));
}

function synthesizeJourneysFromEdges(edges, config) {
  const journeys = [];
  const minConfidence = config.semantics.minConfidence;

  for (const edge of edges) {
    const semantic = edge.semantic;
    if (!semantic || semantic.verb === 'unknown' || semantic.confidence < minConfidence) {
      continue;
    }

    const requiredEntities = new Set();
    for (const step of safeArray(edge.trail)) {
      for (const key of safeArray(step.requiredEntities)) {
        requiredEntities.add(key);
      }
    }

    const producedEntities = new Set(safeArray(edge.producedEntityKeys));

    const name = buildJourneyName(semantic.verb, semantic.entity);
    journeys.push({
      id: `journey-${slugify(`${semantic.verb}-${semantic.entity}-${edge.from.routeTemplate || edge.from.route}`)}`,
      name,
      intent: semantic.verb,
      entity: semantic.entity,
      context: edge.context || 'auth',
      confidence: semantic.confidence,
      entryUrl: edge.trail[0]?.fromUrl || edge.from.url,
      entryTemplate: edge.trail[0]?.fromUrlTemplate || edge.from.routeTemplate,
      targetUrl: edge.to.url,
      targetTemplate: edge.to.routeTemplate,
      requiredEntities: Array.from(requiredEntities).sort(),
      producedEntities: Array.from(producedEntities).sort(),
      status: 'discovered',
      steps: edge.trail,
      completionSignals: {
        urlChanged: edge.from.url !== edge.to.url,
        mutation: edge.networkMutations.length > 0,
        stateChanged: edge.from.fingerprint !== edge.to.fingerprint
      },
      evidence: {
        fromUrl: edge.from.url,
        toUrl: edge.to.url,
        screenshot: edge.screenshot,
        action: semantic.label
      }
    });
  }

  return mergeUniqueBy(journeys, (journey) => {
    return `${journey.intent}|${journey.entity}|${journey.targetTemplate || journey.targetUrl}`;
  });
}

function featureFromEdge(edge) {
  return {
    id: `feature-${slugify(`${edge.semantic.verb}-${edge.semantic.entity}-${edge.from.routeTemplate}-${Date.now()}`)}`,
    discoveredAt: edge.observedAt,
    journeyId: 'discovery',
    route: edge.from.route,
    routeTemplate: edge.from.routeTemplate,
    verb: edge.semantic.verb,
    entity: edge.semantic.entity,
    actionLabel: edge.semantic.label,
    outcome: edge.changed ? 'state-changed' : 'no-observable-change',
    context: edge.context,
    producedEntities: safeArray(edge.producedEntityKeys),
    evidence: {
      screenshot: edge.screenshot,
      from: edge.from.url,
      to: edge.to.url
    }
  };
}

function buildSeedUrls(config, contextDef, entityRegistry) {
  const urls = [];
  const baseUrl = config.target.baseUrl;

  for (const pathOrUrl of safeArray(contextDef.seedPaths)) {
    if (!pathOrUrl) {
      continue;
    }

    let candidate;
    if (/^https?:\/\//i.test(pathOrUrl)) {
      candidate = pathOrUrl;
    } else {
      candidate = new URL(pathOrUrl, baseUrl).toString();
    }

    const resolved = resolveTemplateUrl(routeTemplateFromUrl(candidate).template, entityRegistry);
    if (resolved.missingEntities.length > 0) {
      urls.push(candidate);
    } else {
      urls.push(resolved.resolvedUrl);
    }
  }

  if (!urls.includes(baseUrl)) {
    urls.unshift(baseUrl);
  }

  return Array.from(new Set(urls));
}

async function runDiscovery(config, paths) {
  const runId = `discover-${Date.now()}`;
  const runDir = path.join(paths.runs, runId);
  ensureDir(runDir);
  ensureDir(path.join(runDir, 'screenshots'));

  const browser = await launchBrowser(config);
  await ensureAuthStorageState(browser, config, paths);

  let knowledge = createKnowledgeBase(readJson(paths.knowledge, createKnowledgeBase()));
  let routeUniverse = createRouteUniverse(readJson(paths.routeUniverse, createRouteUniverse()));
  let entityRegistry = createEntityRegistry(readJson(paths.entityRegistry, createEntityRegistry()));
  let copyInventory = createCopyInventory(readJson(paths.copyInventory, createCopyInventory()));

  const edges = [];
  const contextStats = {};

  for (const contextDef of safeArray(config.contexts)) {
    const contextName = contextDef.name || 'unknown';
    const context = await openContext(browser, contextDef, paths);
    const page = await context.newPage();

    const queue = buildSeedUrls(config, contextDef, entityRegistry).map((url) => ({
      url,
      depth: 0,
      trail: []
    }));

    const visitedStates = new Set();
    let processedStates = 0;

    while (queue.length > 0 && processedStates < config.discovery.maxStates) {
      const stateItem = queue.shift();
      if (!stateItem?.url) {
        continue;
      }

      const templatedSeed = routeTemplateFromUrl(stateItem.url).template;
      const resolved = resolveTemplateUrl(templatedSeed, entityRegistry);
      if (resolved.missingEntities.length > 0) {
        routeUniverse = upsertRouteObservation(routeUniverse, stateItem.url, {
          context: contextName,
          state: 'blocked_precondition'
        });
        continue;
      }

      const targetUrl = resolved.resolvedUrl;

      try {
        await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: config.browser.navigationTimeoutMs
        });
      } catch {
        routeUniverse = upsertRouteObservation(routeUniverse, targetUrl, {
          context: contextName,
          state: 'failed_navigation'
        });
        continue;
      }

      await page.waitForTimeout(350);
      const state = await capturePageState(page);
      const template = routeTemplateFromUrl(state.url).template;

      const stateKey = `${contextName}|${template}|${stateKeyFromState(state)}`;
      if (visitedStates.has(stateKey)) {
        continue;
      }

      visitedStates.add(stateKey);
      processedStates += 1;

      routeUniverse = upsertRouteObservation(routeUniverse, state.url, {
        context: contextName,
        state: 'visited'
      });

      const urlEntities = extractEntityValuesFromUrl(state.url);
      entityRegistry = upsertEntityValues(entityRegistry, urlEntities, {
        source: `url:${contextName}`
      });

      copyInventory = addCopyEntry(copyInventory, {
        url: state.url,
        context: contextName,
        text: [state.title, state.headline].filter(Boolean).join(' | ')
      });

      const interactions = await extractInteractiveElements(page, {
        maxElements: config.discovery.maxActionsPerState
      });

      for (const action of interactions.slice(0, config.discovery.maxActionsPerState)) {
        await page.goto(state.url, {
          waitUntil: 'domcontentloaded',
          timeout: config.browser.navigationTimeoutMs
        });
        await page.waitForTimeout(200);

        const beforeState = await capturePageState(page);

        const edge = await probeActionTransition({
          page,
          stateItem,
          beforeState,
          action,
          config,
          runOutputDir: path.join(runDir, 'screenshots'),
          minConfidence: config.semantics.minConfidence,
          learningsPath: paths.learnings,
          lockPath: paths.lock,
          runId,
          contextName
        });

        edges.push(edge);
        appendJsonl(paths.edges, edge);

        knowledge = updateKnowledgeBase(knowledge, edge.semantic, { url: beforeState.url });
        entityRegistry = upsertEntityValues(entityRegistry, edge.extractedEntities, {
          source: `edge:${contextName}`
        });

        routeUniverse = upsertRouteObservation(routeUniverse, edge.from.url, {
          context: contextName,
          state: 'executed'
        });
        routeUniverse = upsertRouteObservation(routeUniverse, edge.to.url, {
          context: contextName,
          state: edge.changed ? 'visited' : 'observed'
        });

        copyInventory = addCopyEntry(copyInventory, {
          url: edge.from.url,
          context: contextName,
          text: edge.semantic?.label || action.text || action.ariaLabel || action.title || ''
        });

        if (
          edge.changed &&
          stateItem.depth < config.discovery.maxDepth &&
          shouldQueueUrl(edge.to.url, config.target.baseUrl, config)
        ) {
          queue.push({
            url: edge.to.url,
            depth: stateItem.depth + 1,
            trail: edge.trail
          });
        }

        if (action.href) {
          const maybeUrl = (() => {
            try {
              return new URL(action.href, state.url).toString();
            } catch {
              return '';
            }
          })();

          if (shouldQueueUrl(maybeUrl, config.target.baseUrl, config)) {
            queue.push({
              url: maybeUrl,
              depth: stateItem.depth + 1,
              trail: edge.trail
            });
          }
        }
      }
    }

    contextStats[contextName] = {
      visitedStates: processedStates,
      edges: edges.filter((edge) => edge.context === contextName).length
    };

    await context.close();
  }

  const existingJourneys = readJson(paths.journeys, { version: 2, journeys: [] }).journeys || [];
  const generatedJourneys = synthesizeJourneysFromEdges(edges, config);
  const journeys = mergeJourneyCandidates(existingJourneys, generatedJourneys);

  const existingFeatures = readJson(paths.features, { version: 2, features: [] }).features || [];
  const generatedFeatures = edges.map(featureFromEdge);
  const features = mergeUniqueBy([...existingFeatures, ...generatedFeatures], (feature) => {
    return `${feature.routeTemplate}|${feature.verb}|${feature.entity}|${normalizeText(feature.actionLabel)}`;
  });

  const routeCoverage = buildRouteCoverage(routeUniverse);
  const journeyGraph = buildJourneyDependencyGraph(journeys, routeUniverse, entityRegistry);

  writeJson(paths.knowledge, knowledge);
  writeJson(paths.routeUniverse, routeUniverse);
  writeJson(paths.entityRegistry, entityRegistry);
  writeJson(paths.copyInventory, copyInventory);
  writeJson(paths.journeys, { version: 2, generatedAt: nowIso(), journeys });
  writeJson(paths.features, { version: 2, generatedAt: nowIso(), features });
  writeJson(paths.journeyGraph, journeyGraph);

  fs.writeFileSync(paths.journeysMd, renderJourneyMarkdown(journeys), 'utf8');
  fs.writeFileSync(paths.featuresMd, renderFeatureMarkdown(features), 'utf8');

  for (const journey of generatedJourneys) {
    appendJsonl(paths.journeyCandidates, {
      runId,
      decidedAt: nowIso(),
      journey,
      decision: 'accepted'
    });
  }

  for (const feature of generatedFeatures) {
    appendJsonl(paths.featureEvents, {
      runId,
      observedAt: nowIso(),
      feature
    });
  }

  await appendLearning(
    paths.learnings,
    paths.lock,
    'Confirmed behaviors',
    `Discovery visited ${routeCoverage.executedRoutes} route templates across ${safeArray(config.contexts).length} contexts and generated ${generatedJourneys.length} journey candidates`,
    { runId, url: config.target.baseUrl }
  );

  const copyIssueHints = buildCopyIssueHints(copyInventory);
  writeJson(paths.copyIssues, copyIssueHints);

  const expectedVsFound = buildExpectedVsFoundReport(knowledge);
  writeJson(paths.expectedVsFound, expectedVsFound);
  fs.writeFileSync(paths.expectedVsFoundMd, renderExpectedVsFoundMarkdown(expectedVsFound), 'utf8');

  const coverage = buildCoverageFrontier({
    journeys,
    features,
    expectedVsFound
  });

  writeJson(paths.coverageFrontier, {
    ...coverage,
    routeCoverage,
    contextStats,
    mode: config.coverage.mode,
    targetPct: config.coverage.targetPct
  });

  await browser.close();

  updateState(paths, {
    lastCommand: 'discover',
    discovery: {
      completedAt: nowIso(),
      stateCount: Object.values(contextStats).reduce((sum, item) => sum + item.visitedStates, 0),
      edgeCount: edges.length,
      candidateJourneyCount: generatedJourneys.length,
      routeCoveragePct: routeCoverage.coveragePct
    }
  });

  return {
    runId,
    stateCount: Object.values(contextStats).reduce((sum, item) => sum + item.visitedStates, 0),
    edgeCount: edges.length,
    generatedJourneys,
    routeCoverage
  };
}

async function clickButtonByText(page, texts = []) {
  for (const text of texts) {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const button = page
      .locator('button, [role="button"], [type="submit"]')
      .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`, 'i') })
      .first();

    if (await button.isVisible().catch(() => false)) {
      await button.click();
      return text;
    }
  }
  return null;
}

async function hasDialog(page) {
  const dialog = page.locator('[role="dialog"], .modal, [aria-modal="true"]').first();
  return dialog.isVisible().catch(() => false);
}

async function executeDestructiveBranches(page, step, config, contextInfo) {
  const outcomes = [];

  if (!(await hasDialog(page))) {
    outcomes.push({ branch: 'none', result: 'no-dialog-detected' });
    return outcomes;
  }

  if (config.safety.alwaysTryCancelBranch) {
    const cancelClicked = await clickButtonByText(page, config.safety.cancelTexts);
    outcomes.push({
      branch: 'cancel',
      result: cancelClicked ? 'clicked' : 'not-found',
      button: cancelClicked || null
    });
    await page.waitForTimeout(config.mapping.waitAfterActionMs);
  }

  if (!config.safety.allowDestructiveConfirm) {
    outcomes.push({ branch: 'confirm', result: 'skipped-by-config' });
    return outcomes;
  }

  await page.goto(contextInfo.replayUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.browser.navigationTimeoutMs
  });

  const replayAction = {
    selector: step.selector,
    tagName: 'button',
    text: step.label,
    ariaLabel: step.label,
    title: step.label
  };

  await performAction(page, replayAction, config);
  await page.waitForTimeout(350);

  if (!(await hasDialog(page))) {
    outcomes.push({ branch: 'confirm', result: 'dialog-missing-on-replay' });
    return outcomes;
  }

  const confirmClicked = await clickButtonByText(page, config.safety.confirmTexts);
  outcomes.push({
    branch: 'confirm',
    result: confirmClicked ? 'clicked' : 'not-found',
    button: confirmClicked || null
  });
  await page.waitForTimeout(config.mapping.waitAfterActionMs);

  const screenshot = await captureScreenshotIfEnabled(
    page,
    config,
    contextInfo.screenshotDir,
    'destructive-confirm',
    page.url(),
    step.label
  );

  outcomes[outcomes.length - 1].screenshot = screenshot;
  return outcomes;
}

function missingEntitiesForJourney(journey, entityRegistry) {
  return safeArray(journey.requiredEntities).filter((key) => !entityRegistry?.latestValues?.[key]);
}

async function executeJourney(browser, config, paths, journey, shared) {
  const runId = `journey-${journey.id}-${Date.now()}`;
  const runDir = path.join(paths.runs, runId);
  const screenshotDir = path.join(runDir, 'screenshots');
  ensureDir(runDir);
  ensureDir(screenshotDir);

  const contextDef = safeArray(config.contexts).find((ctx) => ctx.name === journey.context) ||
    safeArray(config.contexts).find((ctx) => ctx.auth) ||
    { name: 'auth', auth: true };

  const context = await openContext(browser, contextDef, paths);
  const page = await context.newPage();

  const localFeatures = [];
  const branchFindings = [];
  const events = [];

  let completedSteps = 0;
  let failed = false;
  let blocked = false;

  for (const step of safeArray(journey.steps).slice(0, config.mapping.maxJourneySteps)) {
    const templateToResolve = step.fromUrlTemplate || step.fromUrl;
    const resolved = resolveTemplateUrl(templateToResolve, shared.entityRegistry);

    if (resolved.missingEntities.length > 0) {
      blocked = true;
      events.push({
        step,
        status: 'blocked_precondition',
        missingEntities: resolved.missingEntities
      });
      break;
    }

    const stepUrl = resolved.resolvedUrl;

    try {
      await page.goto(stepUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.browser.navigationTimeoutMs
      });
      await page.waitForTimeout(250);

      shared.routeUniverse = upsertRouteObservation(shared.routeUniverse, stepUrl, {
        context: journey.context || 'auth',
        state: 'visited'
      });

      const before = await capturePageState(page);

      const action = {
        selector: step.selector,
        tagName: 'button',
        text: step.label,
        ariaLabel: step.label,
        title: step.label
      };

      const edge = await probeActionTransition({
        page,
        stateItem: { trail: [] },
        beforeState: before,
        action,
        config,
        runOutputDir: screenshotDir,
        minConfidence: config.semantics.minConfidence,
        learningsPath: paths.learnings,
        lockPath: paths.lock,
        runId,
        contextName: journey.context || 'auth'
      });

      const after = edge.to ? { url: edge.to.url, routeTemplate: edge.to.routeTemplate } : { url: page.url() };

      shared.entityRegistry = upsertEntityValues(shared.entityRegistry, edge.extractedEntities || {}, {
        source: `journey:${journey.id}`
      });

      shared.routeUniverse = upsertRouteObservation(shared.routeUniverse, after.url || page.url(), {
        context: journey.context || 'auth',
        state: edge.changed ? 'executed' : 'observed'
      });

      localFeatures.push({
        id: `feature-${slugify(`${journey.id}-${step.selector || step.label}-${Date.now()}`)}`,
        discoveredAt: nowIso(),
        journeyId: journey.id,
        route: routeFromUrl(before.url),
        routeTemplate: routeTemplateFromUrl(before.url).template,
        verb: edge.semantic?.verb || 'navigate',
        entity: edge.semantic?.entity || journey.entity,
        actionLabel: edge.semantic?.label || step.label,
        outcome: edge.changed ? 'state-changed' : 'no-observable-change',
        context: journey.context,
        producedEntities: safeArray(edge.producedEntityKeys),
        evidence: {
          screenshot: edge.screenshot,
          from: before.url,
          to: after.url || page.url()
        }
      });

      events.push({
        step,
        status: 'ok',
        fromUrl: before.url,
        toUrl: after.url || page.url(),
        producedEntities: edge.producedEntityKeys
      });

      completedSteps += 1;

      if (isDestructiveCandidate(action, config) || step.destructiveHint) {
        const outcomes = await executeDestructiveBranches(page, step, config, {
          screenshotDir,
          replayUrl: stepUrl
        });
        branchFindings.push({ step, outcomes });

        await appendLearning(
          paths.learnings,
          paths.lock,
          'Risky-flow outcomes (Cancel vs Confirm)',
          `Journey ${journey.id} tested destructive step "${step.label}" outcomes: ${outcomes
            .map((outcome) => `${outcome.branch}:${outcome.result}`)
            .join(', ')}`,
          { runId, journeyId: journey.id, url: before.url }
        );
      }
    } catch (error) {
      failed = true;
      events.push({
        step,
        status: 'error',
        error: error.message
      });
      break;
    }
  }

  const status = blocked ? 'blocked' : failed ? 'failed' : completedSteps > 0 ? 'completed' : 'no-op';

  await appendLearning(
    paths.learnings,
    paths.lock,
    status === 'completed' ? 'Confirmed behaviors' : 'Open hypotheses',
    `Journey ${journey.id} finished with status=${status} and completedSteps=${completedSteps}`,
    { runId, journeyId: journey.id, url: journey.entryUrl }
  );

  writeJson(path.join(runDir, 'journey-run.json'), {
    runId,
    journeyId: journey.id,
    status,
    completedSteps,
    branchFindings,
    events
  });

  await context.close();

  for (const feature of localFeatures) {
    appendJsonl(paths.featureEvents, {
      runId,
      observedAt: nowIso(),
      feature
    });
  }

  shared.knowledge = updateKnowledgeBase(shared.knowledge, {
    entity: journey.entity,
    verb: journey.intent,
    confidence: journey.confidence,
    label: journey.name
  }, {
    url: journey.entryUrl
  });

  return {
    journeyId: journey.id,
    status,
    completedSteps,
    localFeatures,
    branchFindings,
    missingEntities: status === 'blocked' ? missingEntitiesForJourney(journey, shared.entityRegistry) : []
  };
}

async function runInPool(items, concurrency, worker) {
  const queue = [...items];
  const results = [];

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) {
        continue;
      }
      const output = await worker(item);
      results.push(output);
    }
  });

  await Promise.all(workers);
  return results;
}

async function runJourneyMapping(config, paths) {
  const browser = await launchBrowser(config);
  await ensureAuthStorageState(browser, config, paths);

  const journeysPayload = readJson(paths.journeys, { version: 2, journeys: [] });
  const journeys = safeArray(journeysPayload.journeys);

  if (!journeys.length) {
    await browser.close();
    return { completed: 0, failed: 0, blocked: 0, features: 0 };
  }

  const shared = {
    knowledge: createKnowledgeBase(readJson(paths.knowledge, createKnowledgeBase())),
    entityRegistry: createEntityRegistry(readJson(paths.entityRegistry, createEntityRegistry())),
    routeUniverse: createRouteUniverse(readJson(paths.routeUniverse, createRouteUniverse()))
  };

  const pending = [...journeys];
  const results = [];
  let safetyIterations = 0;

  while (pending.length > 0 && safetyIterations < 200) {
    safetyIterations += 1;

    const ready = pending.filter((journey) => missingEntitiesForJourney(journey, shared.entityRegistry).length === 0);

    if (ready.length === 0) {
      for (const journey of pending) {
        results.push({
          journeyId: journey.id,
          status: 'blocked',
          completedSteps: 0,
          localFeatures: [],
          branchFindings: [],
          missingEntities: missingEntitiesForJourney(journey, shared.entityRegistry)
        });
      }
      break;
    }

    const batch = ready.slice(0, Math.max(1, config.mapping.concurrency));
    const batchResults = await runInPool(batch, config.mapping.concurrency, (journey) => {
      return executeJourney(browser, config, paths, journey, shared);
    });

    results.push(...batchResults);

    const processedIds = new Set(batch.map((journey) => journey.id));
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (processedIds.has(pending[i].id)) {
        pending.splice(i, 1);
      }
    }
  }

  await browser.close();

  const currentFeatures = readJson(paths.features, { version: 2, features: [] }).features || [];
  const mappedFeatures = results.flatMap((result) => result.localFeatures || []);
  const mergedFeatures = mergeUniqueBy([...currentFeatures, ...mappedFeatures], (feature) => {
    return `${feature.journeyId}|${feature.routeTemplate}|${feature.verb}|${feature.entity}|${normalizeText(feature.actionLabel)}`;
  });

  const resultByJourneyId = Object.fromEntries(results.map((result) => [result.journeyId, result]));

  const updatedJourneys = journeys.map((journey) => {
    const result = resultByJourneyId[journey.id];
    if (!result) {
      return journey;
    }

    const missing = safeArray(result.missingEntities);
    return {
      ...journey,
      status: result.status,
      mappedAt: nowIso(),
      lastMissingEntities: missing
    };
  });

  const expectedVsFound = buildExpectedVsFoundReport(shared.knowledge);
  const routeCoverage = buildRouteCoverage(shared.routeUniverse);
  const journeyGraph = buildJourneyDependencyGraph(updatedJourneys, shared.routeUniverse, shared.entityRegistry);
  const criticalPaths = buildCriticalPaths(updatedJourneys);
  const e2eSpecs = buildE2ESpecs(updatedJourneys, shared.entityRegistry);
  const smokeSuite = buildSmokeSuite(e2eSpecs, criticalPaths);
  const copyInventory = createCopyInventory(readJson(paths.copyInventory, createCopyInventory()));
  const copyIssues = buildCopyIssueHints(copyInventory);

  writeJson(paths.knowledge, shared.knowledge);
  writeJson(paths.entityRegistry, shared.entityRegistry);
  writeJson(paths.routeUniverse, shared.routeUniverse);
  writeJson(paths.features, { version: 2, generatedAt: nowIso(), features: mergedFeatures });
  writeJson(paths.journeys, { version: 2, generatedAt: nowIso(), journeys: updatedJourneys });
  writeJson(paths.expectedVsFound, expectedVsFound);
  writeJson(paths.journeyGraph, journeyGraph);
  writeJson(paths.criticalPaths, criticalPaths);
  writeJson(paths.e2eSpecs, e2eSpecs);
  writeJson(paths.smokeSuite, smokeSuite);
  writeJson(paths.copyIssues, copyIssues);

  fs.writeFileSync(paths.featuresMd, renderFeatureMarkdown(mergedFeatures), 'utf8');
  fs.writeFileSync(paths.journeysMd, renderJourneyMarkdown(updatedJourneys), 'utf8');
  fs.writeFileSync(paths.expectedVsFoundMd, renderExpectedVsFoundMarkdown(expectedVsFound), 'utf8');

  const coverage = buildCoverageFrontier({
    journeys: updatedJourneys,
    features: mergedFeatures,
    expectedVsFound
  });

  writeJson(paths.coverageFrontier, {
    ...coverage,
    routeCoverage,
    mode: config.coverage.mode,
    targetPct: config.coverage.targetPct,
    isTargetMet: routeCoverage.coveragePct >= Number(config.coverage.targetPct || 95)
  });

  if (safeArray(expectedVsFound.missing).length > 0) {
    await appendLearning(
      paths.learnings,
      paths.lock,
      'Unconfirmed expectations',
      `Missing capability expectations detected for ${expectedVsFound.missing.length} entities`,
      { runId: `map-${Date.now()}` }
    );
  }

  const completed = results.filter((item) => item.status === 'completed').length;
  const failed = results.filter((item) => item.status === 'failed').length;
  const blocked = results.filter((item) => item.status === 'blocked').length;

  updateState(paths, {
    lastCommand: 'map',
    mapping: {
      completedAt: nowIso(),
      completedJourneyCount: completed,
      failedJourneyCount: failed,
      blockedJourneyCount: blocked,
      routeCoveragePct: routeCoverage.coveragePct
    }
  });

  return {
    completed,
    failed,
    blocked,
    features: mappedFeatures.length,
    expectedCoverage: expectedVsFound.overallCoveragePct,
    routeCoverage
  };
}

function statusSummary(paths) {
  const state = normalizeStateShape(readJson(paths.state, DEFAULT_STATE));
  const journeys = readJson(paths.journeys, { version: 2, journeys: [] }).journeys || [];
  const features = readJson(paths.features, { version: 2, features: [] }).features || [];
  const expected = readJson(paths.expectedVsFound, { overallCoveragePct: 0, missing: [] });
  const routeUniverse = createRouteUniverse(readJson(paths.routeUniverse, createRouteUniverse()));
  const routeCoverage = buildRouteCoverage(routeUniverse);
  const journeyGraph = readJson(paths.journeyGraph, { version: 2, unresolvedEntities: [] });

  const summary = {
    state,
    metrics: {
      journeysTotal: journeys.length,
      journeysCompleted: journeys.filter((journey) => journey.status === 'completed').length,
      journeysFailed: journeys.filter((journey) => journey.status === 'failed').length,
      journeysBlocked: journeys.filter((journey) => journey.status === 'blocked').length,
      featuresTotal: features.length,
      expectationCoveragePct: expected.overallCoveragePct || 0,
      missingExpectations: safeArray(expected.missing).length,
      routeCoverage,
      unresolvedRouteEntities: safeArray(journeyGraph.unresolvedEntities).length
    },
    artifacts: {
      journeys: paths.journeys,
      features: paths.features,
      expectedVsFound: paths.expectedVsFound,
      coverageFrontier: paths.coverageFrontier,
      learnings: paths.learnings,
      routeUniverse: paths.routeUniverse,
      entityRegistry: paths.entityRegistry,
      journeyGraph: paths.journeyGraph,
      criticalPaths: paths.criticalPaths,
      e2eSpecs: paths.e2eSpecs,
      smokeSuite: paths.smokeSuite,
      copyInventory: paths.copyInventory,
      copyIssues: paths.copyIssues
    }
  };

  return summary;
}

async function runCommand(command, config, paths, configPath) {
  switch (command) {
    case 'init': {
      initializeWorkspace(paths, configPath, config);
      updateState(paths, { lastCommand: 'init' });
      console.log(JSON.stringify({ ok: true, command: 'init', root: paths.root }, null, 2));
      return;
    }
    case 'validate-config': {
      const errors = validateConfig(config);
      if (errors.length > 0) {
        console.error(JSON.stringify({ ok: false, errors }, null, 2));
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ ok: true, command: 'validate-config' }, null, 2));
      return;
    }
    case 'discover': {
      const result = await runDiscovery(config, paths);
      console.log(JSON.stringify({ ok: true, command: 'discover', ...result }, null, 2));
      return;
    }
    case 'map': {
      const result = await runJourneyMapping(config, paths);
      console.log(JSON.stringify({ ok: true, command: 'map', ...result }, null, 2));
      return;
    }
    case 'status': {
      console.log(JSON.stringify(statusSummary(paths), null, 2));
      return;
    }
    case 'run': {
      await runDiscovery(config, paths);
      const mapping = await runJourneyMapping(config, paths);
      console.log(JSON.stringify({ ok: true, command: 'run', mapping, status: statusSummary(paths) }, null, 2));
      return;
    }
    default:
      console.error(`Unknown command: ${command}`);
      process.exitCode = 1;
  }
}

async function main() {
  const parsed = parseArgs(process.argv);
  const projectRoot = process.cwd();
  const configPath = resolvePath(
    projectRoot,
    parsed.flags.config || path.join('docs', 'orchestration.config.json')
  );

  const config = loadConfig(configPath);
  const paths = pathsFromConfig(projectRoot, config);

  initializeWorkspace(paths, configPath, config);

  const validationErrors = validateConfig(config);
  if (validationErrors.length > 0) {
    console.error(JSON.stringify({ ok: false, command: parsed.command, errors: validationErrors }, null, 2));
    process.exit(1);
  }

  try {
    await runCommand(parsed.command, config, paths, configPath);
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      command: parsed.command,
      error: error?.message || String(error)
    }, null, 2));
    process.exit(1);
  }
}

main();
