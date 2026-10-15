import { Router } from 'express';
import { DEFAULT_SLA, INGEST_INTERVALS, TASK_REVIEW_INTERVALS, SELECTABLE_MODELS, type SlaSettings } from '@janelle/shared';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { supabaseAdmin } from '../lib/supabase.js';
import {
  aiSettingsView,
  clearApiKey,
  looksLikeAnthropicKey,
  saveApiKey,
  saveModel,
} from '../lib/aiSettings.js';
import {
  clearOpenAiApiKey,
  looksLikeOpenAiKey,
  openAiSettingsView,
  saveOpenAiApiKey,
  saveOpenAiModel,
  resolvePictureEngine,
  savePictureEngine,
} from '../lib/aiSettings.js';
import { OPENAI_IMAGE_MODELS, OPENAI_QUALITIES, PICTURE_ENGINES } from '@janelle/shared';
import { readIngestSettings, saveIngestSettings } from '../lib/ingestSettings.js';
import { readClaritySettings, saveClaritySettings } from '../lib/claritySettings.js';
import { readDriveFilingSettings, saveDriveFilingSettings } from '../lib/driveFilingSettings.js';
import { driveCanWrite } from '../lib/google.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { runIngest } from '../services/ingest.js';
import { gmailFor } from '../services/gmail.js';
import { isGoogleAuthFailure } from '../lib/tokens.js';
import {
  clearSlackToken,
  looksLikeSlackBotToken,
  resolveSlack,
  saveSlackConfig,
  saveSlackToken,
  slackSettingsView,
} from '../lib/slackSettings.js';
import { SlackError, authTest, normalizeChannelName, postMessage, tokenScopes } from '../services/slack.js';
import { loadDirectory, matchChannel } from '../services/slackRouting.js';
import { runSlackDigest, type SlackDigestResult } from '../services/slackDigest.js';
import { hasColumn } from '../lib/columns.js';
import { runSlackSync } from '../services/slackSync.js';
import { runSlackReport } from '../services/slackReport.js';
import { clearGeminiKey, keyFor, looksLikeGeminiKey, routingView, saveGeminiKey, saveRoute } from '../lib/llmSettings.js';
import { complete as completeWith, costOf } from '../services/llm.js';
import { firstJson } from '../services/anthropic.js';
import type { AiFeature, AiRoutingTestResult, LlmProvider, LlmRoute } from '@janelle/shared';

/**
 * Studio settings that used to require a deploy.
 *
 * Principal only, and the API key never travels back to the browser — the
 * screen sees whether one is set, where it came from, and its last four
 * characters. Everything here is enforced by requirePermission, so a
 * revoked "Studio settings" grant closes this off like any other module.
 */
export const settingsRouter = Router();
settingsRouter.use(requireAuth);
// Closing a module to a role has to mean something: until now nothing
// anywhere checked `read`, so revoking it would have been a switch that
// changed nothing. No view, no module — writes are still checked
// separately below.
settingsRouter.use(requirePermission('settings', 'read'));

/** Per call; kept short for the same reason as the dashboard's reading. */
const SYNC_BUDGET_MS = Number(process.env.JOB_BUDGET_MS || 20_000);

/** The longest window one sync may ask for. */
const MAX_SYNC_DAYS = 92;

/**
 * Sync the signed-in person's own mailbox for a chosen period.
 *
 * Open to everyone who can see Settings — it reads only the caller's own
 * Gmail, into mail only they (and the studio's mailbox rules) can see. One
 * short, budgeted pass per call: the screen asks again, from `resumeFrom`,
 * until the answer comes back `done`. Everything already stored is skipped
 * without a Claude call, so asking twice for the same day costs nothing.
 */
settingsRouter.post(
  '/mail-sync',
  asyncHandler(async (req, res) => {
    const { orgId, userId } = req.auth!;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const since = new Date(String(req.body?.since ?? ''));
    let until = new Date(String(req.body?.until ?? ''));
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      return res.status(400).json({ error: 'Choose a start and end date.' });
    }
    // Nothing has arrived in the future; a range ending later ends now.
    const now = new Date();
    if (until > now) until = now;
    if (since >= until) return res.status(400).json({ error: 'The start must be before the end.' });
    if (until.getTime() - since.getTime() > MAX_SYNC_DAYS * 86_400_000) {
      return res.status(400).json({ error: `Choose ${MAX_SYNC_DAYS} days or fewer.` });
    }

    // Said plainly here rather than as an empty "0 emails" further down:
    // without Gmail the pass has nothing to read.
    try {
      if (!(await gmailFor(userId))) {
        return res.status(400).json({ error: 'Connect Gmail above before syncing your email.' });
      }
    } catch (err) {
      if (isGoogleAuthFailure(err)) {
        return res.status(400).json({ error: 'Google needs reconnecting — use Connect above, then try again.' });
      }
      throw err;
    }

    const result = await runIngest(orgId, { onlyUserId: userId, range: { since, until }, budgetMs: SYNC_BUDGET_MS });
    res.json({ data: result });
  }),
);

settingsRouter.get(
  '/ai',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: { ...(await aiSettingsView(orgId)), models: SELECTABLE_MODELS } });
  }),
);

/**
 * OpenAI (GPT Image) — renderings.
 *
 * A fourth provider on the same terms as the others: the key is encrypted at
 * rest, never sent back (the screen gets the last four characters), and the
 * model and quality are the studio's to choose because quality is what moves
 * the price.
 */
async function openAiView(orgId: string) {
  return { ...(await openAiSettingsView(orgId)), models: OPENAI_IMAGE_MODELS, qualities: OPENAI_QUALITIES };
}

settingsRouter.get(
  '/openai',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await openAiView(orgId) });
  }),
);

settingsRouter.put(
  '/openai/key',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const apiKey = String(req.body?.apiKey ?? '').trim();
    if (!looksLikeOpenAiKey(apiKey)) {
      return res.status(400).json({
        error: 'That does not look like an OpenAI API key',
        detail: 'Keys begin with sk- and come from platform.openai.com/api-keys.',
      });
    }
    await saveOpenAiApiKey(orgId, apiKey);

    // The key never reaches the log — the last four says which one it was.
    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.openai_key_set',
      entity: 'organizations',
      entity_id: orgId,
      meta: { hint: apiKey.slice(-4) },
    });
    res.json({ data: await openAiView(orgId) });
  }),
);

settingsRouter.delete(
  '/openai/key',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    await clearOpenAiApiKey(orgId);
    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.openai_key_cleared',
      entity: 'organizations',
      entity_id: orgId,
      meta: {},
    });
    res.json({ data: await openAiView(orgId) });
  }),
);

/** Which GPT Image model draws, and at what quality. Either may be sent alone. */
settingsRouter.put(
  '/openai/model',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const model = req.body?.model === undefined ? undefined : String(req.body.model);
    const quality = req.body?.quality === undefined ? undefined : String(req.body.quality);
    try {
      await saveOpenAiModel(orgId, model, quality);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.openai_model_set',
      entity: 'organizations',
      entity_id: orgId,
      meta: { model: model ?? null, quality: quality ?? null },
    });
    res.json({ data: await openAiView(orgId) });
  }),
);

/**
 * Which engine draws the studio's pictures, and the engines to choose from.
 * The keys behind each engine have their own routes (Claude, OpenAI).
 */
async function pictureView(orgId: string) {
  return {
    engine: await resolvePictureEngine(orgId),
    engines: PICTURE_ENGINES,
  };
}

settingsRouter.get(
  '/images',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await pictureView(orgId) });
  }),
);

/** Who makes the picture on a board: OpenAI, or a Claude model drawing it. */
settingsRouter.put(
  '/images/engine',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const engine = String(req.body?.engine ?? '');
    try {
      await savePictureEngine(orgId, engine);
    } catch {
      return res.status(400).json({ error: 'Unknown engine' });
    }

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.picture_engine_set',
      entity: 'organizations',
      entity_id: orgId,
      meta: { engine },
    });

    res.json({ data: await pictureView(orgId) });
  }),
);

/**
 * Microsoft Clarity — session replay/heatmaps of the team's own use of the
 * app. Admin-only to read or change; the project id itself is handed to every
 * signed-in session by `/me` so recording covers everyone.
 */
settingsRouter.get(
  '/clarity',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await readClaritySettings(orgId) });
  }),
);

settingsRouter.put(
  '/clarity',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const patch: { projectId?: string | null; enabled?: boolean } = {};
    if (req.body?.projectId !== undefined) patch.projectId = String(req.body.projectId ?? '');
    if (req.body?.enabled !== undefined) {
      if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
      patch.enabled = req.body.enabled;
    }

    let saved;
    try {
      saved = await saveClaritySettings(orgId, patch);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.clarity_set',
      entity: 'organizations',
      entity_id: orgId,
      // The id is low-sensitivity, but the audit trail cares about on vs off.
      meta: { enabled: saved.enabled, has_project: Boolean(saved.projectId) },
    });

    res.json({ data: saved });
  }),
);

/**
 * The document organiser — files email-attachment PDFs into a Drive tree,
 * Purchasing vs Accounting, by project. Admin-only. The GET also reports
 * whether the studio account has actually granted Drive write, so the UI can
 * ask for the one-time re-consent rather than silently filing nothing.
 */
settingsRouter.get(
  '/drive-filing',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    const settings = await readDriveFilingSettings(orgId);
    // Whether the account that owns the filing tree can write to Drive yet.
    let canWrite = false;
    try {
      const studioUser = await orgSourceUserId(orgId);
      if (studioUser) {
        const { data } = await supabaseAdmin!
          .from('integrations')
          .select('scopes')
          .eq('user_id', studioUser)
          .eq('provider', 'google')
          .maybeSingle();
        canWrite = driveCanWrite((data as { scopes?: string | null } | null)?.scopes);
      }
    } catch (err) {
      console.error('[settings] drive write status unreadable:', (err as Error).message);
    }
    res.json({ data: { ...settings, canWrite } });
  }),
);

settingsRouter.put(
  '/drive-filing',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const patch: { enabled?: boolean; senders?: string[] } = {};
    if (req.body?.enabled !== undefined) {
      if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
      patch.enabled = req.body.enabled;
    }
    if (req.body?.senders !== undefined) {
      if (!Array.isArray(req.body.senders)) return res.status(400).json({ error: 'senders must be a list of addresses' });
      patch.senders = req.body.senders.map(String);
    }

    let saved;
    try {
      saved = await saveDriveFilingSettings(orgId, patch);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.drive_filing_set',
      entity: 'organizations',
      entity_id: orgId,
      meta: { enabled: saved.enabled, senders: saved.senders.length },
    });

    res.json({ data: saved });
  }),
);

/**
 * How often email is read, and whether Claude reads it.
 *
 * These are the two dials that move the bill: how often the studio looks,
 * and whether it thinks about what it finds.
 */
settingsRouter.get(
  '/ingest',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await readIngestSettings(orgId) });
  }),
);

settingsRouter.put(
  '/ingest',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const patch: { intervalMinutes?: number; useAi?: boolean; taskReviewMinutes?: number } = {};

    if (req.body?.intervalMinutes !== undefined) {
      const minutes = Number(req.body.intervalMinutes);
      if (!INGEST_INTERVALS.some((i) => i.minutes === minutes)) {
        return res.status(400).json({ error: 'Unknown interval' });
      }
      patch.intervalMinutes = minutes;
    }

    if (req.body?.useAi !== undefined) {
      if (typeof req.body.useAi !== 'boolean') {
        return res.status(400).json({ error: 'useAi must be true or false' });
      }
      patch.useAi = req.body.useAi;
    }

    if (req.body?.taskReviewMinutes !== undefined) {
      const minutes = Number(req.body.taskReviewMinutes);
      if (!TASK_REVIEW_INTERVALS.some((i) => i.minutes === minutes)) {
        return res.status(400).json({ error: 'Unknown interval' });
      }
      patch.taskReviewMinutes = minutes;
    }

    const updated = await saveIngestSettings(orgId, patch);

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.ingest_changed',
      entity: 'organizations',
      entity_id: orgId,
      meta: patch,
    });

    res.json({ data: updated });
  }),
);

/**
 * The chasing ladder: how long the studio waits before it says something.
 *
 * Every one of these numbers was already read from the studio's settings by
 * the nightly engine, the digest and the task board — but nothing could
 * write them. Two were seeded when the organization was created and the
 * other five had never been anything but the built-in default, so "the
 * system chases too early" had no answer except changing the code.
 */
settingsRouter.get(
  '/sla',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    const { data } = await supabaseAdmin!.from('organizations').select('settings').eq('id', orgId).maybeSingle();
    const stored = ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Partial<SlaSettings>;
    res.json({ data: { ...DEFAULT_SLA, ...stored }, defaults: DEFAULT_SLA });
  }),
);

/** Each dial's sane range, so a typo cannot switch the engine off. */
const SLA_LIMITS: Record<keyof SlaSettings, { min: number; max: number }> = {
  quote_response_days: { min: 1, max: 30 },
  client_waiting_hours: { min: 1, max: 336 },
  vendor_silence_days: { min: 1, max: 30 },
  client_approval_days: { min: 1, max: 60 },
  escalation_days: { min: 1, max: 30 },
  task_reminder_days: { min: 0, max: 30 },
  reminder_repeat_days: { min: 1, max: 30 },
};

settingsRouter.put(
  '/sla',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const patch: Partial<SlaSettings> = {};
    for (const key of Object.keys(SLA_LIMITS) as (keyof SlaSettings)[]) {
      const raw = req.body?.[key];
      if (raw === undefined) continue;
      const value = Number(raw);
      const { min, max } = SLA_LIMITS[key];
      if (!Number.isInteger(value) || value < min || value > max) {
        return res.status(400).json({ error: `${key} must be a whole number between ${min} and ${max}` });
      }
      patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to change' });

    // Merged, never replaced: `settings` also holds the API key, the model
    // and the permission overrides, and writing the column whole would take
    // them with it.
    const { data } = await supabaseAdmin!.from('organizations').select('settings').eq('id', orgId).maybeSingle();
    const settings = ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
    const next = { ...settings, ...patch };

    const { error } = await supabaseAdmin!.from('organizations').update({ settings: next }).eq('id', orgId);
    if (error) throw new Error(error.message);

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.sla_changed',
      entity: 'organizations',
      entity_id: orgId,
      meta: patch,
    });

    res.json({ data: { ...DEFAULT_SLA, ...(next as Partial<SlaSettings>) } });
  }),
);

/** Store a new key. Replaces whatever was there. */
settingsRouter.put(
  '/ai/key',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const apiKey = String(req.body?.apiKey ?? '').trim();
    if (!apiKey) return res.status(400).json({ error: 'Paste a key first' });

    // Catch a mistyped or truncated key here rather than on the next email.
    if (!looksLikeAnthropicKey(apiKey)) {
      return res.status(400).json({
        error: 'That does not look like an Anthropic API key',
        detail: 'Keys begin with sk-ant- and come from console.anthropic.com.',
      });
    }

    await saveApiKey(orgId, apiKey);

    // The key itself must never reach the log; the last four is enough to
    // tell afterwards which key was put in place.
    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.ai_key_set',
      entity: 'organizations',
      entity_id: orgId,
      meta: { hint: apiKey.slice(-4) },
    });

    res.json({ data: await aiSettingsView(orgId) });
  }),
);

/** Remove the studio's key, falling back to the environment if it has one. */
settingsRouter.delete(
  '/ai/key',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    await clearApiKey(orgId);

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.ai_key_cleared',
      entity: 'organizations',
      entity_id: orgId,
      meta: {},
    });

    res.json({ data: await aiSettingsView(orgId) });
  }),
);

/** Choose the model every feature uses. */
settingsRouter.put(
  '/ai/model',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const model = String(req.body?.model ?? '');
    if (!SELECTABLE_MODELS.some((m) => m.id === model)) {
      return res.status(400).json({ error: 'Unknown model' });
    }

    await saveModel(orgId, model);

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.ai_model_set',
      entity: 'organizations',
      entity_id: orgId,
      meta: { model },
    });

    res.json({ data: await aiSettingsView(orgId) });
  }),
);

/**
 * Slack — task and follow-up updates posted to a channel.
 *
 * A bot token (xoxb-…), encrypted at rest and never sent back, plus the
 * channel to post in. The token is checked against Slack before it is saved,
 * so a wrong paste fails here with a reason rather than silently later.
 */
const CHANNEL = /^(?:#?[a-z0-9][a-z0-9._-]{0,79}|[CG][A-Z0-9]{8,})$/;

settingsRouter.get(
  '/slack',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await slackSettingsView(orgId) });
  }),
);

settingsRouter.put(
  '/slack/token',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const token = String(req.body?.token ?? '').trim();
    if (!looksLikeSlackBotToken(token)) {
      return res.status(400).json({ error: 'That does not look like a Slack bot token — it starts with xoxb- (OAuth & Permissions → Bot User OAuth Token).' });
    }
    let workspace: string;
    try {
      workspace = (await authTest(token)).team;
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    await saveSlackToken(orgId, token);
    // Stamps the moment Slack was switched on, so the backlog is not announced.
    await saveSlackConfig(orgId, {});

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.slack_token_set',
      entity: 'organizations',
      entity_id: orgId,
      meta: { workspace, hint: token.slice(-4) },
    });
    res.json({ data: await slackSettingsView(orgId) });
  }),
);

settingsRouter.delete(
  '/slack/token',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    await clearSlackToken(orgId);
    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.slack_token_cleared',
      entity: 'organizations',
      entity_id: orgId,
      meta: {},
    });
    res.json({ data: await slackSettingsView(orgId) });
  }),
);

settingsRouter.put(
  '/slack/config',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const b = req.body ?? {};
    const patch: Parameters<typeof saveSlackConfig>[1] = {};
    if ('channel' in b) {
      const channel = String(b.channel ?? '').trim();
      if (!CHANNEL.test(channel)) {
        return res.status(400).json({ error: 'A channel name looks like project-updates (lowercase, no spaces), or paste the channel ID.' });
      }
      patch.channel = channel;
    }
    for (const key of ['enabled', 'tasks', 'followUps', 'dailyDigest', 'personalReminders'] as const) {
      if (key in b) patch[key] = Boolean(b[key]);
    }
    // The three task-report channels. Blank switches that report off.
    if (b.reportChannels && typeof b.reportChannels === 'object') {
      const rc: Record<string, string> = {};
      for (const key of ['completed', 'pending', 'overdue'] as const) {
        if (!(key in b.reportChannels)) continue;
        const channel = String(b.reportChannels[key] ?? '').trim();
        if (channel && !CHANNEL.test(channel)) {
          return res.status(400).json({ error: `The ${key} channel should look like ${key}-tasks (lowercase, no spaces), or paste the channel ID.` });
        }
        rc[key] = channel;
      }
      patch.reportChannels = rc;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });

    await saveSlackConfig(orgId, patch);
    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.slack_config_set',
      entity: 'organizations',
      entity_id: orgId,
      meta: patch,
    });
    res.json({ data: await slackSettingsView(orgId) });
  }),
);

// A message into the channel now, to prove the token, the channel and the
// bot's membership all work before anyone relies on them.
settingsRouter.post(
  '/slack/test',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    const slack = await resolveSlack(orgId);
    if (!slack.connected || !slack.token) return res.status(400).json({ error: 'Add the bot token and a channel first.' });
    try {
      await postMessage(slack.token, slack.config.channel, {
        text: ':wave: Slack is connected. Task and follow-up updates from Janelle will appear here.',
      });
    } catch (err) {
      return res.status(400).json({ error: err instanceof SlackError ? err.message : 'Could not reach Slack.' });
    }
    res.json({ data: await slackSettingsView(orgId) });
  }),
);

// Send the daily reminder (studio-wide and per project) now, instead of waiting for 9am Pacific.
settingsRouter.post(
  '/slack/digest',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await runSlackDigest(orgId) });
  }),
);

// Post the completed / pending / overdue reports now instead of at the next 9am, midday or 5pm.
settingsRouter.post(
  '/slack/report',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await runSlackReport(orgId) });
  }),
);

// Run the sync now instead of waiting for the next five-minute pass.
settingsRouter.post(
  '/slack/sync',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    const result = await runSlackSync(orgId, { budgetMs: 20_000 });
    res.json({ data: { result, settings: await slackSettingsView(orgId) } });
  }),
);

/**
 * Which Slack channel each project's updates go to.
 *
 * Shows, per project, the channel an admin assigned and the one the system
 * would pick by name, so the screen can say what is happening without anyone
 * having to test it. The automatic match only exists when the bot may read
 * the channel list; `missingScope` tells the screen to say what to add.
 */
settingsRouter.get(
  '/slack/projects',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const ready = await hasColumn('projects', 'slack_channel');
    const { data } = await supabaseAdmin!
      .from('projects')
      .select(ready ? 'id, name, slack_channel' : 'id, name')
      .eq('org_id', orgId)
      .order('name');
    const projects = (data ?? []) as unknown as { id: string; name: string; slack_channel?: string | null }[];

    const slack = await resolveSlack(orgId);
    const dir = slack.token ? await loadDirectory(slack.token) : { channels: [], missingScope: false };
    // With chat:write.public the bot posts in any public channel without joining it,
    // so "not a member" is only a problem for private ones.
    const canPostPublic = slack.token ? (await tokenScopes(slack.token)).includes('chat:write.public') : false;

    res.json({
      data: {
        ready,
        missingScope: dir.missingScope,
        projects: projects.map((p) => {
          const assigned = (p.slack_channel ?? '').trim().replace(/^#/, '');
          const auto = matchChannel(p.name, dir);
          const shown = assigned
            ? dir.channels.find((c) => c.id === assigned || normalizeChannelName(c.name) === normalizeChannelName(assigned))
            : auto;
          return {
            id: p.id,
            name: p.name,
            channel: assigned,
            auto: auto?.name ?? null,
            // False only when the list could be read and the bot is not in it.
            botIn: shown ? shown.isMember || (!shown.isPrivate && canPostPublic) : null,
          };
        }),
      },
    });
  }),
);

settingsRouter.put(
  '/slack/projects/:id',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    if (!(await hasColumn('projects', 'slack_channel'))) {
      return res.status(409).json({ error: 'Project channels need migration 0029_project_slack_channel.sql applied first.' });
    }

    const channel = String(req.body?.channel ?? '').trim();
    if (channel && !CHANNEL.test(channel)) {
      return res.status(400).json({ error: 'A channel name looks like coleman (lowercase, no spaces), or paste the channel ID.' });
    }
    const { data, error } = await supabaseAdmin!
      .from('projects')
      .update({ slack_channel: channel ? channel.replace(/^#/, '') : null })
      .eq('id', req.params.id)
      .eq('org_id', orgId)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Project not found' });
    res.json({ data: { ok: true } });
  }),
);

/**
 * Who does the work — which AI handles each action.
 *
 * Reading email, raising tasks, drafting and the digest each run on Claude
 * unless the studio picks OpenAI or Gemini for them here. Keys never travel
 * back to the browser; `test` runs a sample email through a candidate so the
 * quality can be judged before any real mail is sent to it.
 */
settingsRouter.get(
  '/ai-routing',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await routingView(orgId) });
  }),
);

settingsRouter.put(
  '/ai-routing',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const b = req.body ?? {};
    const feature = String(b.feature ?? '') as AiFeature;
    const provider = String(b.provider ?? '');
    const price = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    try {
      await saveRoute(
        orgId,
        feature,
        provider === 'anthropic' || !provider
          ? null
          : { provider: provider as LlmProvider, model: String(b.model ?? ''), inputPer1M: price(b.inputPer1M), outputPer1M: price(b.outputPer1M) },
      );
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.ai_routing_set',
      entity: 'organizations',
      entity_id: orgId,
      meta: { feature, provider: provider || 'anthropic', model: provider && provider !== 'anthropic' ? String(b.model ?? '') : null },
    });
    res.json({ data: await routingView(orgId) });
  }),
);

settingsRouter.put(
  '/ai-routing/gemini-key',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    const apiKey = String(req.body?.apiKey ?? '').trim();
    if (!looksLikeGeminiKey(apiKey)) {
      return res.status(400).json({ error: 'That does not look like a Gemini key — it starts with AIza (from aistudio.google.com/apikey).' });
    }
    await saveGeminiKey(orgId, apiKey);
    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId, actor: req.auth!.userId, action: 'settings.gemini_text_key_set',
      entity: 'organizations', entity_id: orgId, meta: { hint: apiKey.slice(-4) },
    });
    res.json({ data: await routingView(orgId) });
  }),
);

settingsRouter.delete(
  '/ai-routing/gemini-key',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    await clearGeminiKey(orgId);
    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId, actor: req.auth!.userId, action: 'settings.gemini_text_key_cleared',
      entity: 'organizations', entity_id: orgId, meta: {},
    });
    res.json({ data: await routingView(orgId) });
  }),
);

/** A made-up email with a known right answer, so a candidate AI can be judged on something checkable. */
const ROUTING_TEST_SYSTEM =
  'You read email for an interior design studio. Reply with ONLY a JSON object with these keys: ' +
  '"class" (one of quote_request, order_update, client_message, other), "vendor" (string or null), ' +
  '"project" (string or null), "summary" (one sentence), "action_needed" (true or false).';
const ROUTING_TEST_EMAIL =
  'From: Dana at Hartwell Fabrics <dana@hartwellfabrics.example>\n' +
  'To: studio@example.com\nSubject: Quote for the Meridian Ranch banquette\n\n' +
  'Hi — attached is our quote for 14 yards of the Aldine boucle for the Meridian Ranch banquette, $1,260 total, ' +
  'ships in 3 weeks. Let us know if you would like to go ahead and we will hold the dye lot.';

settingsRouter.post(
  '/ai-routing/test',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const b = req.body ?? {};
    const provider = String(b.provider ?? '');
    const model = String(b.model ?? '').trim();
    if ((provider !== 'openai' && provider !== 'gemini') || !model) {
      return res.status(400).json({ error: 'Choose OpenAI or Gemini and a model to test.' });
    }
    const key = await keyFor(provider, orgId);
    if (!key) return res.status(400).json({ error: `Add the ${provider === 'openai' ? 'OpenAI' : 'Gemini'} key first.` });

    const price = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    const route: LlmRoute = { provider, model, inputPer1M: price(b.inputPer1M), outputPer1M: price(b.outputPer1M) };
    const started = Date.now();
    const result: AiRoutingTestResult = { ok: false, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sample: null };
    try {
      const r = await completeWith(route, key, {
        system: ROUTING_TEST_SYSTEM, user: ROUTING_TEST_EMAIL, maxTokens: 400, temperature: 0, json: true, timeoutMs: 25_000,
      });
      const sample = firstJson<Record<string, unknown>>(r.text);
      Object.assign(result, {
        ok: Boolean(sample),
        sample,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: costOf(route, r.inputTokens, r.outputTokens),
        error: sample ? undefined : 'It answered, but not with usable JSON — it would not read mail reliably.',
      });
    } catch (err) {
      result.error = (err as Error).message;
    }
    result.latencyMs = Date.now() - started;
    res.json({ data: result });
  }),
);
