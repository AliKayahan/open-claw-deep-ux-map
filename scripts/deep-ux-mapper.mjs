#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
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
  isDestructiveCandidate,
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
import { createAnthropicClient } from './lib/llm/anthropic-client.mjs';
import { buildScreenContext, extractScreenDiagnostics } from './lib/llm/screen-packager.mjs';
import { normalizePlannerPlan, validatePlannerPlan } from './lib/llm/planner-schema.mjs';
import { collectFormCandidates, chooseFormCandidate, executeFormEpisode } from './lib/form-engine.mjs';
import { detectGates, gateProgress, isGateSatisfied, selectGateActionHints } from './lib/gate-engine.mjs';
import { createLoopGuard, prioritizeInteractions } from './lib/policy/curiosity-policy.mjs';
import {
  createMissionState,
  detectScreenSignals,
  missionProgressSummary,
  proposeMissionActions,
  updateMissionStateFromEvent
} from './lib/mission-engine.mjs';
import { critiqueScreenProgress } from './lib/critic-engine.mjs';

const DEFAULT_CONFIG = {
  version: 3,
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
  llm: {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    maxTokens: 1500,
    temperature: 0.2,
    timeoutMs: 25000,
    maxRetries: 2
  },
  planning: {
    mode: 'llm-first',
    maxActionsPerScreen: 8,
    maxLoopIterationsPerGate: 8,
    requirePlanSchemaValidation: true
  },
  forms: {
    strategy: 'llm-generated',
    maxFieldsPerForm: 14,
    submitHeuristics: ['button', 'enter', 'blur']
  },
  gates: {
    enabled: true,
    maxSatisfyAttempts: 10,
    countPatterns: [
      '(?:at\\s+least|minimum\\s+of)\\s+(\\d+)\\s+([a-z][a-z\\- ]{1,30})',
      'add\\s+(\\d+)\\s+([a-z][a-z\\- ]{1,30})',
      '(\\d+)\\s+(?:remaining|left)\\b',
      'step\\s+(\\d+)\\s+of\\s+(\\d+)'
    ]
  },
  budgets: {
    profile: 'aggressive',
    maxJourneyMinutes: 15,
    maxScreenVisitsPerJourney: 100,
    maxRepeatedActionCount: 5
  },
  mission: {
    minRepeatableCreateTarget: 8,
    maxRepeatableCreateTarget: 10,
    chatTurnsTarget: 3,
    branchExplorationTarget: 6,
    maxMissionRepeat: 4
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
  version: 3,
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
    degradedJourneyCount: 0,
    routeCoveragePct: 0
  }
};

function normalizeStateShape(inputState) {
  const state = inputState || {};
  return {
    ...DEFAULT_STATE,
    ...state,
    version: 3,
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
    journeyProgress: path.join(root, 'journey-progress.jsonl'),
    llmDecisions: path.join(root, 'llm-decisions.jsonl'),
    formLedger: path.join(root, 'form-ledger.jsonl'),
    gateLedger: path.join(root, 'gate-ledger.jsonl'),
    journeyMilestones: path.join(root, 'journey-milestones.jsonl'),
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
    llm: {
      ...DEFAULT_CONFIG.llm,
      ...(loaded.llm || {})
    },
    planning: {
      ...DEFAULT_CONFIG.planning,
      ...(loaded.planning || {})
    },
    forms: {
      ...DEFAULT_CONFIG.forms,
      ...(loaded.forms || {})
    },
    gates: {
      ...DEFAULT_CONFIG.gates,
      ...(loaded.gates || {})
    },
    budgets: {
      ...DEFAULT_CONFIG.budgets,
      ...(loaded.budgets || {})
    },
    mission: {
      ...DEFAULT_CONFIG.mission,
      ...(loaded.mission || {})
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

  if (config.llm?.provider && config.llm.provider !== 'anthropic') {
    errors.push('llm.provider currently supports only "anthropic"');
  }

  if (!['llm-first', 'heuristic-fallback'].includes(config.planning?.mode)) {
    errors.push('planning.mode must be "llm-first" or "heuristic-fallback"');
  }

  if (Number(config.planning?.maxActionsPerScreen) <= 0) {
    errors.push('planning.maxActionsPerScreen must be > 0');
  }

  if (Number(config.gates?.maxSatisfyAttempts) <= 0) {
    errors.push('gates.maxSatisfyAttempts must be > 0');
  }

  if (Number(config.mission?.maxMissionRepeat) <= 0) {
    errors.push('mission.maxMissionRepeat must be > 0');
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
  ensureFile(paths.journeyProgress, '');
  ensureFile(paths.llmDecisions, '');
  ensureFile(paths.formLedger, '');
  ensureFile(paths.gateLedger, '');
  ensureFile(paths.journeyMilestones, '');
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
  const plannedTarget = action?.target || {};

  if (plannedTarget.selector) {
    const byPlanSelector = page.locator(plannedTarget.selector).first();
    if (await byPlanSelector.isVisible().catch(() => false)) {
      return byPlanSelector;
    }
  }

  if (action.selector) {
    const bySelector = page.locator(action.selector).first();
    if (await bySelector.isVisible().catch(() => false)) {
      return bySelector;
    }
  }

  const labels = [plannedTarget.label, plannedTarget.contains, action.text, action.ariaLabel, action.title].filter(Boolean);
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const byButtonText = page
      .locator('button, [role="button"], a, [role="menuitem"], [role="tab"], input, textarea, select')
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

  const actionType = action?.actionType || '';
  if (action.tagName === 'select' || actionType === 'select') {
    const switched = await selectAlternateValue(locator);
    return switched
      ? { performed: true, kind: 'select', reason: 'selected-alternate-option' }
      : { performed: false, reason: 'select-no-options' };
  }

  if (actionType === 'toggle') {
    const toggled = await locator.evaluate((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      if (node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type)) {
        node.click();
        return true;
      }
      node.click();
      return true;
    }).catch(() => false);

    return toggled ? { performed: true, kind: 'toggle' } : { performed: false, reason: 'toggle-failed' };
  }

  const inputType = String(action.type || '').toLowerCase();
  if (action.tagName === 'input' && ['checkbox', 'radio'].includes(inputType) && actionType !== 'fill') {
    await locator.click({ timeout: config.browser.actionTimeoutMs });
    return { performed: true, kind: 'toggle' };
  }

  if (['fill'].includes(actionType) || action.tagName === 'input' || action.tagName === 'textarea') {
    const plannedValue =
      action?.inputValue ??
      action?.inputValuePolicy?.value ??
      `test-${Date.now().toString(36).slice(-4)}`;
    await locator.fill(String(plannedValue), { timeout: config.browser.actionTimeoutMs });
    return { performed: true, kind: 'fill', sample: String(plannedValue).slice(0, 80) };
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

function buildHeuristicPlan(screenContext, interactions, gates, options = {}) {
  const prioritized = prioritizeInteractions(interactions, {
    visitedSignatures: options.visitedSignatures || new Set(),
    entityHint: gates[0]?.entityHint || ''
  });

  const toTarget = (action) => ({
    selector: action.selector,
    label: action.text || action.ariaLabel || action.title || '',
    contains: action.contextText || ''
  });

  const priorityActions = [];

  for (const gate of gates.slice(0, 2)) {
    const candidates = selectGateActionHints(gate, prioritized);
    if (candidates[0]) {
      priorityActions.push({
        actionType: gate.gateType === 'wizard_step' ? 'next-step' : 'add-row',
        target: toTarget(candidates[0]),
        repeatPolicy: {
          times: 1,
          max: Math.max(1, Math.min(6, Number(gate.targetCount || 3))),
          untilCondition: `gate:${gate.gateType}`
        }
      });
    }
  }

  for (const action of prioritized.slice(0, 4)) {
    const actionText = normalizeText(`${action.text} ${action.ariaLabel} ${action.title}`);
    const actionType = action.tagName === 'select'
      ? 'select'
      : action.tagName === 'input' || action.tagName === 'textarea'
        ? 'fill'
        : /next|continue|start/.test(actionText)
          ? 'next-step'
          : /menu|more|ellipsis|options/.test(actionText)
            ? 'open-menu'
            : 'click';

    priorityActions.push({
      actionType,
      target: toTarget(action),
      repeatPolicy: {
        times: 1,
        max: 1,
        untilCondition: ''
      }
    });
  }

  return normalizePlannerPlan({
    screenIntent: `heuristic:${screenContext.headline || screenContext.title || 'screen'}`,
    gates,
    priorityActions,
    expectedOutcome: 'advance-flow',
    fallbackAction: priorityActions[0] || null
  });
}

function resolvePlannedAction(planAction, interactions) {
  const normalizedLabel = normalizeText(
    `${planAction?.target?.label || ''} ${planAction?.target?.contains || ''}`
  );

  if (planAction?.target?.selector) {
    const bySelector = safeArray(interactions).find((item) => item.selector === planAction.target.selector);
    if (bySelector) {
      return {
        ...bySelector,
        actionType: planAction.actionType,
        repeatPolicy: planAction.repeatPolicy || { times: 1, max: 1 },
        inputValuePolicy: planAction.inputValuePolicy || {}
      };
    }
  }

  if (normalizedLabel) {
    const byLabel = safeArray(interactions).find((item) => {
      const haystack = normalizeText(`${item.text} ${item.ariaLabel} ${item.title} ${item.contextText}`);
      return haystack.includes(normalizedLabel);
    });
    if (byLabel) {
      return {
        ...byLabel,
        actionType: planAction.actionType,
        repeatPolicy: planAction.repeatPolicy || { times: 1, max: 1 },
        inputValuePolicy: planAction.inputValuePolicy || {}
      };
    }
  }

  const fallback = safeArray(interactions)[0];
  if (!fallback) {
    return null;
  }

  return {
    ...fallback,
    actionType: planAction.actionType || 'click',
    repeatPolicy: planAction.repeatPolicy || { times: 1, max: 1 },
    inputValuePolicy: planAction.inputValuePolicy || {}
  };
}

function applyPlannedValuePolicy(action, screenContext) {
  if (!action) {
    return action;
  }

  if (action.actionType !== 'fill') {
    return action;
  }

  const policyValue = action.inputValuePolicy?.value;
  if (policyValue != null && policyValue !== '') {
    return {
      ...action,
      inputValue: String(policyValue)
    };
  }

  const label = normalizeText(`${action.text} ${action.ariaLabel} ${action.placeholder}`);
  let value = `sample-${Date.now().toString(36).slice(-5)}`;

  if (/email/.test(label)) {
    value = `mapbot+${Date.now().toString(36).slice(-5)}@example.com`;
  } else if (/name|title/.test(label)) {
    value = `Map Item ${Date.now().toString(36).slice(-4)}`;
  } else if (/search|filter/.test(label)) {
    value = 'test criteria';
  } else if (/password/.test(label)) {
    value = 'Passw0rd!';
  } else if (/company|workspace/.test(label)) {
    value = `Workspace ${Date.now().toString(36).slice(-4)}`;
  }

  if (screenContext?.journey?.entity && /requirement|item|product/.test(screenContext.journey.entity)) {
    value = `${screenContext.journey.entity} ${Date.now().toString(36).slice(-4)}`;
  }

  return {
    ...action,
    inputValue: value
  };
}

function recordMilestone(paths, payload) {
  appendJsonl(paths.journeyMilestones, {
    at: nowIso(),
    ...payload
  });
}

async function buildPlanFromScreen(params) {
  const {
    plannerClient,
    config,
    screenContext,
    interactions,
    gates,
    paths,
    runMeta
  } = params;

  let plan = null;
  let degradedPlanning = false;
  let llmError = '';
  let llmUsage = {};
  let source = 'heuristic';
  let requestHash = '';

  if (config.planning.mode === 'llm-first') {
    if (!plannerClient?.available) {
      degradedPlanning = true;
      llmError = `missing_api_key:${config.llm.apiKeyEnv}`;
    } else {
      const llmResult = await plannerClient.generateScreenPlan(screenContext);
      requestHash = llmResult.requestHash || crypto.createHash('sha256').update(screenContext.screenDigest || '').digest('hex');
      llmUsage = llmResult.usage || {};

      if (llmResult.ok) {
        const validation = validatePlannerPlan(llmResult.json, {
          requirePlanSchemaValidation: config.planning.requirePlanSchemaValidation
        });

        if (validation.ok) {
          plan = validation.plan;
          source = 'llm';
        } else {
          llmError = `invalid_plan_schema:${validation.errors.join('; ')}`;
          if (config.planning.requirePlanSchemaValidation) {
            degradedPlanning = true;
          }
        }
      } else {
        llmError = llmResult.error || 'llm-plan-error';
        degradedPlanning = true;
      }
    }
  }

  if (!plan) {
    plan = buildHeuristicPlan(screenContext, interactions, gates, {
      visitedSignatures: params.visitedSignatures
    });
    source = source === 'llm' ? source : 'heuristic';
  }

  appendJsonl(paths.llmDecisions, {
    at: nowIso(),
    runId: runMeta.runId,
    journeyId: runMeta.journeyId,
    url: screenContext.url,
    source,
    requestHash,
    degradedPlanning,
    llmError,
    usage: llmUsage,
    planSummary: {
      screenIntent: plan.screenIntent,
      actionCount: safeArray(plan.priorityActions).length,
      gateCount: safeArray(plan.gates).length
    }
  });

  return {
    plan,
    source,
    degradedPlanning,
    llmError
  };
}

function mergePlanActions(actionGroups, maxActions = 10) {
  const merged = [];
  const seen = new Set();

  for (const group of safeArray(actionGroups)) {
    for (const action of safeArray(group)) {
      const key = `${action?.actionType || ''}|${action?.target?.selector || ''}|${normalizeText(
        `${action?.target?.label || ''} ${action?.target?.contains || ''}`
      )}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(action);
      if (merged.length >= maxActions) {
        return merged;
      }
    }
  }

  return merged;
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
  const plannerClient = createAnthropicClient(config.llm);
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

      const diagnostics = await extractScreenDiagnostics(page);
      const screenContext = buildScreenContext({
        state,
        interactions: [],
        diagnostics,
        routeTemplate: template,
        entityRegistry,
        recentEvents: [],
        journey: null
      });
      const formCandidates = await collectFormCandidates(page, { maxForms: 3 });
      const form = chooseFormCandidate(formCandidates);
      if (form && safeArray(form.fields).length > 0) {
        const formOutcome = await executeFormEpisode({
          page,
          form,
          plannerClient,
          screenContext,
          config,
          ledgerPath: paths.formLedger,
          runMeta: {
            runId,
            journeyId: `discovery-${contextName}`
          },
          appendJsonl
        });

        if (formOutcome.ok) {
          const afterFormState = await capturePageState(page);
          routeUniverse = upsertRouteObservation(routeUniverse, afterFormState.url, {
            context: contextName,
            state: 'visited'
          });
          entityRegistry = upsertEntityValues(entityRegistry, extractEntityValuesFromUrl(afterFormState.url), {
            source: `discovery-form:${contextName}`
          });
          if (
            shouldQueueUrl(afterFormState.url, config.target.baseUrl, config) &&
            stateItem.depth < config.discovery.maxDepth
          ) {
            queue.push({
              url: afterFormState.url,
              depth: stateItem.depth + 1,
              trail: stateItem.trail
            });
          }
        }
      }

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

async function runPlannedScreenProgression(params) {
  const {
    page,
    config,
    paths,
    plannerClient,
    journey,
    shared,
    runMeta,
    screenshotDir,
    contextName,
    recentEvents,
    missionState
  } = params;

  const visitedSignatures = new Set();
  const loopGuard = createLoopGuard({
    maxRepeatedActionCount: config.budgets.maxRepeatedActionCount,
    maxNoopStreak: Math.max(2, Math.ceil(config.planning.maxActionsPerScreen / 2))
  });

  const milestones = [];
  const localFeatures = [];
  const edges = [];
  let gatesSatisfied = 0;
  let blockedReason = '';
  let degradedPlanningUsed = false;

  for (let loopIndex = 0; loopIndex < config.planning.maxActionsPerScreen; loopIndex += 1) {
    const beforeState = await capturePageState(page);
    const interactions = await extractInteractiveElements(page, {
      maxElements: config.discovery.maxActionsPerState
    });
    const diagnostics = await extractScreenDiagnostics(page);
    const routeTemplate = routeTemplateFromUrl(beforeState.url).template;

    const screenContext = buildScreenContext({
      state: beforeState,
      interactions,
      diagnostics,
      routeTemplate,
      entityRegistry: shared.entityRegistry,
      recentEvents,
      journey
    });

    const gates = config.gates.enabled ? detectGates({ state: beforeState, diagnostics, interactions }, config) : [];
    for (const gate of gates) {
      shared.copyInventory = addCopyEntry(shared.copyInventory, {
        url: beforeState.url,
        context: contextName,
        text: gate.signal
      });
    }

    const formCandidates = await collectFormCandidates(page, { maxForms: 4 });
    const form = chooseFormCandidate(formCandidates);

    if (form && safeArray(form.fields).length > 0) {
      const formOutcome = await executeFormEpisode({
        page,
        form,
        plannerClient,
        screenContext,
        config,
        ledgerPath: paths.formLedger,
        runMeta,
        appendJsonl
      });

      if (formOutcome.ok) {
        milestones.push({
          kind: 'form-episode',
          fieldsFilled: formOutcome.fieldsFilled,
          submitted: formOutcome.submitted
        });

        recordMilestone(paths, {
          runId: runMeta.runId,
          journeyId: runMeta.journeyId,
          kind: 'form-episode',
          url: beforeState.url,
          details: formOutcome
        });

        const afterState = await capturePageState(page);
        const changed = beforeState.fingerprint !== afterState.fingerprint || beforeState.url !== afterState.url;
        loopGuard.register(`form:${form.formSelector}`, changed);
      }
    }

    const planOutcome = await buildPlanFromScreen({
      plannerClient,
      config,
      screenContext,
      interactions,
      gates,
      paths,
      runMeta,
      visitedSignatures
    });

    degradedPlanningUsed = degradedPlanningUsed || planOutcome.degradedPlanning;
    const plan = planOutcome.plan;
    const screenSignals = detectScreenSignals(screenContext, interactions, gates);
    const missionOutcome = proposeMissionActions({
      missionState,
      screenContext,
      interactions,
      gates,
      config: config.mission,
      recentEvents,
      screenSignals
    });
    const criticOutcome = critiqueScreenProgress({
      recentEvents,
      interactions,
      gates
    });

    appendJsonl(paths.journeyMilestones, {
      at: nowIso(),
      runId: runMeta.runId,
      journeyId: runMeta.journeyId,
      kind: 'screen-analysis',
      url: beforeState.url,
      details: {
        signals: screenSignals,
        missionNotes: missionOutcome.notes,
        criticBlockedHypothesis: criticOutcome.blockedHypothesis || ''
      }
    });

    let executedAny = false;

    const candidatePlanActions = mergePlanActions(
      [
        missionOutcome.actions,
        plan.priorityActions,
        criticOutcome.actions
      ],
      config.planning.maxLoopIterationsPerGate
    );

    for (const planAction of safeArray(candidatePlanActions).slice(0, config.planning.maxLoopIterationsPerGate)) {
      const resolved = resolvePlannedAction(planAction, interactions);
      if (!resolved) {
        continue;
      }

      const action = applyPlannedValuePolicy(resolved, screenContext);
      const signature = action.key || `${action.selector}|${action.actionType || ''}`;
      if (visitedSignatures.has(signature) && (planAction.repeatPolicy?.max || 1) <= 1) {
        continue;
      }

      visitedSignatures.add(signature);
      const repeatMax = Math.max(
        1,
        Math.min(
          12,
          Number(config.gates.maxSatisfyAttempts || 10),
          Number(planAction.repeatPolicy?.max || planAction.repeatPolicy?.times || 1)
        )
      );

      for (let repeatIndex = 0; repeatIndex < repeatMax; repeatIndex += 1) {
        const edge = await probeActionTransition({
          page,
          stateItem: { trail: [] },
          beforeState: await capturePageState(page),
          action,
          config,
          runOutputDir: screenshotDir,
          minConfidence: config.semantics.minConfidence,
          learningsPath: paths.learnings,
          lockPath: paths.lock,
          runId: runMeta.runId,
          contextName
        });

        edges.push(edge);
        appendJsonl(paths.edges, edge);
        executedAny = executedAny || edge.actionResult?.performed;

        shared.entityRegistry = upsertEntityValues(shared.entityRegistry, edge.extractedEntities || {}, {
          source: `planner:${journey.id}`
        });
        shared.routeUniverse = upsertRouteObservation(shared.routeUniverse, edge.from.url, {
          context: contextName,
          state: 'executed'
        });
        shared.routeUniverse = upsertRouteObservation(shared.routeUniverse, edge.to.url, {
          context: contextName,
          state: edge.changed ? 'visited' : 'observed'
        });
        shared.knowledge = updateKnowledgeBase(shared.knowledge, edge.semantic, { url: edge.from.url });

        const feature = featureFromEdge(edge);
        feature.journeyId = journey.id;
        localFeatures.push(feature);

        const event = {
          at: nowIso(),
          kind: edge.actionResult?.kind || edge.action?.actionType || 'click',
          actionLabel: edge.semantic?.label || action.text || action.ariaLabel || action.selector,
          entity: edge.semantic?.entity || journey.entity,
          changed: edge.changed
        };
        recentEvents.push(event);
        updateMissionStateFromEvent(missionState, event);

        const gateChecks = detectGates(
          {
            state: await capturePageState(page),
            diagnostics: await extractScreenDiagnostics(page),
            interactions: await extractInteractiveElements(page, { maxElements: 30 })
          },
          config
        );
        for (const gate of gates) {
          const progressCount = gateProgress(gate, { interactions, events: recentEvents });
          const satisfied = isGateSatisfied(gate, progressCount);
          appendJsonl(paths.gateLedger, {
            at: nowIso(),
            runId: runMeta.runId,
            journeyId: runMeta.journeyId,
            url: page.url(),
            gate,
            progressCount,
            satisfied
          });

          if (satisfied) {
            gatesSatisfied += 1;
            recordMilestone(paths, {
              runId: runMeta.runId,
              journeyId: runMeta.journeyId,
              kind: 'gate-satisfied',
              url: page.url(),
              details: {
                gate,
                progressCount
              }
            });
          }
        }

        const guard = loopGuard.register(signature, edge.changed);
        if (guard.shouldStop) {
          blockedReason = guard.reason;
          break;
        }

        if (safeArray(gateChecks).length === 0 && edge.changed) {
          break;
        }
      }

      if (blockedReason) {
        break;
      }
    }

    if (!executedAny) {
      if (gates.length > 0) {
        blockedReason = blockedReason || `gate_unresolved:${gates[0].gateType}`;
      } else if (criticOutcome.shouldBranch && criticOutcome.blockedHypothesis) {
        blockedReason = blockedReason || `critic:${criticOutcome.blockedHypothesis}`;
      }
      break;
    }

    if (blockedReason) {
      break;
    }
  }

  return {
    edges,
    localFeatures,
    milestones,
    gatesSatisfied,
    blockedReason,
    degradedPlanningUsed,
    missionSummary: missionProgressSummary(missionState)
  };
}

function missingEntitiesForJourney(journey, entityRegistry) {
  return safeArray(journey.requiredEntities).filter((key) => !entityRegistry?.latestValues?.[key]);
}

async function executeJourney(browser, config, paths, journey, shared, plannerClient) {
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
  const missionState = createMissionState(config.mission);
  let milestonesCompleted = 0;
  let gatesSatisfied = 0;
  let blockedReason = '';
  let degradedPlanning = false;
  let missionSummary = missionProgressSummary(missionState);

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

      const progression = await runPlannedScreenProgression({
        page,
        config,
        paths,
        plannerClient,
        journey,
        shared,
        runMeta: {
          runId,
          journeyId: journey.id
        },
        screenshotDir,
        contextName: journey.context || 'auth',
        recentEvents: events,
        missionState
      });

      degradedPlanning = degradedPlanning || progression.degradedPlanningUsed;
      blockedReason = blockedReason || progression.blockedReason;
      milestonesCompleted += safeArray(progression.milestones).length;
      gatesSatisfied += Number(progression.gatesSatisfied || 0);
      localFeatures.push(...safeArray(progression.localFeatures));
      missionSummary = progression.missionSummary || missionSummary;

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

      const feature = {
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
      };
      localFeatures.push(feature);

      events.push({
        step,
        status: 'ok',
        fromUrl: before.url,
        toUrl: after.url || page.url(),
        producedEntities: edge.producedEntityKeys,
        actionLabel: feature.actionLabel,
        kind: edge.actionResult?.kind || 'click',
        entity: feature.entity
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
      blockedReason = blockedReason || `step_error:${error.message.slice(0, 120)}`;
      events.push({
        step,
        status: 'error',
        error: error.message
      });
      break;
    }
  }

  let status = blocked ? 'blocked' : failed ? 'failed' : completedSteps > 0 ? 'completed' : 'no-op';
  if (degradedPlanning && status === 'completed') {
    status = 'degraded_planning';
  }
  if (status === 'no-op' && blockedReason) {
    status = 'blocked';
  }

  await appendLearning(
    paths.learnings,
    paths.lock,
    status === 'completed' ? 'Confirmed behaviors' : 'Open hypotheses',
    `Journey ${journey.id} finished with status=${status}, completedSteps=${completedSteps}, milestones=${milestonesCompleted}, gatesSatisfied=${gatesSatisfied}`,
    { runId, journeyId: journey.id, url: journey.entryUrl }
  );

  writeJson(path.join(runDir, 'journey-run.json'), {
    runId,
    journeyId: journey.id,
    status,
    completedSteps,
    milestonesCompleted,
    gatesSatisfied,
    blockedReason,
    degradedPlanning,
    missionSummary,
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
    milestonesCompleted,
    gatesSatisfied,
    blockedReason,
    degradedPlanning,
    missionSummary,
    localFeatures,
    branchFindings,
    missingEntities: status === 'blocked' ? missingEntitiesForJourney(journey, shared.entityRegistry) : []
  };
}

async function runInPool(items, concurrency, worker, onResult = null) {
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
      if (onResult) {
        await onResult(item, output);
      }
    }
  });

  await Promise.all(workers);
  return results;
}

async function runJourneyMapping(config, paths) {
  const browser = await launchBrowser(config);
  await ensureAuthStorageState(browser, config, paths);
  const plannerClient = createAnthropicClient(config.llm);

  const journeysPayload = readJson(paths.journeys, { version: 2, journeys: [] });
  const journeys = safeArray(journeysPayload.journeys);

  if (!journeys.length) {
    await browser.close();
    return { completed: 0, degraded: 0, failed: 0, blocked: 0, features: 0 };
  }

  const shared = {
    knowledge: createKnowledgeBase(readJson(paths.knowledge, createKnowledgeBase())),
    entityRegistry: createEntityRegistry(readJson(paths.entityRegistry, createEntityRegistry())),
    routeUniverse: createRouteUniverse(readJson(paths.routeUniverse, createRouteUniverse())),
    copyInventory: createCopyInventory(readJson(paths.copyInventory, createCopyInventory()))
  };

  const pending = [...journeys];
  const results = [];
  let safetyIterations = 0;
  let completedReportCount = 0;

  const emitJourneyProgress = (journey, result) => {
    completedReportCount += 1;

    const startPoint = journey.entryTemplate || journey.entryUrl || '';
    const endPoint = journey.targetTemplate || journey.targetUrl || '';
    const depth = safeArray(journey.steps).length;

    const event = {
      at: nowIso(),
      type: 'journey-complete',
      sequence: completedReportCount,
      totalJourneys: journeys.length,
      journeyId: journey.id,
      journeyName: journey.name,
      status: result.status,
      depth,
      completedSteps: result.completedSteps || 0,
      milestonesCompleted: Number(result.milestonesCompleted || 0),
      gatesSatisfied: Number(result.gatesSatisfied || 0),
      blockedReason: result.blockedReason || '',
      missionProgressPct: Number(result.missionSummary?.progressPct || 0),
      missionCompletedGoals: safeArray(result.missionSummary?.completedGoals),
      start: startPoint,
      end: endPoint,
      missingEntities: safeArray(result.missingEntities)
    };

    appendJsonl(paths.journeyProgress, event);
    console.log(JSON.stringify(event, null, 2));
  };

  while (pending.length > 0 && safetyIterations < 200) {
    safetyIterations += 1;

    const ready = pending.filter((journey) => missingEntitiesForJourney(journey, shared.entityRegistry).length === 0);

    if (ready.length === 0) {
      for (const journey of pending) {
        const blockedResult = {
          journeyId: journey.id,
          status: 'blocked',
          completedSteps: 0,
          milestonesCompleted: 0,
          gatesSatisfied: 0,
          blockedReason: `missing_entities:${missingEntitiesForJourney(journey, shared.entityRegistry).join(',')}`,
          degradedPlanning: false,
          localFeatures: [],
          branchFindings: [],
          missingEntities: missingEntitiesForJourney(journey, shared.entityRegistry)
        };
        results.push(blockedResult);
        emitJourneyProgress(journey, blockedResult);
      }
      break;
    }

    const batch = ready.slice(0, Math.max(1, config.mapping.concurrency));
    const batchResults = await runInPool(
      batch,
      config.mapping.concurrency,
      (journey) => executeJourney(browser, config, paths, journey, shared, plannerClient),
      (journey, result) => emitJourneyProgress(journey, result)
    );

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
      lastMissingEntities: missing,
      milestonesCompleted: Number(result.milestonesCompleted || 0),
      gatesSatisfied: Number(result.gatesSatisfied || 0),
      blockedReason: result.blockedReason || '',
      degradedPlanning: Boolean(result.degradedPlanning),
      missionSummary: result.missionSummary || null
    };
  });

  const expectedVsFound = buildExpectedVsFoundReport(shared.knowledge);
  const routeCoverage = buildRouteCoverage(shared.routeUniverse);
  const journeyGraph = buildJourneyDependencyGraph(updatedJourneys, shared.routeUniverse, shared.entityRegistry);
  const criticalPaths = buildCriticalPaths(updatedJourneys);
  const e2eSpecs = buildE2ESpecs(updatedJourneys, shared.entityRegistry);
  const smokeSuite = buildSmokeSuite(e2eSpecs, criticalPaths);
  const copyIssues = buildCopyIssueHints(shared.copyInventory);

  writeJson(paths.knowledge, shared.knowledge);
  writeJson(paths.entityRegistry, shared.entityRegistry);
  writeJson(paths.routeUniverse, shared.routeUniverse);
  writeJson(paths.copyInventory, shared.copyInventory);
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
  const degraded = results.filter((item) => item.status === 'degraded_planning').length;
  const failed = results.filter((item) => item.status === 'failed').length;
  const blocked = results.filter((item) => item.status === 'blocked').length;

  updateState(paths, {
    lastCommand: 'map',
    mapping: {
      completedAt: nowIso(),
      completedJourneyCount: completed,
      failedJourneyCount: failed,
      blockedJourneyCount: blocked,
      degradedJourneyCount: degraded,
      routeCoveragePct: routeCoverage.coveragePct
    }
  });

  return {
    completed,
    degraded,
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
      journeysDegradedPlanning: journeys.filter((journey) => journey.status === 'degraded_planning').length,
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
      copyIssues: paths.copyIssues,
      journeyProgress: paths.journeyProgress,
      llmDecisions: paths.llmDecisions,
      formLedger: paths.formLedger,
      gateLedger: paths.gateLedger,
      journeyMilestones: paths.journeyMilestones
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
