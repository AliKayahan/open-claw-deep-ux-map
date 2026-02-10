import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { collectFormCandidates, chooseFormCandidate, executeFormEpisode } from '../../scripts/lib/form-engine.mjs';
import { capturePageState, extractInteractiveElements } from '../../scripts/lib/page-utils.mjs';
import { extractScreenDiagnostics } from '../../scripts/lib/llm/screen-packager.mjs';
import { detectGates, selectGateActionHints } from '../../scripts/lib/gate-engine.mjs';
import { appendJsonl } from '../../scripts/lib/fs-utils.mjs';

function createServer(html) {
  const server = http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`
      });
    });
  });
}

test('form episode populates workspace name and unlocks delete action', async () => {
  const fixture = await createServer(`<!doctype html>
  <html>
    <body>
      <h1>Create Workspace</h1>
      <form id="workspace-form">
        <label for="workspaceName">Workspace Name</label>
        <input id="workspaceName" name="workspaceName" placeholder="Workspace Name" required />
        <button type="submit" id="createBtn" disabled>Create Workspace</button>
      </form>
      <button id="deleteBtn" style="display:none">Delete Workspace</button>
      <script>
        const input = document.getElementById('workspaceName');
        const createBtn = document.getElementById('createBtn');
        const deleteBtn = document.getElementById('deleteBtn');
        input.addEventListener('input', () => {
          createBtn.disabled = input.value.trim().length < 3;
        });
        document.getElementById('workspace-form').addEventListener('submit', (event) => {
          event.preventDefault();
          deleteBtn.style.display = 'inline-block';
        });
      </script>
    </body>
  </html>`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duxmap-'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });

  const forms = await collectFormCandidates(page, { maxForms: 3 });
  const form = chooseFormCandidate(forms);
  assert.ok(form);

  const result = await executeFormEpisode({
    page,
    form,
    plannerClient: { available: false },
    screenContext: { url: fixture.url, title: 'Create Workspace', headline: 'Create Workspace' },
    config: {
      browser: { actionTimeoutMs: 3000 },
      forms: { strategy: 'llm-generated', submitHeuristics: ['button', 'enter'] }
    },
    ledgerPath: path.join(tmpDir, 'form-ledger.jsonl'),
    runMeta: { runId: 'test', journeyId: 'journey-form' },
    appendJsonl
  });

  assert.equal(result.ok, true);
  const deleteVisible = await page.locator('#deleteBtn').isVisible();
  assert.equal(deleteVisible, true);

  await page.close();
  await browser.close();
  fixture.server.close();
});

test('gate hints drive repeated add actions until next step unlocks', async () => {
  const fixture = await createServer(`<!doctype html>
  <html>
    <body>
      <h1>Specification Builder</h1>
      <p id="gateCopy">Add at least 3 requirements to continue</p>
      <button id="addReq">Add Requirement</button>
      <button id="nextBtn" disabled>Product Discovery</button>
      <p id="counter">0 requirements added</p>
      <script>
        let count = 0;
        const addReq = document.getElementById('addReq');
        const nextBtn = document.getElementById('nextBtn');
        const counter = document.getElementById('counter');
        addReq.addEventListener('click', () => {
          count += 1;
          counter.textContent = count + ' requirements added';
          if (count >= 3) {
            nextBtn.disabled = false;
            document.getElementById('gateCopy').textContent = 'Ready to continue';
          }
        });
      </script>
    </body>
  </html>`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });

  for (let i = 0; i < 4; i += 1) {
    const state = await capturePageState(page);
    const interactions = await extractInteractiveElements(page, { maxElements: 20 });
    const diagnostics = await extractScreenDiagnostics(page);
    const gates = detectGates({ state, diagnostics, interactions }, { gates: { countPatterns: [] } });

    if (gates.length === 0) {
      break;
    }

    const hints = selectGateActionHints(gates[0], interactions);
    assert.ok(hints.length > 0);
    const candidate = hints[0];
    await page.locator(candidate.selector).first().click();
  }

  const unlocked = await page.locator('#nextBtn').isEnabled();
  assert.equal(unlocked, true);

  await page.close();
  await browser.close();
  fixture.server.close();
});
