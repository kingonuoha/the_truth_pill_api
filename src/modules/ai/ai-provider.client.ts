import { Injectable, UnprocessableEntityException } from '@nestjs/common';

/**
 * The provider-call surface the AI module consumes. `HttpAiProviderClient` is
 * the only implementation; it is injectable so a test can stub it (live
 * provider calls are ⏳ PENDING — no key round-trip in the e2e harness).
 *
 * DEV-015 / DEV-053: the provider key is a function argument used only in the
 * outbound request. It is never logged, never attached to an error, and a
 * provider error that could echo the Gemini `?key=` URL is replaced with a
 * generic message (Hard Rule 4).
 */
export interface ProviderGenerationInput {
  provider: string;
  apiKey: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
}

export interface ConnectionResult {
  success: boolean;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A stable, key-free failure message for every provider call. */
const PROVIDER_ERROR = 'AI provider request failed';
const UNSUPPORTED_PROVIDER = 'Unsupported provider';

@Injectable()
export class HttpAiProviderClient {
  async fetchModels(provider: string, apiKey: string): Promise<string[]> {
    if (provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) throw new UnprocessableEntityException(PROVIDER_ERROR);
      const data: unknown = await response.json();
      const rows = asRecords(isRecord(data) ? data.data : undefined);
      return rows
        .map((row) => readString(row.id))
        .filter((id): id is string => id !== null)
        .filter((id) => id.startsWith('gpt-') || id.startsWith('o1-'))
        .sort();
    }

    if (provider === 'gemini') {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      );
      if (!response.ok) throw new UnprocessableEntityException(PROVIDER_ERROR);
      const data: unknown = await response.json();
      const rows = asRecords(isRecord(data) ? data.models : undefined);
      return rows
        .filter((row) => {
          const methods = row.supportedGenerationMethods;
          return Array.isArray(methods) && methods.includes('generateContent');
        })
        .map((row) => readString(row.name))
        .filter((name): name is string => name !== null)
        .map((name) => name.replace('models/', ''))
        .sort();
    }

    return [];
  }

  async testConnection(
    provider: string,
    apiKey: string,
    model: string,
  ): Promise<ConnectionResult> {
    try {
      if (provider === 'openai') {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: "Say 'Connection Successful'" }],
            max_tokens: 10,
          }),
        });
        if (!response.ok) return { success: false, message: PROVIDER_ERROR };
        return { success: true, message: 'OpenAI connection successful' };
      }

      if (provider === 'gemini') {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: "Say 'Connection Successful'" }] }],
            }),
          },
        );
        if (!response.ok) return { success: false, message: PROVIDER_ERROR };
        return { success: true, message: 'Gemini connection successful' };
      }

      return { success: false, message: UNSUPPORTED_PROVIDER };
    } catch {
      return { success: false, message: PROVIDER_ERROR };
    }
  }

  async generateContent(input: ProviderGenerationInput): Promise<string> {
    const { provider, apiKey, model, prompt, systemPrompt } = input;

    if (provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.7,
        }),
      });
      if (!response.ok) throw new UnprocessableEntityException(PROVIDER_ERROR);
      const data: unknown = await response.json();
      const choices = asRecords(isRecord(data) ? data.choices : undefined);
      const text = readNestedString(choices[0], ['message', 'content']);
      if (text === null) throw new UnprocessableEntityException(PROVIDER_ERROR);
      return text;
    }

    if (provider === 'gemini') {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `${systemPrompt ? systemPrompt + '\n\n' : ''}${prompt}`,
                  },
                ],
              },
            ],
            generationConfig: { temperature: 0.7 },
          }),
        },
      );
      if (!response.ok) throw new UnprocessableEntityException(PROVIDER_ERROR);
      const data: unknown = await response.json();
      const candidates = asRecords(isRecord(data) ? data.candidates : undefined);
      const text = readNestedString(candidates[0], ['content', 'parts', '0', 'text']);
      if (text === null) throw new UnprocessableEntityException(PROVIDER_ERROR);
      return text;
    }

    throw new UnprocessableEntityException(UNSUPPORTED_PROVIDER);
  }
}

/** Read a nested string by path, tolerating numeric array indices. */
function readNestedString(root: unknown, path: readonly string[]): string | null {
  let node: unknown = root;
  for (const segment of path) {
    if (Array.isArray(node)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index)) return null;
      node = node[index];
    } else if (isRecord(node)) {
      node = node[segment];
    } else {
      return null;
    }
  }
  return readString(node);
}
