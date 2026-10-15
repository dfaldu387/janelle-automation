import crypto from 'node:crypto';
import { gmail as gmailApi, type gmail_v1 } from '@googleapis/gmail';
import { googleClientForUser, orgSourceUserId } from '../lib/tokens.js';
import { STUDIO_DOMAINS, isStudioAddress } from '../lib/studioTeam.js';

export interface PdfAttachment {
  filename: string;
  attachmentId: string;
  /** Bytes, as Gmail reports them; 0 when the part did not say. */
  size: number;
}

export interface ParsedEmail {
  gmailId: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  subject: string;
  snippet: string;
  receivedAt: string | null;
  body: string;
  attachments: PdfAttachment[];
  /**
   * Every real attachment, of any type — for their names as much as their
   * contents: "Lemon Residence - Elevations.pdf" says which job an email is
   * about even when nothing reads the file.
   */
  files?: MessageAttachment[];
  /** RFC Message-ID header of this email, for threading a reply. */
  messageIdHeader: string;
  /**
   * Sent to a list rather than to a person — it carries List-Unsubscribe.
   *
   * The one header that marketing reliably sets and a person writing to
   * the studio never does. See `isBulkMail`.
   */
  bulk: boolean;
  /** Bcc header. Only present on a copy the sender kept; a recipient never sees it. */
  bcc: string;
  /** Delivered-To / List-Id / X-Original-To, the headers that show who a group relayed this to. */
  deliveredTo: string;
  listId: string;
}

/** Extract the bare address from a "Name <a@b.com>" header value. */
export function addressOf(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return (m ? m[1] : header).trim().toLowerCase();
}

/** Split a header of comma-separated recipients into bare addresses. */
export function addressesOf(header: string): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((h) => addressOf(h))
    .filter((a) => a.includes('@'));
}

/** Gmail client acting as the given user, or null if not connected. */
export async function gmailFor(userId: string): Promise<gmail_v1.Gmail | null> {
  const auth = await googleClientForUser(userId, 'gmail');
  if (!auth) return null;
  return gmailApi({ version: 'v1', auth });
}

/** Gmail client for whichever account the studio's Google connection runs through. */
export async function orgGmail(orgId: string | null): Promise<gmail_v1.Gmail | null> {
  if (!orgId) return null;
  const userId = await orgSourceUserId(orgId);
  return userId ? gmailFor(userId) : null;
}

/**
 * Gmail client for whoever should actually own a reply: the mailbox's own
 * connected owner when one is known, the studio's shared connection
 * otherwise.
 *
 * A team member's mail is read into this system without ever being shared
 * (migration 0018) — Carissa's personal inbox is hers, Joanna's is hers.
 * A draft answering one of their threads has to be created through THAT
 * same person's Google connection, or it does not land as a reply at all:
 * pushed through the studio's shared connection instead, it becomes a
 * stray, unthreaded message sitting in a completely different person's
 * Gmail — not the conversation it was supposed to answer, and never seen
 * by the person actually having it.
 */
export async function gmailForReply(orgId: string | null, ownerId: string | null | undefined): Promise<gmail_v1.Gmail | null> {
  if (ownerId) {
    const own = await gmailFor(ownerId);
    if (own) return own;
  }
  return orgGmail(orgId);
}

/** The connected account's own email address (to detect self / forwards). */
export async function getProfileEmail(gmail: gmail_v1.Gmail): Promise<string> {
  const res = await gmail.users.getProfile({ userId: 'me' });
  return (res.data.emailAddress ?? '').toLowerCase();
}

function header(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string {
  const h = payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function decodeBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';
  // Prefer text/plain; fall back to any part with data.
  const stack: gmail_v1.Schema$MessagePart[] = [payload];
  let plain = '';
  let html = '';
  while (stack.length) {
    const part = stack.shift()!;
    const data = part.body?.data;
    if (data) {
      const text = Buffer.from(data, 'base64').toString('utf8');
      if (part.mimeType === 'text/plain' && !plain) plain = text;
      if (part.mimeType === 'text/html' && !html) html = text;
    }
    if (part.parts) stack.push(...part.parts);
  }
  if (plain) return plain;
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Collect PDF attachments (filename + attachmentId) from a payload. */
function collectPdfAttachments(payload: gmail_v1.Schema$MessagePart | undefined): PdfAttachment[] {
  const out: PdfAttachment[] = [];
  const stack: gmail_v1.Schema$MessagePart[] = payload ? [payload] : [];
  while (stack.length) {
    const part = stack.shift()!;
    const isPdf =
      part.mimeType === 'application/pdf' ||
      (part.filename ?? '').toLowerCase().endsWith('.pdf');
    if (isPdf && part.body?.attachmentId) {
      out.push({
        filename: part.filename || 'attachment.pdf',
        attachmentId: part.body.attachmentId,
        // Gmail reports the size on the part, so an oversized attachment is
        // skipped without spending the download on it.
        size: part.body.size ?? 0,
      });
    }
    if (part.parts) stack.push(...part.parts);
  }
  return out;
}

/**
 * Senders that are machinery rather than correspondence.
 *
 * The studio's own tools mail constantly — Slack telling it someone joined
 * the workspace, GitHub relaying a bot's comment on a pull request. None of
 * it is studio work, and every one of them used to cost three Claude calls
 * (classify, raise a task, draft a reply) and land in the Inbox next to
 * real vendor mail.
 *
 * Matched on the sending DOMAIN, deliberately, rather than on a "no-reply"
 * local part: a great many vendors send their order confirmations from
 * no-reply@, and that is exactly the mail the studio cannot afford to miss.
 *
 * NOT here, on purpose: Dropbox, Drive, Box and WeTransfer. Their mail runs
 * both ways — a sign-in notice is noise, but "Carlos shared Lemon Residence
 * elevations with you" is how a drawing or a quote actually reaches the
 * studio, and losing one of those costs far more than reading a few sign-in
 * notices. The task prompt already declines to raise work off a file-share
 * notification, so the noise stops there rather than here.
 *
 * Extend with INGEST_IGNORE_DOMAINS (comma-separated) without a code change.
 */
const BUILT_IN_IGNORED_DOMAINS = [
  // Chat and collaboration
  'slack.com', 'slack-mail.com', 'zoom.us', 'atlassian.com', 'atlassian.net',
  'notion.so', 'figma.com', 'loom.com', 'asana.com', 'trello.com',
  'monday.com', 'clickup.com', 'airtable.com',
  // Developer tooling — this repo's own bots reach the studio through these
  'github.com', 'gitlab.com', 'vercel.com', 'netlify.com', 'sentry.io',
  'circleci.com', 'npmjs.com',
  // Sign-in and security alerts only. Drive's own sharing mail comes from
  // google.com and docs.google.com, which are deliberately left readable.
  'accounts.google.com',
  // Social
  'linkedin.com', 'facebookmail.com', 'facebook.com', 'twitter.com', 'x.com',
  'instagram.com', 'pinterest.com',
];

/** Domains the studio has added on top of the built-in list. */
function extraIgnoredDomains(): string[] {
  return (process.env.INGEST_IGNORE_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

export function ignoredDomains(): string[] {
  return [...BUILT_IN_IGNORED_DOMAINS, ...extraIgnoredDomains()];
}

/**
 * Gmail search terms that leave the noise out of the listing entirely.
 *
 * Cheaper than filtering after the fact: excluded mail is never listed, so
 * it costs nothing on every later pass either. Note there is no `is:unread`
 * here and there must never be one — the studio reads its mail in Gmail
 * first, and mail already opened is exactly the mail it wants read.
 */
export function ignoredSenderQuery(): string {
  return ignoredDomains()
    .map((d) => `-from:${d}`)
    .join(' ');
}

/**
 * Everything the studio does not want read, as Gmail search terms.
 *
 * `-category:promotions` is the cheap half of keeping advertising out: Gmail
 * has already sorted the studio's mail, and a message it filed under
 * Promotions is a fabric house's seasonal mailer, not a quote. Excluded in
 * the query, so it is never listed, never fetched, and never costs a Claude
 * call — on this pass or any later one.
 *
 * Deliberately NOT `-category:social` or `-category:updates`: order
 * confirmations and shipping notices land in Updates, and those are exactly
 * the mail this system exists to read.
 */
export function noiseQuery(): string {
  return `-category:promotions ${ignoredSenderQuery()}`;
}

/** Gmail's OR list caps out well before this; a long query is rejected. */
const MAX_QUERY_DOMAINS = 25;

/**
 * Narrow a PERSONAL mailbox to the studio's own correspondence.
 *
 * The shared address can be read whole — everything in it is the studio's.
 * A team member's own Google is not: it has their bank, their doctor and
 * their family in it, and the honest way to keep that out of a work system
 * is never to fetch it. So their mailbox is read only where it overlaps
 * with people the studio already knows — its own addresses, its suppliers,
 * its clients.
 *
 * The cost is real and worth stating: a genuine work email from a sender
 * nobody has dealt with before is not picked up on the first pass. It
 * arrives once that vendor or client exists on file, and anything urgent
 * reaches the studio's own address anyway.
 */
export function studioOnlyQuery(domains: string[], addresses: string[]): string {
  const terms = [...new Set([...addresses, ...domains].map((d) => d.trim().toLowerCase()).filter(Boolean))]
    .slice(0, MAX_QUERY_DOMAINS);
  if (!terms.length) return '';
  const list = terms.join(' OR ');
  // Either side of the conversation: mail from them, and mail the studio
  // sent them that they replied to.
  return `{from:(${list}) to:(${list}) cc:(${list})}`;
}

/**
 * The other half: mail sent to a list, whatever Gmail made of it.
 *
 * `List-Unsubscribe` is set by every bulk sender and by no one writing a
 * real message, so it catches the marketing Gmail did not categorise. The
 * risk is a supplier who sends genuine quotes through a bulk mailer, which
 * is why an attachment excuses it — a PDF is how a quote, an invoice or an
 * order confirmation arrives, and no advertisement needs one to make its
 * point. The caller also spares known vendors outright.
 */
export function isBulkMail(email: ParsedEmail): boolean {
  if (!email.bulk) return false;
  if ((email.files?.length ?? 0) > 0 || email.attachments.length > 0) return false;
  return !isStudioCorrespondence(email);
}

/**
 * Mail a person wrote to the studio, even though a list relayed it.
 *
 * Google Groups (team@) set List-Unsubscribe on everything they relay, so an
 * architect writing to the Team group looked exactly like a mailer. Two things
 * no advertiser does tell them apart: the list is the studio's OWN (List-Id on
 * the studio domain), or a teammate is copied by name on Cc or Bcc.
 */
export function isStudioCorrespondence(email: ParsedEmail): boolean {
  const listDomain = (email.listId.match(/<([^>]+)>/)?.[1] ?? email.listId).trim().toLowerCase();
  if (listDomain && STUDIO_DOMAINS.some((d) => listDomain.endsWith(d))) return true;
  return [...addressesOf(email.cc), ...addressesOf(email.bcc)].some((a) => isStudioAddress(a));
}

/**
 * One page of message ids, with the token for the next.
 *
 * The caller pages until Gmail stops offering one. Reading only the first
 * page is what let mail go missing: Gmail answers newest-first, so a busy
 * day filled the page with new messages and quietly left the older ones
 * unlisted until they aged out of the search window entirely.
 */
export async function listMessagePage(
  gmail: gmail_v1.Gmail,
  query: string,
  pageToken?: string,
  max = 100,
): Promise<{ ids: string[]; nextPageToken?: string }> {
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: max, pageToken });
  return {
    ids: (res.data.messages ?? []).map((m) => m.id!).filter(Boolean),
    nextPageToken: res.data.nextPageToken ?? undefined,
  };
}

/**
 * Every message matching a query, oldest first, up to `cap`.
 *
 * Oldest-first is the point. Work the list in the order the mail arrived and
 * an interrupted pass leaves a clean boundary behind it — everything before
 * the stopping point is done — so the next pass resumes instead of starting
 * over at the newest message and pushing the backlog further away.
 */
export async function listAllMessageIds(
  gmail: gmail_v1.Gmail,
  query: string,
  cap = 500,
): Promise<{ ids: string[]; capped: boolean }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listMessagePage(gmail, query, pageToken, Math.min(100, cap - ids.length));
    ids.push(...page.ids);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < cap);
  // Gmail returns newest-first within and across pages.
  return { ids: ids.reverse(), capped: Boolean(pageToken) };
}

/**
 * Whether this sender is machinery. The query above keeps almost all of it
 * out; this catches the rest — a custom query, or a domain that slipped
 * past Gmail's own matching.
 */
export function isIgnoredSender(from: string): boolean {
  const address = addressOf(from || '');
  const at = address.lastIndexOf('@');
  if (at === -1) return false;
  const domain = address.slice(at + 1);
  return ignoredDomains().some((d) => domain === d || domain.endsWith(`.${d}`));
}

export interface EmailLink {
  url: string;
  /** The domain, so "the Canva link" can be found without reading the URL. */
  host: string;
}

/**
 * Every link in a message body.
 *
 * Done with a regex rather than by asking Claude: it is exact, free, and
 * cannot invent a URL that was never there — which matters most for the
 * thing people ask for by name ("send me the Canva link"). Tracking and
 * unsubscribe machinery is dropped so the list stays worth reading.
 */
const LINK_NOISE = /googleusercontent|gstatic|doubleclick|list-manage|mailchimp|sendgrid|unsubscribe|\.gif|\.png|\.jpg/i;

export function linksIn(body: string): EmailLink[] {
  const found = new Map<string, EmailLink>();
  // Stop at whitespace and at the punctuation that usually closes a URL in
  // prose, so a trailing full stop or bracket does not become part of it.
  for (const match of body.matchAll(/https?:\/\/[^\s<>"'`)\]}]+/g)) {
    const url = match[0].replace(/[.,;:!?]+$/, '');
    if (url.length > 500 || LINK_NOISE.test(url)) continue;
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (!found.has(url)) found.set(url, { url, host });
    } catch {
      // Not a URL the platform can parse; not worth storing.
    }
    if (found.size >= 25) break;
  }
  return [...found.values()];
}

/** What the studio has sent lately: latest time per recipient, and per thread. */
export interface SentMail {
  /** Lower-cased address → the last time the studio wrote to it. */
  byAddress: Map<string, string>;
  /** Gmail thread id → the last time the studio wrote on that thread. */
  byThread: Map<string, string>;
}

/**
 * The studio's own outgoing mail, as metadata.
 *
 * Ingestion runs `-in:sent` on purpose — outgoing mail is not intelligence
 * to classify, and drafting a reply to it would be absurd. But it is the
 * only record that a person actually did the thing: that a nudge went out,
 * that somebody answered the email a task was raised from. Without it a
 * follow-up settled in Gmail sat in the review queue for ever, and a task
 * being actively worked stayed in Open.
 *
 * One sweep serves both, because they want the same messages read two ways.
 * Recipients and dates only — never a body.
 */
export async function readSentMail(
  gmail: gmail_v1.Gmail,
  days: number,
  max = 60,
): Promise<SentMail> {
  const byAddress = new Map<string, string>();
  const byThread = new Map<string, string>();
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `in:sent newer_than:${Math.max(1, Math.round(days))}d`,
    maxResults: max,
  });
  for (const m of res.data.messages ?? []) {
    if (!m.id) continue;
    try {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['To', 'Cc', 'Bcc'],
      });
      const sentAt = msg.data.internalDate
        ? new Date(Number(msg.data.internalDate)).toISOString()
        : new Date().toISOString();

      const threadId = msg.data.threadId ?? m.threadId ?? '';
      if (threadId) {
        const seen = byThread.get(threadId);
        if (!seen || seen < sentAt) byThread.set(threadId, sentAt);
      }

      const payload = msg.data.payload;
      for (const address of [
        ...addressesOf(header(payload, 'To')),
        ...addressesOf(header(payload, 'Cc')),
        ...addressesOf(header(payload, 'Bcc')),
      ]) {
        const seen = byAddress.get(address);
        if (!seen || seen < sentAt) byAddress.set(address, sentAt);
      }
    } catch {
      // One unreadable message must not cost the whole sweep.
    }
  }
  return { byAddress, byThread };
}

/** List message ids matching a Gmail search query (e.g. "newer_than:2d"). */
export async function listMessageIds(
  gmail: gmail_v1.Gmail,
  query: string,
  max = 25,
): Promise<string[]> {
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: max });
  return (res.data.messages ?? []).map((m) => m.id!).filter(Boolean);
}

export async function getEmail(gmail: gmail_v1.Gmail, id: string): Promise<ParsedEmail> {
  const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const msg = res.data;
  const payload = msg.payload;
  const dateMs = msg.internalDate ? Number(msg.internalDate) : null;
  return {
    gmailId: msg.id!,
    threadId: msg.threadId ?? '',
    from: header(payload, 'From'),
    to: header(payload, 'To'),
    cc: header(payload, 'Cc'),
    replyTo: header(payload, 'Reply-To'),
    subject: header(payload, 'Subject'),
    snippet: msg.snippet ?? '',
    receivedAt: dateMs ? new Date(dateMs).toISOString() : null,
    body: decodeBody(payload).slice(0, 12000),
    bulk: Boolean(header(payload, 'List-Unsubscribe')),
    bcc: header(payload, 'Bcc'),
    deliveredTo: header(payload, 'Delivered-To') || header(payload, 'X-Original-To'),
    listId: header(payload, 'List-Id'),
    attachments: collectPdfAttachments(payload),
    files: attachmentsOf(payload),
    messageIdHeader: header(payload, 'Message-ID') || header(payload, 'Message-Id'),
  };
}

// ── Live reading, for the assistant ─────────────────────────
// Ingestion only ever wanted PDFs, and only from the last few days. The
// assistant is asked for anything — last spring's floor plan, a photo a
// client sent, a spreadsheet of finishes — so it reads the mailbox itself.

/** Any attachment on a message, whatever its type. */
export interface MessageAttachment {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

/** A message as a search result: enough to choose one, not to read it. */
export interface MessageSummary {
  gmailId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  receivedAt: string | null;
}

/**
 * Every real attachment on a message.
 *
 * "Real" is doing the work: a signature logo or a pasted screenshot is an
 * attachment to Gmail, carries a filename like image001.png, and would bury
 * the one drawing someone actually sent. Those parts are the ones referenced
 * from the HTML body by Content-ID and marked inline, so that is what is
 * left out. An inline part with no Content-ID is kept — some clients mark
 * genuine attachments inline for no reason.
 */
export function attachmentsOf(payload: gmail_v1.Schema$MessagePart | undefined): MessageAttachment[] {
  const out: MessageAttachment[] = [];
  const stack: gmail_v1.Schema$MessagePart[] = payload ? [payload] : [];
  while (stack.length) {
    const part = stack.shift()!;
    if (part.filename && part.body?.attachmentId) {
      const disposition = header(part, 'Content-Disposition').toLowerCase();
      const embedded = disposition.startsWith('inline') && Boolean(header(part, 'Content-ID'));
      if (!embedded) {
        out.push({
          filename: part.filename,
          mimeType: part.mimeType || 'application/octet-stream',
          attachmentId: part.body.attachmentId,
          size: part.body.size ?? 0,
        });
      }
    }
    if (part.parts) stack.push(...part.parts);
  }
  return out;
}

/** A readable message plus every real attachment on it. */
export async function getMessageWithAttachments(
  gmail: gmail_v1.Gmail,
  id: string,
): Promise<ParsedEmail & { files: MessageAttachment[] }> {
  const email = await getEmail(gmail, id);
  return { ...email, files: email.files ?? [] };
}

/**
 * Search the whole mailbox with Gmail's own query language.
 *
 * Headers only — a search that fetched every body would spend seconds on
 * messages nobody is going to open. Fetched in parallel because each one is
 * a separate request and they are independent.
 */
export async function searchMessages(
  gmail: gmail_v1.Gmail,
  query: string,
  max = 10,
): Promise<MessageSummary[]> {
  const ids = await listMessageIds(gmail, query, max);
  const found = await Promise.all(
    ids.map(async (id) => {
      const res = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject'],
      });
      const msg = res.data;
      const dateMs = msg.internalDate ? Number(msg.internalDate) : null;
      return {
        gmailId: msg.id!,
        threadId: msg.threadId ?? '',
        from: header(msg.payload, 'From'),
        to: header(msg.payload, 'To'),
        subject: header(msg.payload, 'Subject'),
        snippet: msg.snippet ?? '',
        receivedAt: dateMs ? new Date(dateMs).toISOString() : null,
      };
    }),
  );
  return found;
}

/**
 * Where a message opens in Gmail, for a person who wants the original.
 *
 * Targets the account by address (`?authuser=`) when the mailbox email is
 * known, so it opens the right account whatever its index is in the viewer's
 * Chrome profile — a shared studio mailbox is rarely the first account signed
 * in. Falls back to the first account (`/u/0/`) only when the address is
 * unknown (nothing connected yet, or before migration 0038).
 */
export function gmailMessageUrl(gmailId: string, mailboxEmail?: string | null): string {
  const base = 'https://mail.google.com/mail/';
  return mailboxEmail
    ? `${base}?authuser=${encodeURIComponent(mailboxEmail)}#all/${gmailId}`
    : `${base}u/0/#all/${gmailId}`;
}

/** Download a single PDF attachment's bytes. */
export async function downloadAttachment(
  gmail: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  const data = res.data.data ?? '';
  return Buffer.from(data, 'base64');
}

export interface DraftContent {
  to: string; cc?: string; bcc?: string; subject: string; body: string;
  /** Rendered alongside `body` as multipart/alternative when given. */
  html?: string;
  /** Set together, to make this a proper reply sitting in the original thread. */
  threadId?: string; inReplyTo?: string;
}

/** A draft (or sent message), as Gmail's own ids for it — never its text. */
export interface DraftHandle {
  draftId: string;
  /** The message underneath the draft; this is what a "#all/<id>" link opens. */
  messageId: string;
}

/**
 * The base64url `raw` field every send/draft call needs, built once so
 * sending and drafting can never drift into different MIME shapes.
 */
function buildRawMime(opts: DraftContent): string {
  const headers = [`To: ${opts.to}`];
  if (opts.cc) headers.push(`Cc: ${opts.cc}`);
  // Bcc is a header Gmail strips on the way out; recipients never see it.
  if (opts.bcc) headers.push(`Bcc: ${opts.bcc}`);
  headers.push(`Subject: ${encodeHeader(opts.subject)}`, 'MIME-Version: 1.0');
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`);
    headers.push(`References: ${opts.inReplyTo}`);
  }

  let message: string;
  if (opts.html) {
    // multipart/alternative, plain text FIRST.
    //
    // Order is the specification, not a preference: a client shows the LAST
    // part it can render, so text before HTML means a modern client shows
    // the design and a text-only one still gets a readable message. Sending
    // HTML alone is also what spam filters score hardest against.
    const boundary = `b${crypto.randomBytes(12).toString('hex')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    message = [
      ...headers,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap(Buffer.from(opts.body, 'utf8').toString('base64')),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap(Buffer.from(opts.html, 'utf8').toString('base64')),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    message = [...headers, '', opts.body].join('\r\n');
  }

  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Create a Gmail draft (never sent). Pass `threadId` + `inReplyTo` to make
 * it a proper reply sitting in the thread it answers, rather than a new,
 * unthreaded message the recipient has no context for.
 */
export async function createDraft(gmail: gmail_v1.Gmail, opts: DraftContent): Promise<DraftHandle> {
  const raw = buildRawMime(opts);
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: opts.threadId ? { raw, threadId: opts.threadId } : { raw } },
  });
  return { draftId: res.data.id ?? '', messageId: res.data.message?.id ?? '' };
}

/**
 * Replace a draft's content in place — an edit made in the app, carried
 * into Gmail. When the caller does not already know which thread it
 * belongs to, this reads the draft back first so the edit cannot
 * accidentally un-reply it — Gmail treats a draft with no `threadId` on the
 * update as a fresh, unthreaded message.
 */
export async function updateDraft(
  gmail: gmail_v1.Gmail,
  draftId: string,
  opts: DraftContent,
): Promise<DraftHandle> {
  let threadId = opts.threadId;
  if (!threadId) {
    try {
      const existing = await gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'metadata' });
      threadId = existing.data.message?.threadId ?? undefined;
    } catch {
      // Draft may already be gone (sent or deleted by hand); fall through
      // and let the update call below report that properly.
    }
  }
  const raw = buildRawMime(opts);
  const res = await gmail.users.drafts.update({
    userId: 'me',
    id: draftId,
    requestBody: { message: threadId ? { raw, threadId } : { raw } },
  });
  return { draftId: res.data.id ?? draftId, messageId: res.data.message?.id ?? '' };
}

/**
 * Remove a draft from Gmail. Swallows the error rather than throwing: the
 * app's own copy of the draft is the thing the caller is actually deleting,
 * and a draft already sent or removed by hand in Gmail must not block that.
 */
export async function deleteDraft(gmail: gmail_v1.Gmail, draftId: string): Promise<void> {
  try {
    await gmail.users.drafts.delete({ userId: 'me', id: draftId });
  } catch (err) {
    console.error('[gmail] could not delete draft', draftId, (err as Error).message);
  }
}

/**
 * Send one message, now.
 *
 * Everything else the studio writes is left as a draft for a person to read
 * and send, and the app says so on several screens. This function is the
 * deliberate exception, and each caller is kept deliberately narrow:
 *   - an account invitation, triggered by a principal pressing Add, to an
 *     address they just typed;
 *   - the midday task reminder (services/middayReminder.ts), a scheduled
 *     send with no click behind it at all, to each teammate's and the
 *     owner's own address.
 * Both stay inside the studio: nothing here reaches a client or a supplier.
 *
 * `gmail.compose`, already granted, covers sending as well as drafting, so
 * this needs no new consent from the studio.
 */
export async function sendMessage(gmail: gmail_v1.Gmail, opts: DraftContent): Promise<string> {
  const raw = buildRawMime(opts);
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return res.data.id ?? '';
}

/** RFC 5322 forbids a line over 998 characters; base64 is wrapped at 76. */
function wrap(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n');
}

/** A subject with anything outside ASCII has to say so, or it arrives as mojibake. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}
