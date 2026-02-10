import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFormPromptContext, chooseFormCandidate } from '../scripts/lib/form-engine.mjs';

test('chooseFormCandidate prefers form with more required fields', () => {
  const forms = [
    {
      formSelector: '#a',
      fieldCount: 3,
      fields: [{ required: false }, { required: false }, { required: false }]
    },
    {
      formSelector: '#b',
      fieldCount: 2,
      fields: [{ required: true }, { required: true }]
    }
  ];

  const chosen = chooseFormCandidate(forms);
  assert.equal(chosen.formSelector, '#b');
});

test('buildFormPromptContext returns compact context', () => {
  const form = {
    formSelector: '#form',
    fieldCount: 1,
    fields: [
      {
        selector: '#name',
        name: 'name',
        tagName: 'input',
        type: 'text',
        label: 'Workspace Name',
        placeholder: 'Name',
        required: true
      }
    ]
  };

  const screen = {
    url: 'https://example.com/workspace/new',
    title: 'Create Workspace',
    headline: 'Create Workspace'
  };

  const ctx = buildFormPromptContext(form, screen);
  assert.equal(ctx.form.fields.length, 1);
  assert.equal(ctx.form.fields[0].key, 'name');
});
