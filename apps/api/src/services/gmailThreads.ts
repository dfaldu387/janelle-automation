import type { gmail_v1 } from '@googleapis/gmail';
import { supabaseAdmin } from '../lib/supabase.js';
import { STUDIO_MAILBOXES, STUDIO_TEAM, addressOf } from '../lib/studioTeam.js';
import { gmailFor } from './gmail.js';

/**
 * "Did the team already reply?" — Gmail thread reading for reminder v2
 * (fast track, Task D2).
 *
 * READ-ONLY. This file only ever calls users.threads.get. It must never
 * send, draft, modify, trash or label mail.
 *
 * Thread IDs are PER MAILBOX: the same conversation has a different thread
 * ID in each person's Gmail. Always pass the mailbox the thread ID came from
 * (emails.owner_id → tasks.source_mailbox_id).
 *
 * Gmail errors never throw out of these functions (spec §8.6): they come
 * back as `error`, and the caller skips that task until the next run.
 */

export interface ThreadMessage {
  id: string;
  /** Lower-case sender address, '' when Gmail gave none. */
  from: string;
  /** When Gmail received/sent it (internalDate). */
  at: Date;
}

export interface ThreadResult {
  messages: ThreadMessage[];
  error?: string;
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return msg.payload?.headers?.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase())?.value ?? '';
}

/**
 * Every message in one thread of one mailbox, oldest first: sender and time.
 * Metadata only (From/Date headers) — bodies are never fetched.
 *
 * `client` lets a caller supply its own Gmail client for that mailbox (e.g. a
 * read-only script that must not write refreshed tokens back); by default the
 * mailbox's normal connection is used.
 */
export async function getThread(mailboxUserId: string, threadId: string, client?: gmail_v1.Gmail | null): Promise<ThreadResult> {
  try {
    const gmail = client ?? (await gmailFor(mailboxUserId));
    if (!gmail) return { messages: [], error: 'mailbox has no working Google connection' };
    const res = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'metadata',
      metadataHeaders: ['From', 'Date'],
    });
    const messages = (res.data.messages ?? [])
      .map((m) => ({
        id: m.id ?? '',
        from: addressOf(header(m, 'From')),
        at: new Date(Number(m.internalDate ?? 0) || Date.parse(header(m, 'Date')) || 0),
      }))
      .filter((m) => m.id && m.at.getTime() > 0)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    return { messages };
  } catch (err) {
    const e = err as { code?: number; message?: string };
    return { messages: [], error: `${e.code ? `${e.code} ` : ''}${e.message ?? 'Gmail error'}` };
  }
}

const normalise = (addresses: Iterable<string>) =>
  new Set([...addresses].map((a) => addressOf(a)).filter(Boolean));

export interface RepliedResult {
  replied: boolean;
  /** The first team message after `after`. */
  messageId?: string;
  at?: Date;
  error?: string;
}

/**
 * True if any message in the thread is FROM a team address and dated after
 * `after` (typically the task's created_at). Returns the earliest such message.
 */
export async function teamRepliedAfter(opts: {
  mailboxUserId: string;
  threadId: string;
  after: Date;
  teamAddresses: Iterable<string>;
  gmail?: gmail_v1.Gmail | null;
}): Promise<RepliedResult> {
  const thread = await getThread(opts.mailboxUserId, opts.threadId, opts.gmail);
  if (thread.error) return { replied: false, error: thread.error };
  const team = normalise(opts.teamAddresses);
  const hit = thread.messages.find((m) => team.has(m.from) && m.at.getTime() > opts.after.getTime());
  return hit ? { replied: true, messageId: hit.id, at: hit.at } : { replied: false };
}

export interface InboundResult {
  /** Latest message from someone outside the team, or null if there is none. */
  at: Date | null;
  messageId?: string;
  error?: string;
}

/** The latest message in the thread from a non-team address (for "client waiting > 24h"). */
export async function lastInboundAt(opts: {
  mailboxUserId: string;
  threadId: string;
  teamAddresses: Iterable<string>;
  gmail?: gmail_v1.Gmail | null;
}): Promise<InboundResult> {
  const thread = await getThread(opts.mailboxUserId, opts.threadId, opts.gmail);
  if (thread.error) return { at: null, error: thread.error };
  const team = normalise(opts.teamAddresses);
  const inbound = thread.messages.filter((m) => m.from && !team.has(m.from));
  const last = inbound[inbound.length - 1];
  return last ? { at: last.at, messageId: last.id } : { at: null };
}

/**
 * Every address that counts as "the team writing": profiles.email for the
 * org, plus every address in lib/studioTeam.ts — including the personal Gmail
 * addresses of the people without a studio mailbox, and the shared studio
 * mailbox (systems@).
 *
 * Note: system emails also come from systems@. A thread that only contains
 * an automatic system email would read as "team replied"; v2 reminders start
 * NEW threads, so this does not happen today — revisit if that changes.
 */
export async function getTeamAddresses(orgId: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const person of STUDIO_TEAM) {
    out.add(addressOf(person.email));
    for (const other of person.otherEmails ?? []) out.add(addressOf(other));
  }
  for (const mailbox of STUDIO_MAILBOXES) out.add(addressOf(mailbox));
  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin.from('profiles').select('email').eq('org_id', orgId);
    if (error) console.error('[gmailThreads] could not read profile emails:', error.message);
    for (const row of (data ?? []) as { email: string | null }[]) out.add(addressOf(row.email));
  }
  out.delete('');
  return out;
}
