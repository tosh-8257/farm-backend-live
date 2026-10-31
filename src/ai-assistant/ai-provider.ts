import {
  Injectable,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  name?: string;
}
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Provider-agnostic client for any OpenAI-compatible /chat/completions endpoint
 * (OpenAI, xAI, Groq, Together, OpenRouter, local vLLM/Ollama, ...).
 * Defaults to xAI (https://api.x.ai/v1, grok-4.3); override with AI_BASE_URL / AI_MODEL.
 * Disabled unless AI_ASSISTANT_ENABLED=true AND AI_API_KEY is set.
 */
/** Raw token usage reported by the provider for one completion (OpenAI-compatible shape). */
export interface ProviderUsage {
  model: string;
  prompt_tokens: number;
  cached_tokens: number;
  /** Billable output tokens, including reasoning tokens when the provider reports them separately. */
  output_tokens: number;
  /** Provider-reported cost in USD when available (xAI: cost_in_usd_ticks / 1e10). */
  cost_usd: number | null;
}

/** Normalise an OpenAI-compatible `usage` object. Returns null when absent. */
export function parseUsage(raw: unknown, model: string): ProviderUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, any>;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const prompt = n(u.prompt_tokens);
  const completion = n(u.completion_tokens);
  const reasoning = n(u.completion_tokens_details?.reasoning_tokens);
  const total = n(u.total_tokens);
  // Some providers count reasoning inside completion_tokens, others separately;
  // total_tokens tells us which.
  const separateReasoning =
    reasoning > 0 && total >= prompt + completion + reasoning;
  const ticks = u.cost_in_usd_ticks;
  return {
    model,
    prompt_tokens: prompt,
    cached_tokens: n(u.prompt_tokens_details?.cached_tokens),
    output_tokens: completion + (separateReasoning ? reasoning : 0),
    cost_usd:
      ticks !== undefined && ticks !== null && Number.isFinite(Number(ticks))
        ? Number(ticks) / 1e10
        : null,
  };
}

export type CompletionResult = ChatMessage & { usage?: ProviderUsage | null };

export const AI_DEFAULT_BASE_URL = 'https://api.x.ai/v1';
export const AI_DEFAULT_MODEL = 'grok-4.3';
@Injectable()
export class AiProvider {
  private readonly logger = new Logger(AiProvider.name);
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return (
      this.config.get<string>('AI_ASSISTANT_ENABLED') === 'true' &&
      !!this.config.get<string>('AI_API_KEY')
    );
  }

  model(): string {
    return this.config.get<string>('AI_MODEL') || AI_DEFAULT_MODEL;
  }

  async complete(
    messages: ChatMessage[],
    tools: ToolSpec[],
  ): Promise<CompletionResult> {
    if (!this.isConfigured())
      throw new ServiceUnavailableException('AI assistant is not enabled');
    const base = (
      this.config.get<string>('AI_BASE_URL') || AI_DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    const model = this.model();
    const timeoutMs = Number(this.config.get<string>('AI_TIMEOUT_MS') ?? 30000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.get<string>('AI_API_KEY')}`,
        },
        body: JSON.stringify({
          model,
          messages,
          tools,
          tool_choice: 'auto',
          temperature: 0.2,
        }),
      });
      if (!res.ok) {
        this.logger.warn(`AI provider HTTP ${res.status}`);
        throw new ServiceUnavailableException('AI provider error');
      }
      const data = (await res.json()) as {
        choices?: { message?: ChatMessage }[];
        usage?: unknown;
        model?: string;
      };
      const msg = data.choices?.[0]?.message;
      if (!msg)
        throw new ServiceUnavailableException(
          'AI provider returned no message',
        );
      return {
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
        usage: parseUsage(data.usage, model),
      };
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e;
      this.logger.warn(`AI provider request failed: ${(e as Error).name}`);
      throw new ServiceUnavailableException('AI provider unavailable');
    } finally {
      clearTimeout(timer);
    }
  }
}
