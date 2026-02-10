import crypto from 'node:crypto';

function extractJsonBlock(text = '') {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }

  return '';
}

function parseJsonFromText(text = '') {
  const jsonLike = extractJsonBlock(text);
  if (!jsonLike) {
    throw new Error('No JSON payload found in LLM response');
  }

  try {
    return JSON.parse(jsonLike);
  } catch (error) {
    throw new Error(`Invalid JSON payload from LLM: ${error.message}`);
  }
}

function withDefaults(config = {}) {
  return {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    maxTokens: 1_500,
    temperature: 0.2,
    timeoutMs: 25_000,
    maxRetries: 2,
    endpoint: 'https://api.anthropic.com/v1/messages',
    ...config
  };
}

async function withTimeout(promise, timeoutMs) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`LLM timeout after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

export function createAnthropicClient(configInput = {}) {
  const config = withDefaults(configInput);
  const apiKey = process.env[config.apiKeyEnv] || '';

  async function requestJson({ system, user, schemaName }) {
    if (!apiKey) {
      return {
        ok: false,
        degraded: true,
        error: `Missing API key in env ${config.apiKeyEnv}`
      };
    }

    const payload = {
      model: config.model,
      max_tokens: Number(config.maxTokens || 1500),
      temperature: Number(config.temperature ?? 0.2),
      system,
      messages: [{ role: 'user', content: user }]
    };

    const requestHash = crypto
      .createHash('sha256')
      .update(`${schemaName}|${system}|${user}`)
      .digest('hex');

    let attempt = 0;
    let lastError = null;

    while (attempt <= Number(config.maxRetries || 0)) {
      attempt += 1;
      try {
        const response = await withTimeout(
          fetch(config.endpoint, {
            method: 'POST',
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json'
            },
            body: JSON.stringify(payload)
          }),
          Number(config.timeoutMs || 25_000)
        );

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`Anthropic request failed (${response.status}): ${body.slice(0, 400)}`);
        }

        const parsed = await response.json();
        const contentText = (parsed.content || [])
          .filter((item) => item?.type === 'text')
          .map((item) => item.text || '')
          .join('\n');

        const json = parseJsonFromText(contentText);
        return {
          ok: true,
          degraded: false,
          json,
          requestHash,
          rawText: contentText,
          usage: parsed.usage || {}
        };
      } catch (error) {
        lastError = error;
      }
    }

    return {
      ok: false,
      degraded: true,
      requestHash,
      error: lastError?.message || 'Unknown Anthropic client error'
    };
  }

  async function generateScreenPlan(screenContext) {
    const system = [
      'You are a web exploration planner for a platform-agnostic UX mapper.',
      'Return ONLY JSON. No prose.',
      'Prefer actions that unlock deeper states and hidden flows.',
      'Infer gates from disabled actions and numeric requirements.'
    ].join(' ');

    const user = [
      'Create an action plan JSON using schema "screen-plan-v1".',
      'Allowed actionType: click, fill, select, toggle, submit, add-row, next-step, open-menu.',
      'Allowed gateType: count, min_fields, wizard_step, required_selection, dependency.',
      'Input context:',
      JSON.stringify(screenContext)
    ].join('\n');

    return requestJson({ system, user, schemaName: 'screen-plan-v1' });
  }

  async function generateFormValues(formContext) {
    const system = [
      'You generate realistic, safe form values for test/staging UX mapping.',
      'Return ONLY JSON. No prose.',
      'Do not include secrets or production PII.'
    ].join(' ');

    const user = [
      'Create JSON using schema "form-values-v1" with keys:',
      '{ "values": {"<fieldKey>": "<value>"}, "submit": true|false }',
      'Input context:',
      JSON.stringify(formContext)
    ].join('\n');

    return requestJson({ system, user, schemaName: 'form-values-v1' });
  }

  return {
    provider: config.provider,
    model: config.model,
    available: Boolean(apiKey),
    config,
    generateScreenPlan,
    generateFormValues
  };
}
