/**
 * AI calls (server only), in their own module so the browser bundle does not carry them: the index of the package (Node) loads it, the browser entry does
 * not. A wrapper around the app's own AI client, like PostHog's `@posthog/ai` and Langfuse's `observeOpenAI`: `everydeck.wrapOpenAI(client)` and
 * `everydeck.wrapAnthropic(client)` return the same client; each call of `chat.completions.create`, `responses.create`, `embeddings.create`, `images.generate`,
 * `images.edit`, `audio.transcriptions.create`, `audio.translations.create`, `audio.speech.create` (OpenAI) or `messages.create` (Anthropic), with or without
 * `stream`, sends one event `everydeck.ai.generation` (PostHog `$ai_generation`) with field names after the
 * OpenTelemetry GenAI conventions: provider, operation, model asked for and model that answered, input tokens (counting cached ones), output tokens,
 * cached tokens read and written, duration in seconds, the error type of a failed call, the flow of the app. Never the prompt, the answer, a system text or
 * a key: the wrapper does not read them. The person, the organization and the flow come from `wrapOpenAI(client, { flow, subjectRef, accountRef })` or
 * from `everydeck.aiContext({ … }, fn)`; all calls inside one `aiContext` belong to one run. `everydeck.aiCall({ … })` sends a call the app measured itself.
 * everydeck prices the tokens with its price list; the app never sends money.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { EverydeckClient } from './core.js';

/** the event of one AI call (PostHog `$ai_generation`) */
export const AI_EVENT = 'everydeck.ai.generation';
export type AiOperation = 'chat' | 'text_completion' | 'embeddings' | 'generate_content' | 'image_generation' | 'audio_transcription' | 'audio_speech';
/** who and what a call belongs to: the flow of the app (e.g. `cv_analysis`), the person, the organization */
export interface AiOptions { flow?: string; subjectRef?: string; accountRef?: string }
/** a call the app measured itself (an AI API it calls over HTTP without a client) */
export interface AiCall extends AiOptions { provider: string; operation?: AiOperation; requestModel: string; responseModel?: string; inputTokens?: number | undefined; outputTokens?: number | undefined; cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined; durationSeconds?: number; errorType?: string; runId?: string }

const FLOW = /^[a-z][a-z0-9_.-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
const PROVIDER = /^[a-z][a-z0-9_.-]{0,39}$/;
const ERROR = /^[A-Za-z0-9_.:-]{1,64}$/;
const OPERATIONS = new Set(['chat', 'text_completion', 'embeddings', 'generate_content', 'image_generation', 'audio_transcription', 'audio_speech']);
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
const tokens = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
type Ctx = AiOptions & { runId: string };
const store = new AsyncLocalStorage<Ctx>();
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' ? v as Obj : undefined);

/** the error type for OpenTelemetry `error.type`: the class of the error (RateLimitError), else its HTTP status, never its message */
export function aiErrorType(e: unknown): string {
  const name = (e as { constructor?: { name?: string } } | null)?.constructor?.name;
  if (name && name !== 'Error' && name !== 'Object' && ERROR.test(name)) return name;
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? String(status) : 'Error';
}

declare module './core.js' {
  interface EverydeckClient {
    /** AI calls (server only), see the top of ai.ts: the same OpenAI client, measured */
    wrapOpenAI<T>(client: T, o?: AiOptions): T;
    /** AI calls (server only), see the top of ai.ts: the same Anthropic client, measured */
    wrapAnthropic<T>(client: T, o?: AiOptions): T;
    /** all AI calls inside fn belong to one run of a flow, of a person and an organization */
    aiContext<R>(o: AiOptions & { runId?: string }, fn: () => R): R;
    /** an AI call the app measured itself */
    aiCall(c: AiCall): void;
  }
}

EverydeckClient.prototype.aiContext = function aiContext<R>(this: EverydeckClient, o: AiOptions & { runId?: string }, fn: () => R): R {
  if (o.flow !== undefined && !FLOW.test(o.flow)) this.opts.onWarning(`AI flow must be lowercase letters, digits and _ . - (at most 64): ${JSON.stringify(o.flow).slice(0, 80)} (left out)`);
  const outer = store.getStore();
  const next: Ctx = { ...outer, ...(o.flow !== undefined && FLOW.test(o.flow) ? { flow: o.flow } : {}), ...(o.subjectRef ? { subjectRef: o.subjectRef } : {}), ...(o.accountRef ? { accountRef: o.accountRef } : {}), runId: o.runId ?? uuid() };
  return store.run(next, fn);
};

EverydeckClient.prototype.aiCall = function aiCall(this: EverydeckClient, c: AiCall): void {
  try {
    const ctx = store.getStore();
    if (typeof c.requestModel !== 'string' || !MODEL.test(c.requestModel)) { this.opts.onWarning(`AI call not sent: model ${JSON.stringify(String(c.requestModel)).slice(0, 80)} is not a model name`); return; }
    const flow = c.flow ?? ctx?.flow;
    if (c.flow !== undefined && !FLOW.test(c.flow)) this.opts.onWarning(`AI flow must be lowercase letters, digits and _ . - (at most 64): ${JSON.stringify(c.flow).slice(0, 80)} (left out)`);
    const fields: Record<string, string | number> = { 'gen_ai.operation.name': c.operation && OPERATIONS.has(c.operation) ? c.operation : 'chat', 'gen_ai.provider.name': PROVIDER.test(c.provider) ? c.provider : 'openai', 'gen_ai.request.model': c.requestModel };
    if (c.responseModel && MODEL.test(c.responseModel)) fields['gen_ai.response.model'] = c.responseModel;
    const put = (k: string, v: number | undefined, skipZero = false) => { const t = tokens(v); if (t !== undefined && !(skipZero && t === 0)) fields[k] = t; };
    put('gen_ai.usage.input_tokens', c.inputTokens); put('gen_ai.usage.output_tokens', c.outputTokens);
    put('gen_ai.usage.cache_read.input_tokens', c.cacheReadTokens, true); put('gen_ai.usage.cache_write.input_tokens', c.cacheWriteTokens, true);
    if (typeof c.durationSeconds === 'number' && Number.isFinite(c.durationSeconds) && c.durationSeconds >= 0) fields['gen_ai.client.inference.duration'] = Math.round(c.durationSeconds * 1000) / 1000;
    if (c.errorType) fields['error.type'] = ERROR.test(c.errorType) ? c.errorType : 'Error';
    if (flow && FLOW.test(flow)) fields['everydeck.flow'] = flow;
    const subjectRef = c.subjectRef ?? ctx?.subjectRef; const accountRef = c.accountRef ?? ctx?.accountRef;
    this.signal(AI_EVENT, `everydeck.sdk:ai:${c.runId ?? ctx?.runId ?? uuid()}`, { fields, ...(subjectRef ? { subjectRef } : {}), ...(accountRef ? { accountRef } : {}) });
  } catch { /* measuring never breaks the app */ }
};

// ── the wrapper ──
type Kind = 'openai' | 'anthropic';
interface Usage { inputTokens?: number | undefined; outputTokens?: number | undefined; cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined; responseModel?: string }
const METHODS: Record<Kind, Record<string, AiOperation>> = {
  openai: { 'chat.completions.create': 'chat', 'chat.completions.parse': 'chat', 'beta.chat.completions.parse': 'chat', 'responses.create': 'chat', 'responses.parse': 'chat', 'embeddings.create': 'embeddings', 'completions.create': 'text_completion',
    // the image and audio calls everydeck-check finds (scaffold); everydeck-check footprint keeps the same list (WRAPPED in footprint.py)
    'images.generate': 'image_generation', 'images.edit': 'image_generation', 'audio.transcriptions.create': 'audio_transcription', 'audio.translations.create': 'audio_transcription', 'audio.speech.create': 'audio_speech' },
  anthropic: { 'messages.create': 'chat', 'messages.parse': 'chat', 'beta.messages.create': 'chat', 'beta.messages.parse': 'chat' },
};
const prefixes = (k: Kind) => new Set(Object.keys(METHODS[k]).flatMap((m) => m.split('.').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('.'))));
const PREFIXES: Record<Kind, Set<string>> = { openai: prefixes('openai'), anthropic: prefixes('anthropic') };
/** OpenTelemetry gen_ai.provider.name from the address the OpenAI client talks to (OpenRouter, Groq … use the OpenAI client) */
function providerOf(kind: Kind, client: unknown): string {
  if (kind === 'anthropic') return 'anthropic';
  const base = String((client as { baseURL?: unknown }).baseURL ?? '');
  for (const [re, p] of [[/openrouter\.ai/, 'openrouter'], [/groq\.com/, 'groq'], [/together\.(ai|xyz)/, 'together'], [/\.openai\.azure\.com|azure/, 'azure.ai.openai'], [/deepseek\.com/, 'deepseek'], [/mistral\.ai/, 'mistral_ai'], [/x\.ai/, 'x_ai'], [/generativelanguage\.googleapis/, 'gcp.gemini']] as const) if (re.test(base)) return p;
  return 'openai';
}
/** tokens as OpenTelemetry counts them: input includes cached tokens (Anthropic reports them apart, OpenAI inside) */
function usageOf(kind: Kind, u: Obj | undefined): Usage {
  if (!u) return {};
  if (kind === 'anthropic') {
    const inp = tokens(u['input_tokens']); const read = tokens(u['cache_read_input_tokens']) ?? 0; const write = tokens(u['cache_creation_input_tokens']) ?? 0;
    return { ...(inp !== undefined ? { inputTokens: inp + read + write } : {}), ...(tokens(u['output_tokens']) !== undefined ? { outputTokens: tokens(u['output_tokens']) } : {}), cacheReadTokens: read, cacheWriteTokens: write };
  }
  if (u['prompt_tokens'] !== undefined) return { inputTokens: tokens(u['prompt_tokens']), ...(u['completion_tokens'] !== undefined ? { outputTokens: tokens(u['completion_tokens']) } : {}), cacheReadTokens: tokens(obj(u['prompt_tokens_details'])?.['cached_tokens']) ?? 0 };
  return { inputTokens: tokens(u['input_tokens']), outputTokens: tokens(u['output_tokens']), cacheReadTokens: tokens(obj(u['input_tokens_details'])?.['cached_tokens']) ?? 0 };
}
const fromResult = (kind: Kind, r: unknown): Usage => { const o = obj(r); return { ...usageOf(kind, obj(o?.['usage'])), ...(typeof o?.['model'] === 'string' ? { responseModel: o['model'] as string } : {}) }; };
/** what a stream event adds: OpenAI chat (the usage chunk), Responses (response.completed), Anthropic (message_start, message_delta) */
function fromStreamEvent(kind: Kind, ev: unknown, acc: Usage): void {
  const e = obj(ev); if (!e) return;
  if (kind === 'anthropic') {
    if (e['type'] === 'message_start') { const m = obj(e['message']); if (typeof m?.['model'] === 'string') acc.responseModel = m['model'] as string; Object.assign(acc, usageOf('anthropic', obj(m?.['usage']))); }
    else if (e['type'] === 'message_delta') { const u = obj(e['usage']); const out = tokens(u?.['output_tokens']); if (out !== undefined) acc.outputTokens = out; if (u && tokens(u['input_tokens']) !== undefined) Object.assign(acc, usageOf('anthropic', { ...u, output_tokens: out })); }
    return;
  }
  if (typeof e['type'] === 'string' && (e['type'] as string).startsWith('response.')) { const r = obj(e['response']); if (r) { if (typeof r['model'] === 'string') acc.responseModel = r['model'] as string; if (r['usage']) Object.assign(acc, usageOf('openai', obj(r['usage']))); } return; }
  if (typeof e['model'] === 'string') acc.responseModel = e['model'] as string;
  if (e['usage']) Object.assign(acc, usageOf('openai', obj(e['usage'])));
}

function wrap<T>(ed: EverydeckClient, kind: Kind, client: T, o: AiOptions = {}): T {
  const c = client as unknown as Obj;
  const ok = kind === 'openai' ? typeof obj(obj(c?.['chat'])?.['completions'])?.['create'] === 'function' || typeof obj(c?.['responses'])?.['create'] === 'function' || typeof obj(c?.['embeddings'])?.['create'] === 'function' : typeof obj(c?.['messages'])?.['create'] === 'function';
  if (!ok) { ed.opts.onWarning(`${kind === 'openai' ? 'wrapOpenAI' : 'wrapAnthropic'}: this is not an ${kind === 'openai' ? 'OpenAI' : 'Anthropic'} client; returned unchanged and not measured`); return client; }
  if (o.flow !== undefined && !FLOW.test(o.flow)) ed.opts.onWarning(`AI flow must be lowercase letters, digits and _ . - (at most 64): ${JSON.stringify(o.flow).slice(0, 80)} (left out)`);
  const defaults: AiOptions = { ...(o.flow !== undefined && FLOW.test(o.flow) ? { flow: o.flow } : {}), ...(o.subjectRef ? { subjectRef: o.subjectRef } : {}), ...(o.accountRef ? { accountRef: o.accountRef } : {}) };
  const provider = providerOf(kind, client);
  const send = (op: AiOperation, model: unknown, started: number, u: Usage, err?: unknown) => {
    if (typeof model !== 'string') return;
    ed.aiCall({ provider, operation: op, requestModel: model, ...(u.responseModel ? { responseModel: u.responseModel } : {}), ...(err === undefined ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens } : { errorType: aiErrorType(err) }),
      durationSeconds: (performance.now() - started) / 1000, ...defaults });
  };
  const measured = (fn: (...a: unknown[]) => unknown, self: object, key: string) => function measuredCall(...args: unknown[]): unknown {
    const op = METHODS[kind][key]!; const body = obj(args[0]); const started = performance.now(); const model = body?.['model'];
    let call = args; let hideUsage = false;
    // like PostHog: a chat stream reports its tokens only with stream_options.include_usage; the chunk it adds is not passed to the app
    if (kind === 'openai' && key === 'chat.completions.create' && body?.['stream'] === true && obj(body['stream_options'])?.['include_usage'] !== true) {
      call = [{ ...body, stream_options: { ...obj(body['stream_options']), include_usage: true } }, ...args.slice(1)]; hideUsage = true;
    }
    let res: unknown;
    try { res = fn.apply(self, call); } catch (e) { send(op, model, started, {}, e); throw e; }
    if (body?.['stream'] === true) {
      return Promise.resolve(res).then((s) => streamed(s as object, (acc, err) => send(op, model, started, acc, err), hideUsage), (e: unknown) => { send(op, model, started, {}, e); throw e; });
    }
    Promise.resolve(res).then((r) => send(op, model, started, fromResult(kind, r)), (e: unknown) => send(op, model, started, {}, e));
    return res;
  };
  const streamed = (s: object, done: (acc: Usage, err?: unknown) => void, hideUsage: boolean) => {
    const acc: Usage = {};
    return new Proxy(s, { get(t, k) {
      if (k === Symbol.asyncIterator) return async function* measuredStream() {
        let failed: unknown; let sent = false;
        try {
          for await (const ev of t as AsyncIterable<unknown>) {
            fromStreamEvent(kind, ev, acc);
            const e = obj(ev); if (hideUsage && e?.['usage'] && Array.isArray(e['choices']) && !(e['choices'] as unknown[]).length) continue;
            yield ev;
          }
        } catch (e) { failed = e; sent = true; done(acc, e); throw e; } finally { if (!sent) done(acc, failed); }
      };
      const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v;
    } });
  };
  const view = (target: object, path: string[]): object => new Proxy(target, { get(t, k) {
    const v = Reflect.get(t, k, t);
    if (typeof k !== 'string') return typeof v === 'function' ? v.bind(t) : v;
    const key = [...path, k].join('.');
    if (typeof v === 'function') return METHODS[kind][key] ? measured(v as (...a: unknown[]) => unknown, t, key) : v.bind(t);
    if (v && typeof v === 'object' && PREFIXES[kind].has(key)) return view(v, [...path, k]);
    return v;
  } });
  return view(c, []) as T;
}
EverydeckClient.prototype.wrapOpenAI = function wrapOpenAI<T>(this: EverydeckClient, client: T, o?: AiOptions): T { return wrap(this, 'openai', client, o); };
EverydeckClient.prototype.wrapAnthropic = function wrapAnthropic<T>(this: EverydeckClient, client: T, o?: AiOptions): T { return wrap(this, 'anthropic', client, o); };
