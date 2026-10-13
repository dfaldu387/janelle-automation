import { env } from '../env.js';
import { decrypt, encrypt } from './crypto.js';
import { resolveOrgId } from './org.js';
import { supabaseAdmin } from './supabase.js';

/**
 * The studio's Slack connection, set from Settings rather than from a deploy.
 *
 * Three separate keys in `organizations.settings`, each written through
 * merge_org_settings (migration 0023) so none can overwrite another — the
 * sync writes its own progress every few minutes while an admin may be
 * saving the channel at the same moment:
 *
 *   slack_bot_token_encrypted  the bot token, AES-256-GCM like every other key
 *   slack_config               channel + which updates to send (set by an admin)
 *   slack_sync                 the sync's own bookkeeping (cursors, last result)
 *
 * The token is never sent to the browser; the settings screen gets the last
 * four characters. SLACK_BOT_TOKEN / SLACK_CHANNEL in the environment stand in
 * until the studio sets its own.
 */

const TOKEN_FIELD = 'slack_bot_token_encrypted';
const CONFIG_FIELD = 'slack_config';
const SYNC_FIELD = 'slack_sync';

/** Where each task report goes (services/slackReport.ts). Blank = that report is not sent. */
export interface ReportChannels {
  completed: string;
  pending: string;
  overdue: string;
}

export interface SlackConfig {
  /** Channel name (#project-updates) or ID. */
  channel: string;
  /** Master switch: connected but paused keeps the token and stops posting. */
  enabled: boolean;
  /** When the connection was switched on. Work finished before it is not announced. */
  enabledAt: string | null;
  /** Which updates go to Slack. */
  tasks: boolean;
  followUps: boolean;
  /** The once-a-day reminder of what is overdue, due and waiting. */
  dailyDigest: boolean;
  /** The completed / pending / overdue task reports, three times a day. */
  reportChannels: ReportChannels;
  /**
   * Each person's morning priorities and end-of-day check-in as a direct
   * message, and the team summary to the owner — the same as the reminder
   * emails, for the people who live in Slack. Needs users:read.email and
   * im:write on the bot.
   */
  personalReminders: boolean;
}

export interface SlackSyncState {
  /** updated_at of the last task the sync fully handled. */
  taskCursor: string | null;
  followUpCursor: string | null;
  lastRunAt: string | null;
  lastPosted: number;
  /** Set when Slack refused something the admin has to fix; cleared by the next clean run. */
  lastError: string | null;
}

export interface ResolvedSlack {
  token: string | null;
  config: SlackConfig;
  source: 'studio' | 'environment' | 'none';
  /** A token and a channel are both present. */
  connected: boolean;
}

export interface SlackSettingsView {
  connected: boolean;
  source: ResolvedSlack['source'];
  keyHint: string | null;
  channel: string;
  enabled: boolean;
  tasks: boolean;
  followUps: boolean;
  dailyDigest: boolean;
  reportChannels: ReportChannels;
  personalReminders: boolean;
  lastRunAt: string | null;
  lastPosted: number;
  lastError: string | null;
}

const NO_REPORT_CHANNELS: ReportChannels = { completed: '', pending: '', overdue: '' };

const DEFAULTS: SlackConfig = {
  channel: '', enabled: true, enabledAt: null, tasks: true, followUps: true, dailyDigest: true,
  reportChannels: NO_REPORT_CHANNELS, personalReminders: true,
};

const cleanChannel = (c: string) => c.trim().replace(/^#/, '');

function readReportChannels(raw: unknown): ReportChannels {
  const r = (raw ?? {}) as Partial<ReportChannels>;
  const pick = (v: unknown) => (typeof v === 'string' ? cleanChannel(v) : '');
  return { completed: pick(r.completed), pending: pick(r.pending), overdue: pick(r.overdue) };
}

async function readSettings(orgId: string): Promise<Record<string, unknown>> {
  if (!supabaseAdmin) return {};
  const { data, error } = await supabaseAdmin.from('organizations').select('settings').eq('id', orgId).maybeSingle();
  if (error) throw new Error(error.message);
  return ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
}

async function mergeSettings(orgId: string, patch: Record<string, unknown>): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const { error } = await supabaseAdmin.rpc('merge_org_settings', { p_org_id: orgId, p_patch: patch });
  if (error) throw new Error(error.message);
}

function readConfig(settings: Record<string, unknown>): SlackConfig {
  const raw = (settings[CONFIG_FIELD] ?? {}) as Partial<SlackConfig>;
  return {
    channel: typeof raw.channel === 'string' ? raw.channel : DEFAULTS.channel,
    enabled: raw.enabled !== false,
    enabledAt: typeof raw.enabledAt === 'string' ? raw.enabledAt : null,
    tasks: raw.tasks !== false,
    followUps: raw.followUps !== false,
    dailyDigest: raw.dailyDigest !== false,
    reportChannels: readReportChannels(raw.reportChannels),
    personalReminders: raw.personalReminders !== false,
  };
}

export async function resolveSlack(given?: string | null): Promise<ResolvedSlack> {
  const orgId = await resolveOrgId(given);
  const config: SlackConfig = { ...DEFAULTS, channel: env.slack.channel };
  let token: string | null = env.slack.botToken || null;
  let source: ResolvedSlack['source'] = token ? 'environment' : 'none';

  if (orgId && supabaseAdmin) {
    try {
      const settings = await readSettings(orgId);
      Object.assign(config, readConfig(settings), { channel: readConfig(settings).channel || env.slack.channel });
      const stored = settings[TOKEN_FIELD];
      if (typeof stored === 'string' && stored) {
        try {
          token = decrypt(stored);
          source = 'studio';
        } catch {
          // Encrypted under a different TOKEN_ENCRYPTION_KEY: fall back rather than fail every sync.
          console.error('[slack] stored token could not be decrypted — using the environment token');
        }
      }
    } catch (err) {
      console.error('[slack] settings unreadable, using the environment:', (err as Error).message);
    }
  }
  return { token, config, source, connected: Boolean(token && config.channel) };
}

export async function readSlackSyncState(orgId: string): Promise<SlackSyncState> {
  const raw = ((await readSettings(orgId))[SYNC_FIELD] ?? {}) as Partial<SlackSyncState>;
  return {
    taskCursor: raw.taskCursor ?? null,
    followUpCursor: raw.followUpCursor ?? null,
    lastRunAt: raw.lastRunAt ?? null,
    lastPosted: raw.lastPosted ?? 0,
    lastError: raw.lastError ?? null,
  };
}

export async function saveSlackSyncState(orgId: string, state: SlackSyncState): Promise<void> {
  await mergeSettings(orgId, { [SYNC_FIELD]: state });
}

/** Shape check — a typo should fail on Save, not on the first task. Bot tokens begin xoxb-. */
export function looksLikeSlackBotToken(token: string): boolean {
  return /^xoxb-[A-Za-z0-9-]{20,}$/.test(token.trim());
}

export async function saveSlackToken(orgId: string, token: string): Promise<void> {
  await mergeSettings(orgId, { [TOKEN_FIELD]: encrypt(token.trim()) });
}

export async function clearSlackToken(orgId: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const settings = await readSettings(orgId);
  delete settings[TOKEN_FIELD];
  delete settings[SYNC_FIELD];
  const { error } = await supabaseAdmin.from('organizations').update({ settings }).eq('id', orgId);
  if (error) throw new Error(error.message);
}

/**
 * Save the channel and switches. `enabledAt` is stamped when the connection is
 * first switched on (or switched back on), so the channel is not flooded with
 * the whole backlog the moment an admin connects it.
 */
export async function saveSlackConfig(
  orgId: string,
  patch: Partial<Omit<SlackConfig, 'enabledAt' | 'reportChannels'>> & { reportChannels?: Partial<ReportChannels> },
): Promise<void> {
  const current = readConfig(await readSettings(orgId));
  const next: SlackConfig = {
    ...current,
    ...patch,
    reportChannels: readReportChannels({ ...current.reportChannels, ...patch.reportChannels }),
  };
  if (patch.channel !== undefined) next.channel = cleanChannel(patch.channel);
  if (next.enabled && (!current.enabled || !current.enabledAt)) next.enabledAt = new Date().toISOString();
  await mergeSettings(orgId, { [CONFIG_FIELD]: next });
}

/** What the settings screen may see. Never the token. */
export async function slackSettingsView(orgId: string): Promise<SlackSettingsView> {
  const resolved = await resolveSlack(orgId);
  const sync = await readSlackSyncState(orgId).catch(
    () => ({ lastRunAt: null, lastPosted: 0, lastError: null }) as Partial<SlackSyncState>,
  );
  return {
    connected: resolved.connected,
    source: resolved.source,
    keyHint: resolved.token ? resolved.token.slice(-4) : null,
    channel: resolved.config.channel,
    enabled: resolved.config.enabled,
    tasks: resolved.config.tasks,
    followUps: resolved.config.followUps,
    dailyDigest: resolved.config.dailyDigest,
    reportChannels: resolved.config.reportChannels,
    personalReminders: resolved.config.personalReminders,
    lastRunAt: sync.lastRunAt ?? null,
    lastPosted: sync.lastPosted ?? 0,
    lastError: sync.lastError ?? null,
  };
}
