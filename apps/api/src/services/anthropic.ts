import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { estimateCostUsd, type AiFeature } from '@janelle/shared';
import { env, isAnthropicConfigured } from '../env.js';
import { UserFacingError } from '../middleware/error.js';
import { resolveAi } from '../lib/aiSettings.js';
import { resolveOrgId } from '../lib/org.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { tryRouted } from './llm.js';

/** The activity_log action that marks one Claude call. */
export const AI_USAGE_ACTION = 'ai.usage';

/**
 * How long one call to Claude may take, and how often it is re-sent.
 *
 * The SDK's own defaults are ten minutes and two retries, which is right
 * for a script and wrong here: every caller runs inside a serverless
 * function that the platform kills at 60s, and a single call left hanging
 * takes the whole invocation down with it — the browser then sees a
 * dropped connection rather than an error. Bounding each attempt is what
 * makes the callers' own time budgets mean anything. One retry is kept,
 * because a 429 or a 500 is worth re-sending and is usually quick.
 *
 * A PDF that cannot be read inside this is skipped and logged, which is
 * why `MAX_PDF_BYTES` keeps documents small enough to finish.
 */
const CALL_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS || 25_000);
const CALL_MAX_RETRIES = Number(process.env.ANTHROPIC_MAX_RETRIES ?? 1);

/**
 * The bound for a call that WRITES something long.
 *
 * 25 seconds is right for the reading calls — classify this email, pull the
 * fields out of this quote — and wrong for a prompt whose answer is a
 * moodboard or a finish schedule. Those legitimately run past half a minute,
 * and bounding them at 25s meant the studio's longest-running prompts were
 * the ones that could never finish: the work was done and thrown away at the
 * timeout, twice, then reported as "Server error".
 */
const LONG_CALL_TIMEOUT_MS = Number(process.env.ANTHROPIC_LONG_TIMEOUT_MS || 120_000);

/**
 * How many tokens one call may spend, input and output together.
 *
 * Measured before this existed: the assistant averaged 9,181 tokens a turn
 * and peaked at 30,428, and 424 of the last 1,000 calls went past 5,000.
 * Nearly all of it was input — the same system prompt and tool list resent
 * on every turn — which is why the fix is caching first and clamping second.
 *
 * The clamp is on OUTPUT, because output is the part a caller chooses.
 * A request whose input alone exceeds the budget still goes out: refusing
 * it would mean answering nothing at all, and a floor of 512 keeps the
 * reply usable rather than truncated mid-sentence.
 */
const TOKEN_BUDGET = Number(process.env.AI_TOKEN_BUDGET || 5_000);
const MIN_OUTPUT_TOKENS = 512;

/**
 * Cheap, deliberately pessimistic: ~3.5 characters per token.
 *
 * An attached document is counted as nothing, and that is deliberate. Its
 * base64 is characters, not text: a 7MB PDF measured 2.5 MILLION "tokens"
 * here, which drove the clamp below to the 512 floor and truncated the JSON
 * coming back — so a finish schedule of any length lost its rows partway
 * through. The clamp exists to stop a runaway PROMPT, and output is a small
 * fraction of what a document read costs in any case; the real input is
 * still measured and billed by the API and recorded in usage.
 */
function estimateTokens(params: { system?: unknown; messages?: unknown; tools?: unknown }): number {
  let chars = 0;
  // A base64 payload is excluded by WHERE it sits, not by how long it is.
  // Keyed on length, any brief past two thousand characters counted as
  // nothing at all — so the longest requests, which are precisely the
  // expensive ones, were the only requests the budget could not see, and the
  // cap never closed on them. `data` is where an image or document rides.
  const withoutPayloads = (key: string, value: unknown) =>
    key === 'data' && typeof value === 'string' ? '' : value;
  for (const part of [params.system, params.messages, params.tools]) {
    if (typeof part === 'string') chars += part.length;
    else if (part) chars += JSON.stringify(part, withoutPayloads).length;
  }
  return Math.ceil(chars / 3.5);
}

/**
 * The environment-configured client, kept for callers that only need to
 * know whether Claude is available at boot. The client actually used for
 * a call is resolved per studio in `clientFor()`, because the key and
 * model are now editable from Settings.
 */
export const anthropic: Anthropic | null = isAnthropicConfigured()
  ? new Anthropic({
      apiKey: env.anthropic.apiKey,
      timeout: CALL_TIMEOUT_MS,
      maxRetries: CALL_MAX_RETRIES,
    })
  : null;

/**
 * One client per distinct key. Constructing an SDK client is cheap but
 * not free, and every Claude call goes through here.
 */
const clients = new Map<string, Anthropic>();

function clientForKey(apiKey: string): Anthropic {
  const existing = clients.get(apiKey);
  if (existing) return existing;
  const created = new Anthropic({ apiKey, timeout: CALL_TIMEOUT_MS, maxRetries: CALL_MAX_RETRIES });
  clients.set(apiKey, created);
  return created;
}

/**
 * The studio's key and model, falling back to the environment. Null when
 * no key is configured anywhere — callers degrade gracefully.
 */
export async function clientFor(
  orgId?: string | null,
): Promise<{ client: Anthropic; model: string } | null> {
  const { apiKey, model } = await resolveAi(orgId);
  if (!apiKey) return null;
  return { client: clientForKey(apiKey), model };
}

/** Whether this studio can call Claude at all. */
export async function isAiReady(orgId?: string | null): Promise<boolean> {
  return Boolean(await clientFor(orgId));
}

/** The beta flag the installed SDK's Files API still requires. */
const FILES_BETA = 'files-api-2025-04-14';

/**
 * Hand a document to Claude by reference instead of by value.
 *
 * A base64 document rides inside the request body, which caps what can be
 * read: the encoding is a third larger than the file, the SDK builds a JSON
 * string around that, and the whole thing has to fit in the 32MB request
 * limit and in the function's memory at once. Uploading first sidesteps all
 * of it — the file goes up as bytes, and the request that reads it carries
 * only an id.
 *
 * Returns null when Claude is not configured, so callers fall back to the
 * inline path rather than failing.
 */
export async function uploadDocument(
  bytes: Buffer,
  filename: string,
  mimeType: string,
  orgId?: string | null,
): Promise<string | null> {
  const resolved = await clientFor(orgId);
  if (!resolved) return null;
  // `client.beta.files` on the installed SDK (0.68): the Files API is out of
 // beta upstream, but the stable `client.files` namespace only exists in
 // later versions, and moving the dependency is not this change's business.
  const file = await resolved.client.beta.files.upload({
    file: await toFile(bytes, filename, { type: mimeType }),
    betas: [FILES_BETA],
  });
  return file.id;
}

/**
 * Delete uploads left behind by a pass that did not finish.
 *
 * Each upload is deleted by the read that made it, but only when that read
 * returns — a pass killed mid-document (a time budget, a redeploy, a crash)
 * leaves its file behind, and nothing else ever refers to it. Observed:
 * after one ingestion two 20MB+ files were still in storage with their
 * documents already parsed.
 *
 * Every upload here is transient by construction, so anything older than the
 * window is finished with, whatever happened to the pass that made it.
 * Returns how many were removed. Never throws.
 */
export async function sweepStaleUploads(orgId?: string | null, olderThanMs = 3600_000): Promise<number> {
  try {
    const resolved = await clientFor(orgId);
    if (!resolved) return 0;
    const cutoff = Date.now() - olderThanMs;
    const listed = await resolved.client.beta.files.list({ betas: [FILES_BETA] });
    let removed = 0;
    for (const file of listed.data ?? []) {
      if (new Date(file.created_at).getTime() > cutoff) continue;
      await deleteDocument(file.id, orgId);
      removed++;
    }
    if (removed) console.log(`[anthropic] cleared ${removed} leftover upload(s)`);
    return removed;
  } catch (err) {
    console.warn('[anthropic] upload sweep failed', (err as Error).message);
    return 0;
  }
}

/** Remove an uploaded document. Never throws: a leftover file is not an outage. */
export async function deleteDocument(fileId: string, orgId?: string | null): Promise<void> {
  try {
    const resolved = await clientFor(orgId);
    await resolved?.client.beta.files.delete(fileId, { betas: [FILES_BETA] });
  } catch (err) {
    console.warn('[anthropic] could not delete uploaded file', fileId, (err as Error).message);
  }
}

export class AnthropicNotConfigured extends Error {
  constructor() {
    super('Claude API is not configured (set ANTHROPIC_API_KEY).');
    this.name = 'AnthropicNotConfigured';
  }
}

/**
 * Who this call was for. Every helper below takes one, so a new caller
 * cannot spend the studio's money without appearing on the usage report.
 */
export interface CallContext {
  feature: AiFeature;
  /** Left out by the background services, which resolve the studio below. */
  orgId?: string | null;
  /** The person who pressed the button; null when the agent acted alone. */
  actor?: string | null;
  entity?: string | null;
  entityId?: string | null;
}

/** Concatenate the text blocks of a Claude response. */
function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// ── Usage recording ─────────────────────────────────────────

/**
 * One row per API call, success or failure. Never throws and never
 * blocks the caller: a book-keeping problem must not take down the
 * feature that was doing the actual work.
 */
async function record(
  ctx: CallContext,
  model: string,
  usage: Anthropic.Usage | null,
  latencyMs: number,
  error: unknown,
): Promise<void> {
  try {
    if (!supabaseAdmin) return;
    const orgId = await resolveOrgId(ctx.orgId);
    if (!orgId) return;

    const tokens = {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_write_tokens: usage?.cache_creation_input_tokens ?? 0,
      cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
    };

    // Written to activity_log rather than a table of its own: the studio
    // has one database connection, and a new table would need DDL and a
    // second credential before any of this could be recorded at all. The
    // audit log already exists, is already org-scoped, and this genuinely
    // is activity — the Audit Log screen filters these out so it stays
    // readable, and the usage report reads them back by action.
    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: ctx.actor ?? null,
      action: AI_USAGE_ACTION,
      entity: ctx.entity ?? null,
      entity_id: ctx.entityId ?? null,
      meta: {
        feature: ctx.feature,
        model,
        ...tokens,
        cost_usd: Number(estimateCostUsd(model, tokens).toFixed(6)),
        latency_ms: latencyMs,
        ok: !error,
        // The message only — an API error can carry a whole request in it.
        error: error ? String((error as Error).message ?? error).slice(0, 500) : null,
      },
    });
  } catch (err) {
    console.error('[ai_usage] could not record call', (err as Error).message);
  }
}

/**
 * Models that reject `temperature`, remembered so the studio pays for the
 * refusal once, not on every email.
 *
 * The reading calls pin `temperature: 0` for a repeatable answer, but the
 * newer Claude models have dropped the parameter and 400 the whole request
 * ("`temperature` is deprecated for this model") — which, before this,
 * failed every ingest on the model the studio had chosen. Temperature 0 is
 * also these models' own default, so dropping it loses nothing.
 */
const temperatureRefused = new Set<string>();

/** Does the provider's 400 say it was the temperature it objected to? */
function rejectsTemperature(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? '');
  return /temperature/i.test(msg) && /(deprecat|unsupported|not supported|no longer)/i.test(msg);
}

/**
 * Run a Claude call and record what it cost, whatever happens to it.
 *
 * The model comes from the studio's settings unless the caller named one
 * explicitly, so changing the model in Settings changes every feature at
 * once without touching a single call site.
 */
async function recorded(
  ctx: CallContext,
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'> & { model?: string },
  options?: { timeoutMs?: number },
): Promise<Anthropic.Message> {
  const ai = await clientFor(ctx.orgId);
  if (!ai) throw new AnthropicNotConfigured();

  const request = { ...params, model: params.model ?? ai.model };

  // A model that has already refused temperature never gets it again.
  if (request.temperature !== undefined && temperatureRefused.has(request.model)) {
    delete request.temperature;
  }

  // Kept inside the budget rather than trusting each call site to remember
  // one. The estimate counts the tools and the system prompt too, which is
  // where the assistant's tokens actually go.
  const estimatedInput = estimateTokens(request);
  const room = Math.max(MIN_OUTPUT_TOKENS, TOKEN_BUDGET - estimatedInput);
  if (request.max_tokens > room) {
    console.warn(
      `[ai] ${ctx.feature}: ~${estimatedInput} input tokens, capping output ${request.max_tokens} → ${room} (budget ${TOKEN_BUDGET})`,
    );
    request.max_tokens = room;
  }

  const started = Date.now();
  try {
    // Per-request, so one long call does not loosen the bound on every
    // short one sharing the client.
    const message = await ai.client.messages.create(
      request,
      options?.timeoutMs ? { timeout: options.timeoutMs } : undefined,
    );
    await record(ctx, request.model, message.usage, Date.now() - started, null);
    return message;
  } catch (err) {
    await record(ctx, request.model, null, Date.now() - started, err);

    // The newer models 400 the whole request over `temperature`. Drop it,
    // remember the model so the next call never sends it, and run this one
    // again — the alternative is every email failing until someone edits the
    // model setting.
    if (request.temperature !== undefined && rejectsTemperature(err)) {
      temperatureRefused.add(request.model);
      delete request.temperature;
      const retryStarted = Date.now();
      try {
        const message = await ai.client.messages.create(
          request,
          options?.timeoutMs ? { timeout: options.timeoutMs } : undefined,
        );
        await record(ctx, request.model, message.usage, Date.now() - retryStarted, null);
        return message;
      } catch (retryErr) {
        await record(ctx, request.model, null, Date.now() - retryStarted, retryErr);
        throw retryErr;
      }
    }

    // The provider says this in a 400 with the rest of an API error around
    // it, so it reaches the screen as "Server error" and reads like a bug in
    // the app. It is an empty account, and only one person can fix it.
    if (/credit balance is too low|billing/i.test(String((err as Error)?.message ?? ''))) {
      throw new UserFacingError(
        "The studio's Claude credit has run out. Top it up at console.anthropic.com under Plans & Billing, then try again.",
        402,
      );
    }
    throw err;
  }
}

/**
 * For callers that build their own request (the Assistant runs a tool
 * loop). Everything still lands on the usage report.
 */
export function createMessage(
  ctx: CallContext,
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'> & { model?: string },
  options?: { timeoutMs?: number },
): Promise<Anthropic.Message> {
  return recorded(ctx, params, options);
}

// ── Helpers ─────────────────────────────────────────────────

/** Pull the first balanced JSON object/array out of a string. */
export function firstJson<T>(text: string): T | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

type UserContent = string | Anthropic.ContentBlockParam[];

/**
 * Ask Claude for a JSON object matching a described shape. The prompt
 * must instruct the required fields; this returns the parsed object or
 * null if nothing parseable came back.
 */
export async function extractJson<T>(
  system: string,
  user: UserContent,
  ctx: CallContext,
  /**
   * Longer than the 25s reading calls get by default.
   *
   * That bound is right for an email and wrong for a bid set: a document of
   * a few hundred pages takes longer to read than a paragraph, and capping
   * it at 25s would fail every large PDF on the clock — looking exactly
   * like the size limit that used to skip them.
   */
  timeoutMs?: number,
): Promise<T | null> {
  const instruction = `${system}

Respond with ONLY a single JSON object. No prose, no code fences.`;

  // An action the studio moved to another AI runs there. Only plain text can
  // move: an attached PDF is Claude's to read, so a call that carries one
  // stays here whatever the action is set to.
  if (typeof user === 'string') {
    const routed = await tryRouted(ctx, {
      system: instruction, user, maxTokens: 4096, temperature: 0, json: true, timeoutMs: timeoutMs ?? CALL_TIMEOUT_MS,
    });
    if (routed !== null) return firstJson<T>(routed);
  }

  const message = await recorded(
    ctx,
    {
      max_tokens: 4096,
      // Reading, not writing: the same document should give the same fields
      // every time. At the default temperature one estimate named its job on
      // one read and not on the next.
      temperature: 0,
      system: `${system}\n\nRespond with ONLY a single JSON object. No prose, no code fences.`,
      messages: [{ role: 'user', content: user }],
    },
    timeoutMs ? { timeoutMs } : undefined,
  );
  return firstJson<T>(textOf(message));
}

/** Free-form generation (prompt runner, report narrative). */
export async function generate(
  system: string,
  user: string,
  ctx: CallContext,
  maxTokens = 8000,
  timeoutMs = LONG_CALL_TIMEOUT_MS,
): Promise<string> {
  const routed = await tryRouted(ctx, { system, user, maxTokens, json: false, timeoutMs });
  if (routed !== null) return routed;

  const message = await recorded(
    ctx,
    {
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    },
    { timeoutMs },
  );
  return textOf(message);
}

/**
 * Whether a failure was the clock rather than the request.
 *
 * Worth telling apart: a timeout is "ask again or give it less to do", and
 * everything else is not. The SDK's error carries the name; the message is
 * checked too, because a wrapped cause loses the class.
 */
export function isTimeoutError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return (
    e?.name === 'APIConnectionTimeoutError' ||
    /timed? ?out/i.test(e?.message ?? '')
  );
}
