import { env } from '../env.js';

/**
 * Slack Web API, and what a task or follow-up looks like in a channel.
 *
 * Plain fetch against slack.com/api rather than an SDK: three methods are
 * used (auth.test, chat.postMessage, chat.update), and the serverless
 * function this runs in is better without another dependency to bundle.
 *
 * The bot needs the `chat:write` scope, and must be invited to the channel
 * (`/invite @botname`) unless it also has `chat:write.public`.
 */

const API = 'https://slack.com/api';

/** Slack refused, or could not be reached. `code` is Slack's own error string. */
export class SlackError extends Error {
  constructor(
    public code: string,
    /** Seconds Slack asks us to wait, when it rate-limited the call. */
    public retryAfter?: number,
  ) {
    super(describeSlackError(code));
  }

  /** The admin has to change something in Slack or Settings; retrying will not help. */
  get needsAttention(): boolean {
    return !['ratelimited', 'network_error', 'service_unavailable', 'internal_error', 'fatal_error', 'request_timeout'].includes(this.code);
  }
}

/** What an admin can act on, for the codes they are likely to meet. */
export function describeSlackError(code: string): string {
  switch (code) {
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':
    case 'account_inactive':
    case 'token_expired':
      return 'Slack rejected the bot token — it may have been revoked. Paste a fresh Bot User OAuth Token.';
    case 'channel_not_found':
      return 'Slack cannot find that channel. Check the name, and for a private channel invite the bot first.';
    case 'not_in_channel':
      return 'The bot is not in that channel. In Slack, open the channel and run /invite @your-bot.';
    case 'is_archived':
      return 'That channel is archived.';
    case 'missing_scope':
      return 'The Slack app is missing a permission (chat:write for channels; users:read.email and im:write for direct messages). Add it under OAuth & Permissions and reinstall the app.';
    case 'users_not_found':
      return 'Nobody in the Slack workspace has that email address.';
    case 'ratelimited':
      return 'Slack is rate-limiting the bot; the sync will resume on its next run.';
    case 'network_error':
      return 'Could not reach Slack.';
    default:
      return `Slack said: ${code}`;
  }
}

async function call<T>(token: string, method: string, body: Record<string, unknown>, form = false): Promise<T> {
  let res: Response;
  try {
    // Slack's read methods (conversations.list) ignore a JSON body and fall
    // back to their defaults — public channels only, a page of 100 — so they
    // are sent form-encoded instead. The write methods take JSON.
    res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8',
      },
      body: form
        ? new URLSearchParams(Object.entries(body).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
        : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SlackError('network_error');
  }
  if (res.status === 429) throw new SlackError('ratelimited', Number(res.headers.get('retry-after') ?? 30));
  const data = (await res.json().catch(() => null)) as ({ ok: boolean; error?: string } & Record<string, unknown>) | null;
  if (!data) throw new SlackError('network_error');
  if (!data.ok) throw new SlackError(data.error ?? 'unknown_error');
  return data as unknown as T;
}

/** Slack wants an ID, or a #name; the settings store the name without its #. */
function target(channel: string): string {
  return /^[CGD][A-Z0-9]{8,}$/.test(channel) ? channel : `#${channel.replace(/^#/, '')}`;
}

export async function authTest(token: string): Promise<{ team: string; user: string }> {
  const r = await call<{ team: string; user: string }>(token, 'auth.test', {});
  return { team: r.team, user: r.user };
}

/**
 * A channel name reduced to what two spellings of the same name share.
 *
 * Slack turns "Fred Keeler - Hitching Post" into fred-keeler---hitching-post
 * and "OVI FF&E Inspections" into ovi-ff-e-inspections; a project's name and
 * its channel agree on the words, not the punctuation. Apostrophes go before
 * anything else so "Chamberlain's" becomes chamberlains, not chamberlain-s.
 */
export function normalizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface SlackChannel {
  id: string;
  name: string;
  isMember: boolean;
  /** A private channel only lists the bot if it was invited, and only an invite lets it post. */
  isPrivate: boolean;
}

/**
 * Channels the bot can see: every public one, and the private ones it is in.
 * Needs the channels:read and groups:read scopes — without them Slack answers
 * missing_scope and the caller falls back to explicit assignments only.
 */
export async function listChannels(token: string): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  let cursor: string | undefined;
  // 20 pages of 200 is far past any studio's channel count; the cap is a stop for a loop, not a limit.
  for (let page = 0; page < 20; page++) {
    const r = await call<{
      channels: { id: string; name: string; is_member?: boolean; is_private?: boolean }[];
      response_metadata?: { next_cursor?: string };
    }>(token, 'conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    }, true);
    for (const c of r.channels) out.push({ id: c.id, name: c.name, isMember: Boolean(c.is_member), isPrivate: Boolean(c.is_private) });
    cursor = r.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

/**
 * Join a public channel. Needs the channels:join scope; a private channel
 * cannot be joined by a bot at all, only invited to.
 */
export async function joinChannel(token: string, channelId: string): Promise<void> {
  await call(token, 'conversations.join', { channel: channelId }, true);
}

/**
 * The permissions the token was granted, as Slack reports them in a header.
 * Whether the bot can post in a public channel it has not joined depends on
 * chat:write.public, and only the token knows if it has it.
 */
export async function tokenScopes(token: string): Promise<string[]> {
  try {
    const res = await fetch(`${API}/auth.test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return (res.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export interface SlackMessage {
  text: string;
  blocks?: unknown[];
}

export async function postMessage(
  token: string,
  channel: string,
  msg: SlackMessage,
  threadTs?: string,
): Promise<{ ts: string; channel: string }> {
  const r = await call<{ ts: string; channel: string }>(token, 'chat.postMessage', {
    channel: target(channel),
    text: msg.text,
    blocks: msg.blocks,
    thread_ts: threadTs,
    username: 'Janelle Interiors',
    // A task title is not a link to unfurl.
    unfurl_links: false,
    unfurl_media: false,
  });
  return { ts: r.ts, channel: r.channel };
}

export async function updateMessage(token: string, channel: string, ts: string, msg: SlackMessage): Promise<void> {
  await call(token, 'chat.update', { channel, ts, text: msg.text, blocks: msg.blocks });
}

/**
 * The Slack account behind an email address, for a direct message. Needs
 * the users:read.email scope. Null when nobody in the workspace has that
 * address — a teammate on a personal Gmail, say — so the caller falls back
 * to email rather than failing the whole send.
 */
export async function lookupUserByEmail(token: string, email: string): Promise<string | null> {
  try {
    const r = await call<{ user?: { id: string } }>(token, 'users.lookupByEmail', { email }, true);
    return r.user?.id ?? null;
  } catch (err) {
    if (err instanceof SlackError && err.code === 'users_not_found') return null;
    throw err;
  }
}

/** The direct-message channel with one person, opened or found. Needs the im:write scope. */
export async function openDm(token: string, userId: string): Promise<string> {
  const r = await call<{ channel: { id: string } }>(token, 'conversations.open', { users: userId }, true);
  return r.channel.id;
}

// ── What goes in the channel ────────────────────────────────

/** Slack mrkdwn treats & < > as markup; everything else in a title is literal. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

const STATUS_ICON: Record<string, string> = {
  open: ':white_circle:',
  in_progress: ':large_blue_circle:',
  blocked: ':red_circle:',
  done: ':white_check_mark:',
  cancelled: ':no_entry_sign:',
};

export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;

/** The facts the sync compares to decide whether anything changed. */
export interface TaskState {
  status: string;
  assignee: string | null;
  due: string | null;
  nextStep: string | null;
}

export interface TaskCard extends TaskState {
  id: string;
  title: string;
  detail: string | null;
  project: string | null;
  category: string | null;
  /** Raised by the system from an email, rather than typed in. */
  fromEmail: boolean;
  completionNote: string | null;
}

function appLink(path: string): string | null {
  const base = (env.appUrl ?? '').replace(/\/+$/, '');
  return base ? `${base}${path}` : null;
}

function linkButton(label: string, url: string | null): unknown[] {
  return url ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: label }, url }] }] : [];
}

/** The task's message — rewritten in place whenever the task changes. */
export function taskMessage(t: TaskCard): SlackMessage {
  const fields = [
    `*Status*\n${STATUS_ICON[t.status] ?? ''} ${statusLabel(t.status)}`,
    `*Project*\n${t.project ? esc(t.project) : '—'}`,
    `*Assigned to*\n${t.assignee ? esc(t.assignee) : 'Unassigned'}`,
    `*Due*\n${t.due ?? 'No date'}`,
  ];
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${esc(clip(t.title, 200))}*` } },
    ...(t.detail ? [{ type: 'section', text: { type: 'mrkdwn', text: esc(clip(t.detail, 400)) } }] : []),
    { type: 'section', fields: fields.map((text) => ({ type: 'mrkdwn', text })) },
    ...(t.nextStep ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Next step:* ${esc(clip(t.nextStep, 300))}` } }] : []),
    ...(t.status === 'done' && t.completionNote
      ? [{ type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: ${esc(clip(t.completionNote, 300))}` } }]
      : []),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: t.fromEmail ? 'Raised automatically from an email' : 'Added by hand',
        },
      ],
    },
    ...linkButton('Open in Janelle', appLink('/tasks')),
  ];
  return { text: `${STATUS_ICON[t.status] ?? ''} ${esc(clip(t.title, 150))} — ${statusLabel(t.status)}`, blocks };
}

/** One line per thing that changed, for the reply under the task. */
export function describeTaskChange(before: Partial<TaskState>, now: TaskCard): string[] {
  const lines: string[] = [];
  if (before.status !== undefined && before.status !== now.status) {
    lines.push(
      now.status === 'done'
        ? `:white_check_mark: Marked *done*${now.completionNote ? ` — ${esc(clip(now.completionNote, 300))}` : ''}`
        : `${STATUS_ICON[now.status] ?? ''} Status: ${statusLabel(before.status)} → *${statusLabel(now.status)}*`,
    );
  }
  if (before.assignee !== undefined && before.assignee !== now.assignee) {
    lines.push(`:bust_in_silhouette: Assigned to *${now.assignee ? esc(now.assignee) : 'nobody'}*`);
  }
  if (before.due !== undefined && before.due !== now.due) {
    lines.push(`:calendar: Due date: ${before.due ?? 'none'} → *${now.due ?? 'none'}*`);
  }
  if (before.nextStep !== undefined && before.nextStep !== now.nextStep && now.nextStep) {
    lines.push(`:arrow_right: Next step: ${esc(clip(now.nextStep, 300))}`);
  }
  return lines;
}

export interface FollowUpCard {
  type: string;
  status: string;
  reason: string | null;
  project: string | null;
  vendor: string | null;
  target: string | null;
  draftSubject: string | null;
}

const FOLLOW_UP_TYPE: Record<string, string> = {
  vendor_silence: 'Vendor has gone quiet',
  client_approval_overdue: 'Client approval overdue',
  date_slipping: 'Date slipping',
  spec_gap: 'Spec gap',
};

const FOLLOW_UP_STATUS: Record<string, string> = {
  open: 'Needs a follow-up',
  drafted: 'Follow-up drafted — waiting for review',
  sent: 'Follow-up sent',
  done: 'Resolved',
  dismissed: 'Dismissed',
};

export const followUpStatusLabel = (s: string) => FOLLOW_UP_STATUS[s] ?? s;

export function followUpMessage(f: FollowUpCard, update = false): SlackMessage {
  const head = `:bell: *${FOLLOW_UP_TYPE[f.type] ?? 'Follow-up'}* — ${followUpStatusLabel(f.status)}`;
  const who = [f.vendor, f.project].filter(Boolean).map((s) => esc(s as string)).join(' · ');
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: head } },
    ...(f.reason ? [{ type: 'section', text: { type: 'mrkdwn', text: esc(clip(f.reason, 500)) } }] : []),
    ...(f.draftSubject && (f.status === 'drafted' || f.status === 'sent')
      ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Draft:* ${esc(clip(f.draftSubject, 200))}` } }]
      : []),
    ...(who ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: who }] }] : []),
    ...(update ? [] : linkButton('Review in Janelle', appLink('/follow-ups'))),
  ];
  return { text: `${FOLLOW_UP_TYPE[f.type] ?? 'Follow-up'} — ${followUpStatusLabel(f.status)}`, blocks };
}
