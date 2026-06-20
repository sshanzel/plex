import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { CompletionProvider, LlmConfig } from '@plex/core';

const pexec = promisify(execFile);

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`completion request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export class AnthropicCompletionProvider implements CompletionProvider {
  readonly name = 'anthropic';
  constructor(private model: string, private apiKey: string, private baseUrl = 'https://api.anthropic.com') {}
  async complete(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string> {
    const data = await postJson(
      `${this.baseUrl}/v1/messages`,
      {
        model: this.model,
        max_tokens: opts?.maxTokens ?? 1024,
        system: opts?.system,
        messages: [{ role: 'user', content: prompt }],
      },
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
    );
    return Array.isArray(data.content) ? data.content.map((b: { text?: string }) => b.text ?? '').join('') : '';
  }
}

export class OpenAICompletionProvider implements CompletionProvider {
  readonly name = 'openai';
  constructor(private model: string, private apiKey: string, private baseUrl = 'https://api.openai.com') {}
  async complete(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string> {
    const messages: { role: string; content: string }[] = [];
    if (opts?.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: prompt });
    const data = await postJson(
      `${this.baseUrl}/v1/chat/completions`,
      { model: this.model, max_tokens: opts?.maxTokens ?? 1024, messages },
      { authorization: `Bearer ${this.apiKey}` },
    );
    return data.choices?.[0]?.message?.content ?? '';
  }
}

/** Distill via the local `claude` CLI in print mode — uses the user's subscription, no API key (ADR-20). */
export class ClaudeCliCompletionProvider implements CompletionProvider {
  readonly name = 'claude-cli';
  constructor(private model?: string) {}
  async complete(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string> {
    const args = ['--print', '--output-format', 'text'];
    if (this.model) args.push('--model', this.model);
    if (opts?.system) args.push('--append-system-prompt', opts.system);
    args.push(prompt);
    const { stdout } = await pexec('claude', args, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
    return stdout.trim();
  }
}

/** The configured generative provider, or null for heuristic (no LLM / missing key/binary). */
export function createCompletionProvider(cfg: LlmConfig): CompletionProvider | null {
  if (cfg.provider === 'claude-cli') {
    try {
      execFileSync('claude', ['--version'], { stdio: 'ignore' });
    } catch {
      return null;
    }
    return new ClaudeCliCompletionProvider(cfg.model);
  }
  if (cfg.provider === 'anthropic') {
    const key = process.env[cfg.apiKeyEnv ?? 'ANTHROPIC_API_KEY'];
    return key ? new AnthropicCompletionProvider(cfg.model ?? 'claude-haiku-4-5-20251001', key, cfg.baseUrl) : null;
  }
  if (cfg.provider === 'openai') {
    const key = process.env[cfg.apiKeyEnv ?? 'OPENAI_API_KEY'];
    return key ? new OpenAICompletionProvider(cfg.model ?? 'gpt-4o-mini', key, cfg.baseUrl) : null;
  }
  return null;
}
