import { env } from '../env.js';
/**
 * The studio's email, as mail clients actually render it.
 *
 * Email is not the web. Outlook lays out with Word, which knows nothing of
 * flexbox or grid; most clients strip a `<style>` block; several rewrite
 * colours for dark mode. So everything here is a nested table with inline
 * styles and explicit colours — the dull answer, and the only one that
 * survives Outlook, Gmail, Apple Mail and a phone alike.
 *
 * Every message goes out as both HTML and plain text (see `sendMessage`).
 * The text half is not a fallback nobody reads: it is what a screen reader,
 * a watch, and a spam filter all judge the mail on.
 */

/**
 * The light-theme tokens, written out — a mail client cannot read our CSS.
 * Same values as `--brass` / `--good` / `--warn` / `--crit` in
 * apps/web/src/styles/index.css (light mode), so a task's colour means the
 * same thing here as it does on the board.
 */
const C = {
  brass: '#4DBC15',
  brassDeep: '#3A9A0C',
  ink: '#1F2327',
  inkSoft: '#5A6169',
  inkFaint: '#8D949C',
  surface: '#FFFFFF',
  paper: '#F4F5F7',
  line: '#DFE2E6',
  sunk: '#EEF0F2',
  good: '#2E9E3A',
  warn: '#D98A1F',
  crit: '#D63A2F',
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace";

export interface Mail {
  subject: string;
  text: string;
  html: string;
}

/**
 * A greeting that does not read as a database field.
 *
 * The name may be a real one ("Brianna Johnson"), or the local part of an
 * address standing in for one ("denish123"), because that is what is stored
 * when somebody is added without a name. Addressing a person as their login
 * is worse than not addressing them at all.
 */
function greeting(name: string): string {
  const clean = (name ?? '').trim();
  if (!clean) return 'Hello,';
  const first = clean.split(/\s+/)[0];
  // Digits, dots or underscores mean this came from an address, not a person.
  if (/[0-9._]/.test(first) || first.length < 2) return 'Hello,';
  return `Hi ${first.charAt(0).toUpperCase()}${first.slice(1)},`;
}

/**
 * The header mark. The studio's logo when the app's address is known — mail
 * clients only show an image they can fetch, so it is served from the app's
 * own public folder — and the plain monogram otherwise.
 */
function logoCell(): string {
  const base = (env.appUrl ?? '').replace(/\/+$/, '');
  if (base) {
    return `<td style="font-family:${FONT};"><img src="${base}/logo-email.png" width="150" alt="Janelle Interiors" style="display:block;width:150px;height:auto;border:0;outline:none;"></td>`;
  }
  return `<td style="width:40px;height:40px;background:${C.brass};border-radius:10px;text-align:center;vertical-align:middle;font-family:${FONT};font-size:20px;font-weight:700;color:#ffffff;line-height:40px;">J</td>
                <td style="padding-left:12px;font-family:${FONT};">
                  <div style="font-size:16px;font-weight:600;color:${C.ink};line-height:1.2;">Janelle Interiors</div>
                  <div style="font-size:12px;color:${C.inkFaint};line-height:1.4;">Workflow System</div>
                </td>`;
}

function shell(preheader: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Janelle Interiors</title>
</head>
<body style="margin:0;padding:0;background:${C.paper};">
<!-- The line a phone shows beside the subject. Hidden in the message itself;
     without it the preview is whatever the first words happen to be. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">
  ${preheader}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.paper};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
        <tr>
          <td align="center" style="padding:0 4px 20px 4px;">
            <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
              <tr>
                ${logoCell()}
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:${C.surface};border:1px solid ${C.line};border-radius:14px;padding:32px;font-family:${FONT};">
            ${body}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 8px 0 8px;font-family:${FONT};font-size:11.5px;line-height:1.6;color:${C.inkFaint};">
            Sent by the Janelle Interiors workflow system.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function button(href: string, label: string): string {
  // A padded anchor rather than a VML shape: it renders as a button
  // everywhere that matters and degrades to a plain link where it does not.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px 0;">
  <tr>
    <td style="background:${C.brass};border-radius:8px;">
      <a href="${href}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${label}</a>
    </td>
  </tr>
</table>`;
}

function row(label: string, value: string, mono = false): string {
  return `<tr>
  <td style="padding:10px 14px;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:12px;color:${C.inkFaint};white-space:nowrap;vertical-align:top;width:86px;">${label}</td>
  <td style="padding:10px 14px;border-bottom:1px solid ${C.line};font-family:${mono ? MONO : FONT};font-size:${mono ? '15px' : '14px'};${mono ? 'letter-spacing:0.5px;font-weight:600;' : ''}color:${C.ink};word-break:break-all;">${value}</td>
</tr>`;
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The welcome a new teammate gets, with the password they sign in on. */
export function inviteEmail(opts: { name: string; email: string; password: string; url: string }): Mail {
  const hi = greeting(opts.name);
  const email = escape(opts.email);
  const password = escape(opts.password);
  const url = escape(opts.url);

  const body = `
<div style="font-size:15px;line-height:1.55;color:${C.ink};">${escape(hi)}</div>

<div style="margin-top:14px;font-size:14px;line-height:1.65;color:${C.inkSoft};">
  You have an account on the Janelle Interiors workflow system. It keeps track of projects,
  tasks, vendor orders and the studio mailbox, so nothing gets lost between emails.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;border:1px solid ${C.line};border-radius:10px;background:${C.sunk};">
  <tr>
    <td colspan="2" style="padding:12px 14px 4px 14px;font-family:${FONT};font-size:10.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:${C.inkFaint};">
      Your sign-in
    </td>
  </tr>
  ${row('Email', email)}
  ${row('Password', password, true)}
</table>

${button(url, 'Open the workflow system')}

<div style="font-size:12.5px;line-height:1.6;color:${C.inkFaint};">
  Or paste this into your browser: <span style="color:${C.brassDeep};">${url}</span>
</div>

<div style="margin-top:24px;padding:12px 14px;border-left:3px solid ${C.brass};background:${C.sunk};border-radius:0 8px 8px 0;font-size:13px;line-height:1.6;color:${C.inkSoft};">
  <strong style="color:${C.ink};">Please change this password once you are in.</strong>
  It was generated for you and sent by email, so it should not stay in use —
  open <strong>Settings</strong> and use the Password panel.
</div>

<div style="margin-top:24px;padding-top:18px;border-top:1px solid ${C.line};font-size:12.5px;line-height:1.6;color:${C.inkFaint};">
  If you were not expecting this, you can ignore it and nothing will happen.
</div>`;

  const text = [
    hi,
    '',
    'You have an account on the Janelle Interiors workflow system. It keeps track of',
    'projects, tasks, vendor orders and the studio mailbox, so nothing gets lost',
    'between emails.',
    '',
    'YOUR SIGN-IN',
    `  Email:    ${opts.email}`,
    `  Password: ${opts.password}`,
    '',
    `Sign in here: ${opts.url}`,
    '',
    'Please change this password once you are in. It was generated for you and sent',
    'by email, so it should not stay in use — open Settings and use the Password panel.',
    '',
    'If you were not expecting this, you can ignore it and nothing will happen.',
    '',
    '—',
    'Sent by the Janelle Interiors workflow system.',
  ].join('\n');

  return {
    subject: 'Your Janelle Interiors workflow account',
    text,
    html: shell('Your sign-in details for the Janelle Interiors workflow system.', body),
  };
}

/**
 * Sent on its own when the studio's keep-alive finds a person's Google
 * connection has lapsed — Google now refuses the stored access, and only that
 * person signing in again can restore it (that is what OAuth requires; no
 * server can do it for them). The button is a pre-signed consent link, so it
 * is genuinely one tap: approve with Google and they land back in Settings
 * connected. Nothing they have is lost in the meantime; their mail and tasks
 * simply stop updating until they reconnect.
 */
export function reconnectEmail(opts: { name: string; url: string; services?: ('Gmail' | 'Drive')[] }): Mail {
  const hi = greeting(opts.name);
  const url = escape(opts.url);
  const what = opts.services?.length ? opts.services.join(' and ') : 'Gmail and Drive';

  const body = `
<div style="font-size:15px;line-height:1.55;color:${C.ink};">${escape(hi)}</div>

<div style="margin-top:14px;font-size:14px;line-height:1.65;color:${C.inkSoft};">
  Your Google connection to the Janelle Interiors workflow system has stopped working,
  so the system can no longer read your ${escape(what)}. This happens when Google asks
  for sign-in again — after a password change, or when access times out.
</div>

<div style="margin-top:14px;font-size:14px;line-height:1.65;color:${C.inkSoft};">
  Reconnecting takes one tap: the button below sends you straight to Google to approve
  it again. Nothing you have is lost — your tasks and history stay exactly as they are,
  and updating simply resumes once you are back.
</div>

${button(url, `Reconnect Google`)}

<div style="font-size:12.5px;line-height:1.6;color:${C.inkFaint};">
  Or paste this into your browser: <span style="color:${C.brassDeep};">${url}</span>
</div>

<div style="margin-top:24px;padding-top:18px;border-top:1px solid ${C.line};font-size:12.5px;line-height:1.6;color:${C.inkFaint};">
  You are getting this because the system noticed the connection drop on its own — you
  do not need to tell anyone. If you meant to disconnect, you can ignore this.
</div>`;

  const text = [
    hi,
    '',
    `Your Google connection to the Janelle Interiors workflow system has stopped working,`,
    `so the system can no longer read your ${what}. This happens when Google asks for`,
    `sign-in again — after a password change, or when access times out.`,
    '',
    `Reconnecting takes one tap — approve it again with Google here:`,
    `  ${opts.url}`,
    '',
    `Nothing you have is lost. Your tasks and history stay exactly as they are, and`,
    `updating resumes once you are back.`,
    '',
    `You are getting this because the system noticed the connection drop on its own. If`,
    `you meant to disconnect, you can ignore this.`,
    '',
    ...FOOTER_TEXT,
  ].join('\n');

  return {
    subject: 'Reconnect your Google account — Janelle Interiors',
    text,
    html: shell('Your Google connection needs to be reconnected.', body),
  };
}

/**
 * The nudge to a teammate who is set up on the system but has never connected
 * their Google account — so none of their inbox is read, and the work a client
 * or Janelle emails them lands on nobody's board. Distinct from reconnectEmail
 * (that one is for a connection that WORKED and then lapsed) and from
 * inviteEmail (that one hands over a new sign-in). The button is a pre-signed
 * consent link, so connecting is one tap: approve with Google and they land
 * back in Settings connected. The point, in the studio's own words from the
 * walkthrough, is that when one person misses an email the whole team misses
 * it — connecting is what lets anyone cover for anyone.
 */
export function connectInviteEmail(opts: { name: string; url: string }): Mail {
  const hi = greeting(opts.name);
  const url = escape(opts.url);

  const body = `
<div style="font-size:15px;line-height:1.55;color:${C.ink};">${escape(hi)}</div>

<div style="margin-top:14px;font-size:14px;line-height:1.65;color:${C.inkSoft};">
  You are set up on the Janelle Interiors workflow system, but your Google account is not
  connected yet — so the tasks that arrive in your inbox are not being picked up, and they
  are not showing on the shared board where the rest of us can see them.
</div>

<div style="margin-top:14px;font-size:14px;line-height:1.65;color:${C.inkSoft};">
  Connecting matters because when one person misses an email, the whole team misses it.
  Once your Gmail is connected, anything a client or Janelle sends you turns into a task
  automatically, so nothing slips through if you are heads-down or away — someone can pick
  it up. It takes one tap: the button below sends you straight to Google to approve it.
</div>

${button(url, 'Connect your Google account')}

<div style="font-size:12.5px;line-height:1.6;color:${C.inkFaint};">
  Or paste this into your browser: <span style="color:${C.brassDeep};">${url}</span>
</div>

<div style="margin-top:24px;padding-top:18px;border-top:1px solid ${C.line};font-size:12.5px;line-height:1.6;color:${C.inkFaint};">
  If you have any questions about this before connecting, just reply and ask.
</div>`;

  const text = [
    hi,
    '',
    'You are set up on the Janelle Interiors workflow system, but your Google account is',
    'not connected yet — so the tasks that arrive in your inbox are not being picked up,',
    'and they are not showing on the shared board where the rest of us can see them.',
    '',
    'Connecting matters because when one person misses an email, the whole team misses it.',
    'Once your Gmail is connected, anything a client or Janelle sends you turns into a task',
    'automatically, so nothing slips through if you are heads-down or away — someone can',
    'pick it up. It takes one tap:',
    `  ${opts.url}`,
    '',
    'If you have any questions about this before connecting, just reply and ask.',
    '',
    ...FOOTER_TEXT,
  ].join('\n');

  return {
    subject: 'Connect your Google account — Janelle Interiors',
    text,
    html: shell('Connect your Google account so your inbox tasks reach the team.', body),
  };
}

// ── The task reminders: morning priorities and an end-of-day check-in ──

/**
 * Two emails a day, for two different jobs.
 *
 *   morning  what to put first today: a person's top few priorities, most
 *            urgent at the top, and a count of the rest.
 *   evening  the end-of-day check-in: what got done, what is still open and
 *            rolls to tomorrow, what is blocked — and a plain question about
 *            what is in the way, so tomorrow's plan can account for it.
 *
 * Neither is an inventory. The first version listed every overdue task, which
 * at a few hundred reads as noise; the full list is on the board, and a
 * reminder's job is to name the handful that matter today.
 */
export type ReminderSlot = 'morning' | 'evening';

/** How late (or not) a task reads, and the colour that says so. */
export type DueTone = 'crit' | 'warn' | 'neutral' | 'faint' | 'good';

const TONE_COLOR: Record<DueTone, string> = {
  crit: C.crit,
  warn: C.warn,
  neutral: C.inkSoft,
  faint: C.inkFaint,
  good: C.good,
};

export interface MiddayTaskRow {
  title: string;
  /** Design, FF&E, Procurement & shipping or Admin & operations. */
  category: string;
  /** Project or vendor context, when there is one. */
  project: string | null;
  /** Already phrased for reading, e.g. "overdue, was due Sep 20", "due today" or "completed today". */
  dueText: string;
  /** crit: carried over from an earlier day. warn: due today. neutral: due tomorrow. good: finished today. */
  tone: DueTone;
  blocked: boolean;
  /** Why it is blocked, in the person's own words from their check-in — shown under the title. */
  note?: string | null;
}

/**
 * One short list in a reminder: the rows actually shown, and how many tasks
 * the list stands for. The caller caps the rows; the template says "+ N more"
 * for the rest. A list long enough to need scrolling is one nobody reads.
 */
export interface MiddaySection {
  /** "Top priorities", "Blocked", "Finished today", "Due tomorrow"... */
  label: string;
  /** A line under the label saying what to do with the list, when it needs one. */
  hint?: string;
  rows: MiddayTaskRow[];
  /** Tasks the section stands for, including those beyond `rows`. */
  total: number;
  /** Rank the rows 1, 2, 3 — an order of work, not a set. */
  numbered?: boolean;
}

/** The numbers behind a plan: what a subject line and a person's card say. */
export interface MiddayCounts {
  /** Open, actionable, and due before today. */
  overdue: number;
  /** Open, actionable, and due today. */
  today: number;
  /** Open but waiting on someone — not counted in overdue/today. */
  blocked: number;
  /** Finished today (evening only). */
  done: number;
  /** Due tomorrow (evening only). */
  tomorrow: number;
}

/** One person's reminder, or one person's card in the owner's: a few short lists and the counts. */
export interface MiddayPlan {
  sections: MiddaySection[];
  counts: MiddayCounts;
  /**
   * What the person said in last night's check-in reply that could not be
   * pinned to one task. Shown whole, under their lists, so a blocker typed in
   * a hurry still reaches the morning plan — theirs and the owner's.
   */
  notes?: string[];
}

function taskRowHtml(t: MiddayTaskRow, rank?: number): string {
  const color = TONE_COLOR[t.tone];
  const meta = [t.category, t.project, t.dueText].filter((s): s is string => !!s).map(escape).join(' · ');
  const done = t.tone === 'good';
  const marker =
    rank !== undefined
      ? `<div style="width:18px;height:18px;border-radius:50%;background:${C.sunk};font-family:${FONT};font-size:11px;font-weight:700;color:${C.inkSoft};text-align:center;line-height:18px;">${rank}</div>`
      : `<div style="width:6px;height:6px;border-radius:50%;background:${color};margin-top:6px;"></div>`;
  return `<tr>
  <td style="padding:8px 0;border-bottom:1px solid ${C.line};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="width:${rank !== undefined ? 26 : 14}px;vertical-align:top;padding-top:1px;">
          ${marker}
        </td>
        <td style="font-family:${FONT};">
          <div style="font-size:13.5px;font-weight:600;color:${done ? C.inkSoft : C.ink};line-height:1.4;${
    done ? 'text-decoration:line-through;' : ''
  }">${escape(t.title)}${t.blocked ? ` <span style="color:${C.crit};font-weight:700;text-decoration:none;">· blocked</span>` : ''}</div>
          <div style="margin-top:1px;font-size:12px;color:${color};line-height:1.5;">${done ? '✓ ' : ''}${meta}</div>
          ${
            t.note
              ? `<div style="margin-top:3px;font-size:12.5px;color:${C.ink};line-height:1.5;border-left:2px solid ${C.crit};padding-left:8px;">${escape(t.note)}</div>`
              : ''
          }
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

function taskRowText(t: MiddayTaskRow, rank?: number): string {
  const meta = [t.category, t.project, t.dueText].filter(Boolean).join(' — ');
  const bullet = t.tone === 'good' ? '[x]' : rank !== undefined ? `${rank}.` : '-';
  const line = `  ${bullet} ${t.title}${meta ? ` (${meta})` : ''}${t.blocked ? ' [blocked]' : ''}`;
  return t.note ? `${line}\n       ↳ ${t.note}` : line;
}

/**
 * "+ 12 more on the board" — the rest of a capped list, as a count. A section
 * shown as a count alone (the owner's "Finished today (4)") needs no such
 * line: the label already says the number.
 */
function moreLine(s: MiddaySection): string {
  const more = s.total - s.rows.length;
  return more > 0 && s.rows.length ? `+ ${more} more on the board` : '';
}

function sectionHtml(s: MiddaySection): string {
  if (!s.total) return '';
  const more = moreLine(s);
  return `<div style="margin-top:18px;">
  <div style="font-family:${FONT};font-size:10.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:${C.inkFaint};padding-bottom:2px;">
    ${escape(s.label)} <span style="font-weight:600;">(${s.total})</span>
  </div>
  ${s.hint ? `<div style="font-family:${FONT};font-size:12px;color:${C.inkSoft};line-height:1.5;padding-bottom:4px;">${escape(s.hint)}</div>` : ''}
  ${
    s.rows.length
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${s.rows.map((r, i) => taskRowHtml(r, s.numbered ? i + 1 : undefined)).join('')}
  </table>`
      : ''
  }
  ${more ? `<div style="font-family:${FONT};font-size:12px;color:${C.inkFaint};padding-top:8px;">${escape(more)}</div>` : ''}
</div>`;
}

function sectionText(s: MiddaySection): string {
  if (!s.total) return '';
  const more = moreLine(s);
  return [
    `${s.label.toUpperCase()} (${s.total})`,
    s.hint ?? '',
    ...s.rows.map((r, i) => taskRowText(r, s.numbered ? i + 1 : undefined)),
    more ? `  ${more}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const NOTES_LABEL = 'From the check-in reply';

function notesHtml(notes: string[] | undefined): string {
  if (!notes?.length) return '';
  return `<div style="margin-top:18px;">
  <div style="font-family:${FONT};font-size:10.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:${C.inkFaint};padding-bottom:4px;">
    ${escape(NOTES_LABEL)}
  </div>
  ${notes
    .map(
      (n) =>
        `<div style="font-family:${FONT};font-size:13px;color:${C.ink};line-height:1.55;border-left:2px solid ${C.brass};padding:2px 0 2px 10px;margin-top:6px;white-space:pre-line;">${escape(n)}</div>`,
    )
    .join('')}
</div>`;
}

function notesText(notes: string[] | undefined): string {
  if (!notes?.length) return '';
  return [NOTES_LABEL.toUpperCase(), ...notes.map((n) => `  “${n.replace(/\s+/g, ' ')}”`)].join('\n');
}

function planHtml(p: MiddayPlan): string {
  return p.sections.map(sectionHtml).join('') + notesHtml(p.notes);
}

function planText(p: MiddayPlan): string {
  return [...p.sections.filter((s) => s.total).map(sectionText), notesText(p.notes)].filter(Boolean).join('\n\n');
}

/** "3 overdue, 2 due today, 1 blocked" — the numbers that matter at this time of day. */
function headline(slot: ReminderSlot, c: MiddayCounts): string {
  const open = c.overdue + c.today;
  const parts =
    slot === 'morning'
      ? [c.overdue ? `${c.overdue} overdue` : '', c.today ? `${c.today} due today` : '', c.blocked ? `${c.blocked} blocked` : '']
      : [
          `${c.done} done`,
          `${open} still open`,
          c.blocked ? `${c.blocked} blocked` : '',
          c.tomorrow ? `${c.tomorrow} due tomorrow` : '',
        ];
  const line = parts.filter(Boolean).join(', ');
  return line || 'nothing due today';
}

/** The sentence under the greeting: what the email is, and what it is not. */
function intro(slot: ReminderSlot, scope: 'yours' | 'studio'): string {
  if (scope === 'yours') {
    return slot === 'morning'
      ? 'Good morning — here is what to put first today, most urgent at the top. Everything else is on the board; these few are the ones to get through.'
      : 'Here is how today went and what rolls into tomorrow. If anything is stuck, say so below so tomorrow’s plan can account for it.';
  }
  return slot === 'morning'
    ? 'Good morning — each person’s top priorities for today, with how much sits behind them. The full lists are on the board.'
    : 'How the day went, person by person: what got done, what is still open, and what is blocked.';
}

/**
 * The evening's one question, set apart so it is not read as another list.
 * Three ways to answer, all of which land on the task and on tomorrow's
 * plan (services/checkin.ts): a reply to this email, the check-in in Jenny,
 * or the board itself.
 */
function checkInHtml(checkinUrl?: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;">
  <tr>
    <td style="background:${C.sunk};border-left:3px solid ${C.brass};border-radius:0 10px 10px 0;padding:14px 16px;font-family:${FONT};">
      <div style="font-size:13.5px;font-weight:700;color:${C.ink};">Anything in your way?</div>
      <div style="margin-top:4px;font-size:13px;line-height:1.55;color:${C.inkSoft};">
        Reply to this email with what is done and what is blocking you${
          checkinUrl ? `, or <a href="${escape(checkinUrl)}" style="color:${C.brassDeep};font-weight:600;">answer the check-in with Jenny</a>` : ''
        } — a button per task. Either way it is on the task and on tomorrow morning’s plan.
      </div>
    </td>
  </tr>
</table>`;
}

function checkInText(checkinUrl?: string): string {
  return `Anything in your way? Reply to this email with what is done and what is blocking you${
    checkinUrl ? `, or answer the check-in with Jenny: ${checkinUrl}` : ''
  } — either way it is on the task and on tomorrow morning’s plan.`;
}

const FOOTER_TEXT = ['—', 'Sent by the Janelle Interiors workflow system.'];

/** Each teammate's own reminder: the morning priorities, or the end-of-day check-in. */
export function middayPersonalEmail(opts: {
  name: string;
  slot: ReminderSlot;
  plan: MiddayPlan;
  boardUrl?: string;
  /** Jenny's end-of-day check-in, linked from the evening email. */
  checkinUrl?: string;
}): Mail {
  const hi = greeting(opts.name);
  const lead = intro(opts.slot, 'yours');
  const line = headline(opts.slot, opts.plan.counts);
  const evening = opts.slot === 'evening';

  const body = `
<div style="font-size:15px;line-height:1.55;color:${C.ink};">${escape(hi)}</div>

<div style="margin-top:10px;font-size:14px;line-height:1.6;color:${C.inkSoft};">
  ${escape(lead)}
</div>

${planHtml(opts.plan)}
${evening ? checkInHtml(opts.checkinUrl) : ''}
${opts.boardUrl ? button(opts.boardUrl, 'Open the task board') : ''}`;

  const text = [
    hi,
    '',
    lead,
    '',
    planText(opts.plan),
    evening ? `\n${checkInText(opts.checkinUrl)}` : '',
    opts.boardUrl ? `\nOpen the task board: ${opts.boardUrl}` : '',
    '',
    ...FOOTER_TEXT,
  ]
    .filter((l) => l !== '')
    .join('\n');

  return {
    subject: `${evening ? 'End-of-day check-in' : 'Your priorities today'} — ${line}`,
    text,
    html: shell(line, body),
  };
}

/**
 * The owner's copy: one short card per person — their numbers and their top
 * few — so the whole studio reads in a screen, and who is behind or blocked is
 * visible without a list of everything.
 */
export function middayOwnerEmail(opts: {
  name: string;
  slot: ReminderSlot;
  people: { name: string; plan: MiddayPlan }[];
  unassigned: MiddayPlan;
  boardUrl?: string;
}): Mail {
  const hi = greeting(opts.name);
  const lead = intro(opts.slot, 'studio');
  const evening = opts.slot === 'evening';

  const sum = (pick: (c: MiddayCounts) => number) =>
    [...opts.people.map((p) => p.plan.counts), opts.unassigned.counts].reduce((n, c) => n + pick(c), 0);
  const studio: MiddayCounts = {
    overdue: sum((c) => c.overdue),
    today: sum((c) => c.today),
    blocked: sum((c) => c.blocked),
    done: sum((c) => c.done),
    tomorrow: sum((c) => c.tomorrow),
  };
  const line = `${opts.people.length} ${opts.people.length === 1 ? 'person' : 'people'} · ${headline(opts.slot, studio)}`;

  const chips = (c: MiddayCounts): string => {
    const open = c.overdue + c.today;
    const parts = evening
      ? [
          c.done ? `<span style="color:${C.good};font-weight:600;">${c.done} done</span>` : '',
          open ? `<span style="color:${C.warn};font-weight:600;">${open} still open</span>` : '',
          c.blocked ? `<span style="color:${C.crit};font-weight:600;">${c.blocked} blocked</span>` : '',
          c.tomorrow ? `${c.tomorrow} tomorrow` : '',
        ]
      : [
          c.overdue ? `<span style="color:${C.crit};font-weight:600;">${c.overdue} overdue</span>` : '',
          c.today ? `<span style="color:${C.warn};font-weight:600;">${c.today} today</span>` : '',
          c.blocked ? `<span style="color:${C.crit};font-weight:600;">${c.blocked} blocked</span>` : '',
        ];
    return parts.filter(Boolean).join(' &middot; ');
  };

  const personCard = (name: string, plan: MiddayPlan): string => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;border:1px solid ${C.line};border-radius:10px;">
  <tr>
    <td style="background:${C.sunk};padding:10px 14px;border-radius:10px 10px 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="font-family:${FONT};font-size:13.5px;font-weight:700;color:${C.ink};">${escape(name)}</td>
          <td align="right" style="font-family:${FONT};font-size:11.5px;color:${C.inkFaint};white-space:nowrap;">${chips(plan.counts)}</td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:0 14px 12px 14px;">
      ${planHtml(plan)}
    </td>
  </tr>
</table>`;

  const hasRows = (p: MiddayPlan) => p.sections.some((s) => s.total > 0);
  const cards = [
    ...opts.people.map((p) => personCard(p.name, p.plan)),
    hasRows(opts.unassigned) ? personCard('Unassigned', opts.unassigned) : '',
  ]
    .filter(Boolean)
    .join('');

  const body = `
<div style="font-size:15px;line-height:1.55;color:${C.ink};">${escape(hi)}</div>

<div style="margin-top:10px;font-size:14px;line-height:1.6;color:${C.inkSoft};">
  ${escape(lead)}
</div>

${cards}
${opts.boardUrl ? button(opts.boardUrl, 'Open the task board') : ''}`;

  const personText = (name: string, plan: MiddayPlan): string =>
    `${name.toUpperCase()} — ${headline(opts.slot, plan.counts)}\n${planText(plan)}`;
  const text = [
    hi,
    '',
    lead,
    '',
    [
      ...opts.people.map((p) => personText(p.name, p.plan)),
      hasRows(opts.unassigned) ? personText('Unassigned', opts.unassigned) : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    opts.boardUrl ? `\nOpen the task board: ${opts.boardUrl}` : '',
    '',
    ...FOOTER_TEXT,
  ]
    .filter((l) => l !== '')
    .join('\n');

  return {
    subject: `${evening ? 'Team end-of-day check-in' : 'Team priorities today'} — ${line}`,
    text,
    html: shell(line, body),
  };
}

interface ActivityPersonRow {
  name: string;
  connected: boolean;
  emailsSent: number | null;
  emailsCapped: boolean;
  tasksCompleted: number;
  tasksOpen: number;
  tasksOverdue: number;
  lastSentAt: string | null;
}

/**
 * The weekly per-person activity digest, to the owner only.
 *
 * A reconciliation sheet, not a scorecard: emails sent and how task load moved,
 * per person, so a reported week of hours has something concrete beside it. The
 * caveat at the foot is part of the message, not fine print — the numbers are
 * activity signals, never a measure of hours, and Drive is a blind spot.
 */
export function teamActivityEmail(opts: {
  name: string;
  report: { days: number; people: ActivityPersonRow[]; notes: string[] };
  boardUrl?: string;
}): Mail {
  const hi = greeting(opts.name);
  const { days, people, notes } = opts.report;
  const window = days === 7 ? 'the past week' : `the past ${days} days`;
  const lead = `Here is what each teammate's ${window} looked like by the two signals the system can see — mail they sent, and how their task load moved. Read it against their reported hours, not as hours itself.`;

  const shortSent = (iso: string | null): string => {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  const emailCell = (p: ActivityPersonRow): string => {
    if (!p.connected) return `<span style="color:${C.inkFaint};">not connected</span>`;
    if (p.emailsSent === null) return `<span style="color:${C.inkFaint};">—</span>`;
    return `${p.emailsSent}${p.emailsCapped ? '+' : ''}`;
  };

  const th = (label: string, align = 'left') =>
    `<td align="${align}" style="padding:8px 10px;border-bottom:2px solid ${C.line};font-family:${FONT};font-size:11px;font-weight:700;color:${C.inkFaint};text-transform:uppercase;letter-spacing:0.4px;white-space:nowrap;">${label}</td>`;
  const td = (value: string, align = 'left', color = C.ink, weight = '400') =>
    `<td align="${align}" style="padding:9px 10px;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:13px;color:${color};font-weight:${weight};white-space:nowrap;">${value}</td>`;

  const rows = people
    .map(
      (p) => `<tr>
  ${td(escape(p.name), 'left', C.ink, '600')}
  ${td(emailCell(p), 'right')}
  ${td(String(p.tasksCompleted), 'right', p.tasksCompleted ? C.good : C.inkFaint)}
  ${td(String(p.tasksOpen), 'right')}
  ${td(p.tasksOverdue ? String(p.tasksOverdue) : '0', 'right', p.tasksOverdue ? C.crit : C.inkFaint, p.tasksOverdue ? '600' : '400')}
  ${td(shortSent(p.lastSentAt), 'right', C.inkSoft)}
</tr>`,
    )
    .join('');

  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border:1px solid ${C.line};border-radius:10px;border-collapse:separate;">
  <tr style="background:${C.sunk};">
    ${th('Person')}${th('Emails', 'right')}${th('Done', 'right')}${th('Open', 'right')}${th('Overdue', 'right')}${th('Last sent', 'right')}
  </tr>
  ${rows}
</table>`;

  const noteList = notes.map((n) => `<li style="margin:4px 0;">${escape(n)}</li>`).join('');
  const caveat = `<div style="margin-top:18px;padding:12px 14px;background:${C.sunk};border-radius:10px;">
  <ul style="margin:0;padding-left:18px;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.inkSoft};">${noteList}</ul>
</div>`;

  const body = `
<div style="font-size:15px;line-height:1.55;color:${C.ink};">${escape(hi)}</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:${C.inkSoft};">${escape(lead)}</div>
${table}
${caveat}
${opts.boardUrl ? button(opts.boardUrl, 'Open the team page') : ''}`;

  const textRows = people
    .map((p) => {
      const emails = !p.connected ? 'not connected' : p.emailsSent === null ? '—' : `${p.emailsSent}${p.emailsCapped ? '+' : ''}`;
      return `  ${p.name} — ${emails} emails · ${p.tasksCompleted} done · ${p.tasksOpen} open · ${p.tasksOverdue} overdue · last sent ${shortSent(p.lastSentAt)}`;
    })
    .join('\n');
  const text = [
    hi,
    '',
    lead,
    '',
    textRows,
    '',
    ...notes.map((n) => `- ${n}`),
    opts.boardUrl ? `\nOpen the team page: ${opts.boardUrl}` : '',
    '',
    ...FOOTER_TEXT,
  ]
    .filter((l) => l !== '')
    .join('\n');

  return {
    subject: `Team activity — ${window}`,
    text,
    html: shell(`Team activity for ${window}`, body),
  };
}
