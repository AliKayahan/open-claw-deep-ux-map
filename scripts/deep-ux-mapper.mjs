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
  sleep,
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

const DEFAULT_CONFIG = {
  version: 1,
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
  browser: {
    headed: true,
    slowMoMs: 0,
    navigationTimeoutMs: 30_000,
    actionTimeoutMs: 8_000
  },
  discovery: {
    maxStates: 120,
    maxDepth: 4,
    maxActionsPerState: 35,
    sameOriginOnly: true,
    includePaths: ['/'],
    excludePaths: ['/logout']
  },
  mapping: {
    concurrency: 2,
    maxJourneySteps: 30,
    waitAfterActionMs: 750,
    screenshot: true
  },
  semantics: {
    minConfidence: 0.45
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
  version: 1,
  createdAt: nowIso(),
  lastRunAt: null,
  lastCommand: null,
  discovery: {
    completedAt: null,
    stateCount: 0,
    edgeCount: 0,
    candidateJourneyCount: 0
  },
  mapping: {
    completedAt: null,
    completedJourneyCount: 0,
    failedJourneyCount: 0
  }
};

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
    runs: path.join(root, 'runs')
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

  return errors;
}

function initializeWorkspace(paths, configPath, config) {
  ensureDir(paths.root);
  ensureDir(path.join(paths.root, 'tmp'));
  ensureDir(paths.runs);

  ensureFile(paths.state, `${JSON.stringify(DEFAULT_STATE, null, 2)}\n`);
  ensureFile(paths.knowledge, `${JSON.stringify(createKnowledgeBase(), null, 2)}\n`);
  ensureFile(paths.journeys, `${JSON.stringify({ version: 1, journeys: [] }, null, 2)}\n`);
  ensureFile(paths.features, `${JSON.stringify({ version: 1, features: [] }, null, 2)}\n`);
  ensureFile(paths.expectedVsFound, `${JSON.stringify({ version: 1, entities: [] }, null, 2)}\n`);
  ensureFile(paths.coverageFrontier, `${JSON.stringify({ version: 1 }, null, 2)}\n`);
  ensureFile(paths.edges, '');
  ensureFile(paths.journeyCandidates, '');
  ensureFile(paths.featureEvents, '');
  ensureLearningsFile(paths.learnings);

  if (!fs.existsSync(configPath)) {
    writeJson(configPath, config);
  }
}

function updateState(paths, patch) {
  const current = readJson(paths.state, DEFAULT_STATE);
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
      // continue
    }
  }
  return null;
}

async function runLoginIfNeeded(page, config, logPrefix = '[auth]') {
  const currentUrl = page.url();
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

  if (currentUrl && currentUrl !== 'about:blank') {
    await page.goto(config.target.baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.browser.navigationTimeoutMs
    });
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

async function locateAction(page, action) {
  const selector = action.selector;
  if (!selector) {
    return null;
  }

  const locator = page.locator(selector).first();
  try {
    const visible = await locator.isVisible();
    if (!visible) {
      return null;
    }
    return locator;
  } catch {
    return null;
  }
}

async function selectAlternateValue(page, locator) {
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

function shouldSkipByText(action, config) {
  const text = normalizeText(`${action.text} ${action.ariaLabel} ${action.title}`);
  return (config.safety.skipActionTexts || []).some((item) => text.includes(normalizeText(item)));
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
    const switched = await selectAlternateValue(page, locator);
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

async function probeActionTransition(params) {
  const {
    page,
    stateItem,
    beforeState,
    action,
    config,
    runOutputDir,
    minConfidence
  } = params;

  const startedAt = Date.now();
  const networkMutations = [];

  const requestListener = (request) => {
    const method = request.method();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      networkMutations.push({
        at: nowIso(),
        method,
        url: request.url()
      });
    }
  };

  page.on('requestfinished', requestListener);

  let actionResult;
  let afterState;
  let screenshot;

  try {
    actionResult = await performAction(page, action, config);
    await page.waitForTimeout(config.mapping.waitAfterActionMs);
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
  } finally {
    page.off('requestfinished', requestListener);
  }

  const classification = classifyAction(action, beforeState, { networkMutations });
  const changed =
    actionResult.performed &&
    (beforeState.fingerprint !== afterState.fingerprint || beforeState.url !== afterState.url || networkMutations.length > 0);

  const edge = {
    id: `edge-${slugify(`${beforeState.url}-${action.selector}-${Date.now()}`)}`,
    observedAt: nowIso(),
    durationMs: Date.now() - startedAt,
    from: {
      url: beforeState.url,
      fingerprint: beforeState.fingerprint,
      route: routeFromUrl(beforeState.url)
    },
    to: {
      url: afterState.url,
      fingerprint: afterState.fingerprint,
      route: routeFromUrl(afterState.url)
    },
    action,
    actionResult,
    semantic: classification,
    networkMutations,
    changed,
    screenshot,
    trail: [...safeArray(stateItem.trail), {
      fromUrl: beforeState.url,
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
  const combined = [...existing, ...generated];

  for (const journey of combined) {
    const key = `${journey.intent}|${journey.entity}|${journey.entryUrl}|${journey.targetUrl || ''}`;
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

    const name = buildJourneyName(semantic.verb, semantic.entity);
    journeys.push({
      id: `journey-${slugify(`${semantic.verb}-${semantic.entity}-${edge.from.route}`)}`,
      name,
      intent: semantic.verb,
      entity: semantic.entity,
      confidence: semantic.confidence,
      entryUrl: edge.trail[0]?.fromUrl || edge.from.url,
      targetUrl: edge.to.url,
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

  return mergeUniqueBy(journeys, (journey) => `${journey.intent}|${journey.entity}|${journey.targetUrl}`);
}

function featureFromEdge(edge) {
  return {
    id: `feature-${slugify(`${edge.semantic.verb}-${edge.semantic.entity}-${edge.from.route}-${Date.now()}`)}`,
    discoveredAt: edge.observedAt,
    journeyId: 'discovery',
    route: edge.from.route,
    verb: edge.semantic.verb,
    entity: edge.semantic.entity,
    actionLabel: edge.semantic.label,
    outcome: edge.changed ? 'state-changed' : 'no-observable-change',
    evidence: {
      screenshot: edge.screenshot,
      from: edge.from.url,
      to: edge.to.url
    }
  };
}

async function runDiscovery(config, paths) {
  const runId = `discover-${Date.now()}`;
  const runDir = path.join(paths.runs, runId);
  ensureDir(runDir);
  ensureDir(path.join(runDir, 'screenshots'));

  const browser = await launchBrowser(config);
  const storagePath = await ensureAuthStorageState(browser, config, paths);
  const context = await browser.newContext({ storageState: storagePath });
  const page = await context.newPage();

  const queue = [{
    url: config.target.baseUrl,
    depth: 0,
    trail: []
  }];
  const visitedStates = new Set();
  const edges = [];

  let knowledge = createKnowledgeBase(readJson(paths.knowledge, createKnowledgeBase()));

  while (queue.length > 0 && visitedStates.size < config.discovery.maxStates) {
    const stateItem = queue.shift();

    await page.goto(stateItem.url, {
      waitUntil: 'domcontentloaded',
      timeout: config.browser.navigationTimeoutMs
    });
    await page.waitForTimeout(400);

    const state = await capturePageState(page);
    const stateKey = stateKeyFromState(state);
    if (visitedStates.has(stateKey)) {
      continue;
    }
    visitedStates.add(stateKey);

    const interactions = await extractInteractiveElements(page, {
      maxElements: config.discovery.maxActionsPerState
    });

    for (const action of interactions.slice(0, config.discovery.maxActionsPerState)) {
      await page.goto(state.url, {
        waitUntil: 'domcontentloaded',
        timeout: config.browser.navigationTimeoutMs
      });

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
        runId
      });

      edges.push(edge);
      appendJsonl(paths.edges, edge);

      knowledge = updateKnowledgeBase(knowledge, edge.semantic, { url: beforeState.url });

      if (
        edge.changed &&
        stateItem.depth < config.discovery.maxDepth &&
        shouldQueueUrl(edge.to.url, config.target.baseUrl, config)
      ) {
        const nextTrail = edge.trail;
        queue.push({
          url: edge.to.url,
          depth: stateItem.depth + 1,
          trail: nextTrail
        });
      }
    }
  }

  const existingJourneys = readJson(paths.journeys, { version: 1, journeys: [] }).journeys || [];
  const generatedJourneys = synthesizeJourneysFromEdges(edges, config);
  const journeys = mergeJourneyCandidates(existingJourneys, generatedJourneys);

  const existingFeatures = readJson(paths.features, { version: 1, features: [] }).features || [];
  const generatedFeatures = edges.map(featureFromEdge);
  const features = mergeUniqueBy([...existingFeatures, ...generatedFeatures], (feature) => {
    return `${feature.route}|${feature.verb}|${feature.entity}|${normalizeText(feature.actionLabel)}`;
  });

  writeJson(paths.knowledge, knowledge);
  writeJson(paths.journeys, { version: 1, generatedAt: nowIso(), journeys });
  writeJson(paths.features, { version: 1, generatedAt: nowIso(), features });
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
    `Discovery visited ${visitedStates.size} unique states and generated ${generatedJourneys.length} journey candidates`,
    { runId, url: config.target.baseUrl }
  );

  await context.close();
  await browser.close();

  updateState(paths, {
    lastCommand: 'discover',
    discovery: {
      completedAt: nowIso(),
      stateCount: visitedStates.size,
      edgeCount: edges.length,
      candidateJourneyCount: generatedJourneys.length
    }
  });

  return {
    runId,
    stateCount: visitedStates.size,
    edgeCount: edges.length,
    generatedJourneys
  };
}

async function clickButtonByText(page, texts = []) {
  for (const text of texts) {
    const button = page
      .locator('button, [role="button"], [type="submit"]')
      .filter({ hasText: new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*$`, 'i') })
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

  await page.goto(step.fromUrl, {
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

async function executeJourney(browser, config, paths, journey, shared) {
  const runId = `journey-${journey.id}-${Date.now()}`;
  const runDir = path.join(paths.runs, runId);
  const screenshotDir = path.join(runDir, 'screenshots');
  ensureDir(runDir);
  ensureDir(screenshotDir);

  const context = await browser.newContext({
    storageState: fs.existsSync(paths.authState) ? paths.authState : undefined
  });
  const page = await context.newPage();

  const localFeatures = [];
  const branchFindings = [];
  const events = [];

  let completedSteps = 0;
  let failed = false;

  for (const step of safeArray(journey.steps).slice(0, config.mapping.maxJourneySteps)) {
    try {
      await page.goto(step.fromUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.browser.navigationTimeoutMs
      });
      await page.waitForTimeout(350);

      const before = await capturePageState(page);
      const action = {
        selector: step.selector,
        tagName: 'button',
        text: step.label,
        ariaLabel: step.label,
        title: step.label
      };

      const actionResult = await performAction(page, action, config);
      await page.waitForTimeout(config.mapping.waitAfterActionMs);

      const after = await capturePageState(page);

      const classification = classifyAction(action, before, { networkMutations: [] });
      const stepScreenshot = await captureScreenshotIfEnabled(
        page,
        config,
        screenshotDir,
        'journey-step',
        after.url,
        step.label
      );

      localFeatures.push({
        id: `feature-${slugify(`${journey.id}-${step.selector}-${Date.now()}`)}`,
        discoveredAt: nowIso(),
        journeyId: journey.id,
        route: routeFromUrl(before.url),
        verb: classification.verb,
        entity: classification.entity,
        actionLabel: classification.label,
        outcome:
          before.fingerprint !== after.fingerprint || before.url !== after.url
            ? 'state-changed'
            : 'no-observable-change',
        evidence: {
          screenshot: stepScreenshot,
          from: before.url,
          to: after.url
        }
      });

      events.push({
        step,
        actionResult,
        before,
        after
      });

      completedSteps += 1;

      if (isDestructiveCandidate(action, config) || step.destructiveHint) {
        const outcomes = await executeDestructiveBranches(page, step, config, { screenshotDir });
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
        error: error.message
      });
      break;
    }
  }

  const status = failed ? 'failed' : completedSteps > 0 ? 'completed' : 'no-op';

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
    branchFindings
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

  const journeysPayload = readJson(paths.journeys, { version: 1, journeys: [] });
  const journeys = safeArray(journeysPayload.journeys);

  if (!journeys.length) {
    await browser.close();
    return { completed: 0, failed: 0, features: [] };
  }

  const shared = {
    knowledge: createKnowledgeBase(readJson(paths.knowledge, createKnowledgeBase()))
  };

  const results = await runInPool(journeys, config.mapping.concurrency, (journey) => {
    return executeJourney(browser, config, paths, journey, shared);
  });

  await browser.close();

  const currentFeatures = readJson(paths.features, { version: 1, features: [] }).features || [];
  const mappedFeatures = results.flatMap((result) => result.localFeatures || []);
  const mergedFeatures = mergeUniqueBy([...currentFeatures, ...mappedFeatures], (feature) => {
    return `${feature.journeyId}|${feature.route}|${feature.verb}|${feature.entity}|${normalizeText(feature.actionLabel)}`;
  });

  const completedJourneyIds = new Set(
    results.filter((result) => result.status === 'completed').map((result) => result.journeyId)
  );

  const failedJourneyIds = new Set(
    results.filter((result) => result.status === 'failed').map((result) => result.journeyId)
  );

  const updatedJourneys = journeys.map((journey) => {
    if (completedJourneyIds.has(journey.id)) {
      return {
        ...journey,
        status: 'completed',
        mappedAt: nowIso()
      };
    }

    if (failedJourneyIds.has(journey.id)) {
      return {
        ...journey,
        status: 'failed',
        mappedAt: nowIso()
      };
    }

    return journey;
  });

  writeJson(paths.knowledge, shared.knowledge);
  writeJson(paths.features, { version: 1, generatedAt: nowIso(), features: mergedFeatures });
  writeJson(paths.journeys, { version: 1, generatedAt: nowIso(), journeys: updatedJourneys });
  fs.writeFileSync(paths.featuresMd, renderFeatureMarkdown(mergedFeatures), 'utf8');
  fs.writeFileSync(paths.journeysMd, renderJourneyMarkdown(updatedJourneys), 'utf8');

  const expectedVsFound = buildExpectedVsFoundReport(shared.knowledge);
  writeJson(paths.expectedVsFound, expectedVsFound);
  fs.writeFileSync(paths.expectedVsFoundMd, renderExpectedVsFoundMarkdown(expectedVsFound), 'utf8');

  const frontier = buildCoverageFrontier({
    journeys: updatedJourneys,
    features: mergedFeatures,
    expectedVsFound
  });
  writeJson(paths.coverageFrontier, frontier);

  if ((expectedVsFound.missing || []).length > 0) {
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

  updateState(paths, {
    lastCommand: 'map',
    mapping: {
      completedAt: nowIso(),
      completedJourneyCount: completed,
      failedJourneyCount: failed
    }
  });

  return {
    completed,
    failed,
    features: mappedFeatures.length,
    expectedCoverage: expectedVsFound.overallCoveragePct
  };
}

function statusSummary(paths) {
  const state = readJson(paths.state, DEFAULT_STATE);
  const journeys = readJson(paths.journeys, { version: 1, journeys: [] }).journeys || [];
  const features = readJson(paths.features, { version: 1, features: [] }).features || [];
  const expected = readJson(paths.expectedVsFound, { overallCoveragePct: 0, missing: [] });

  const summary = {
    state,
    metrics: {
      journeysTotal: journeys.length,
      journeysCompleted: journeys.filter((journey) => journey.status === 'completed').length,
      journeysFailed: journeys.filter((journey) => journey.status === 'failed').length,
      featuresTotal: features.length,
      expectationCoveragePct: expected.overallCoveragePct || 0,
      missingExpectations: safeArray(expected.missing).length
    },
    artifacts: {
      journeys: paths.journeys,
      features: paths.features,
      expectedVsFound: paths.expectedVsFound,
      coverageFrontier: paths.coverageFrontier,
      learnings: paths.learnings
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
