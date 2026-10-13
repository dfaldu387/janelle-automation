import { env } from '../env.js';
import { resolveSlack } from '../lib/slackSettings.js';
import { SlackError, lookupUserByEmail, openDm, postMessage, type SlackMessage } from './slack.js';
import type { MiddayCounts, MiddayPlan, MiddaySection, MiddayTaskRow, ReminderSlot } from './emailTemplate.js';

/**
 * The task reminders as Slack direct messages.
 *
 * The same plan the 9am and 5pm emails carry (services/middayReminder.ts),
 * sent to each person as a DM and to the owner as the team summary, for the
 * people who live in Slack and read email twice a day. Nothing is computed
 * here: the plans arrive built, and this only phrases them in mrkdwn and
 * finds who to send them to.
 *
 * A reply to the DM is not read — the bot has no events subscription — so
 * the evening message points at the two places an answer is read: the
 * check-in in Jenny, and a reply to the check-in email.
 *
 * Needs two scopes beyond the channel reports: users:read.email to find a
 * person by their address, and im:write to open the DM. Missing either, the
 * first send fails with missing_scope and the rest are not attempted; the
 * email already went, so nobody is left without their plan.
 */

export interface SlackReminderPerson {
  name: string;
  email: string | null;
  plan: MiddayPlan;
}

export interface SlackReminderInput {
  slot: ReminderSlot;
  /** Each teammate with something to be told, and their own plan. */
  people: SlackReminderPerson[];
  /** Whoever holds the owner's seat. */
  owners: { name: string; email: string | null }[];
  /** The owner's view: each person's compact plan, most behind first. */
  team: { name: string; plan: MiddayPlan }[];
  unassigned: MiddayPlan;
}

export interface SlackReminderResult {
  sent: number;
  skipped?: 'not_connected' | 'paused' | 'off';
  /** People with no Slack account at their email, who got the email only. */
  notOnSlack: string[];
  errors: string[];
}

/** Slack mrkdwn treats & < > as markup; everything else is literal. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A block's text may not pass 3000 characters; a plan rarely gets near it, a studio's might. */
function clip(s: string, n = 2900): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function rowLine(t: MiddayTaskRow, rank?: number, indent = ''): string {
  const meta = [t.category, t.project, t.dueText].filter(Boolean).join(' · ');
  const bullet = t.tone === 'good' ? '✅' : rank !== undefined ? `${rank}.` : '•';
  const title = t.tone === 'good' ? `~${esc(t.title)}~` : `*${esc(t.title)}*`;
  const line = `${indent}${bullet} ${title}${t.blocked ? ' · 🔴 blocked' : ''}${meta ? `  _${esc(meta)}_` : ''}`;
  return t.note ? `${line}\n${indent}    ↳ ${esc(t.note)}` : line;
}

function sectionText(s: MiddaySection, indent = ''): string {
  if (!s.total) return '';
  const more = s.total - s.rows.length;
  return [
    `${indent}*${esc(s.label)}* (${s.total})${s.hint ? `  _${esc(s.hint)}_` : ''}`,
    ...s.rows.map((r, i) => rowLine(r, s.numbered ? i + 1 : undefined, indent)),
    more > 0 && s.rows.length ? `${indent}    _+ ${more} more on the board_` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function notesText(notes: string[] | undefined, indent = ''): string {
  if (!notes?.length) return '';
  return [`${indent}*From the check-in reply*`, ...notes.map((n) => `${indent}> ${esc(n.replace(/\s+/g, ' '))}`)].join('\n');
}

/** "3 overdue, 2 due today, 1 blocked" — the same headline the email subject carries. */
function headline(slot: ReminderSlot, c: MiddayCounts): string {
  const open = c.overdue + c.today;
  const parts =
    slot === 'morning'
      ? [c.overdue ? `${c.overdue} overdue` : '', c.today ? `${c.today} due today` : '', c.blocked ? `${c.blocked} blocked` : '']
      : [`${c.done} done`, `${open} still open`, c.blocked ? `${c.blocked} blocked` : '', c.tomorrow ? `${c.tomorrow} due tomorrow` : ''];
  return parts.filter(Boolean).join(', ') || 'nothing due today';
}

function mrkdwn(text: string): unknown {
  return { type: 'section', text: { type: 'mrkdwn', text: clip(text) } };
}

/** One person's own reminder. */
export function personalMessage(opts: {
  name: string;
  slot: ReminderSlot;
  plan: MiddayPlan;
  boardUrl: string | null;
  checkinUrl: string | null;
}): SlackMessage {
  const first = opts.name.split(/\s+/)[0] || opts.name;
  const evening = opts.slot === 'evening';
  const title = evening ? 'End-of-day check-in' : 'Your priorities today';
  const lead = evening
    ? `Hi ${esc(first)} — here is how today went and what rolls into tomorrow.`
    : `Good morning, ${esc(first)} — here is what to put first today, most urgent at the top.`;

  const blocks: unknown[] = [mrkdwn(`*${title}* — ${esc(headline(opts.slot, opts.plan.counts))}\n${lead}`)];
  for (const s of opts.plan.sections) {
    const text = sectionText(s);
    if (text) blocks.push(mrkdwn(text));
  }
  const notes = notesText(opts.plan.notes);
  if (notes) blocks.push(mrkdwn(notes));

  const links: string[] = [];
  if (evening) {
    links.push(
      `*Anything in your way?* ${opts.checkinUrl ? `<${opts.checkinUrl}|Answer the check-in with Jenny>` : 'Answer the check-in with Jenny'} — a button per task — or reply to the check-in email. A reply here is not read.`,
    );
  }
  if (opts.boardUrl) links.push(`<${opts.boardUrl}|Open the task board>`);
  if (links.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(links.join('  ·  ')) }] });

  const text = [
    `${title} — ${headline(opts.slot, opts.plan.counts)}`,
    ...opts.plan.sections.map((s) => sectionText(s)).filter(Boolean),
  ].join('\n');
  return { text: text.replace(/[*_~]/g, ''), blocks };
}

/** The owner's team summary, one short block per person. */
export function teamMessage(opts: {
  slot: ReminderSlot;
  team: { name: string; plan: MiddayPlan }[];
  unassigned: MiddayPlan;
  boardUrl: string | null;
}): SlackMessage {
  const evening = opts.slot === 'evening';
  const totals = [...opts.team.map((p) => p.plan), opts.unassigned].reduce<MiddayCounts>(
    (acc, p) => ({
      overdue: acc.overdue + p.counts.overdue,
      today: acc.today + p.counts.today,
      blocked: acc.blocked + p.counts.blocked,
      done: acc.done + p.counts.done,
      tomorrow: acc.tomorrow + p.counts.tomorrow,
    }),
    { overdue: 0, today: 0, blocked: 0, done: 0, tomorrow: 0 },
  );
  const title = evening ? 'Team end-of-day check-in' : 'Team priorities today';
  const blocks: unknown[] = [
    mrkdwn(`*${title}* — ${opts.team.length} ${opts.team.length === 1 ? 'person' : 'people'} · ${esc(headline(opts.slot, totals))}`),
  ];

  const card = (name: string, plan: MiddayPlan): string =>
    [
      `*${esc(name)}* — ${esc(headline(opts.slot, plan.counts))}`,
      ...plan.sections.map((s) => sectionText(s, '    ')).filter(Boolean),
      notesText(plan.notes, '    '),
    ]
      .filter(Boolean)
      .join('\n');

  // One block per person keeps each under Slack's text limit and reads as
  // the cards the email shows. Slack allows fifty blocks; a studio has fewer people.
  for (const p of opts.team) blocks.push(mrkdwn(card(p.name, p.plan)));
  if (opts.unassigned.sections.some((s) => s.total)) blocks.push(mrkdwn(card('Nobody yet', opts.unassigned)));
  if (opts.boardUrl) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${opts.boardUrl}|Open the task board>` }] });

  const text = [`${title} — ${headline(opts.slot, totals)}`, ...opts.team.map((p) => `${p.name}: ${headline(opts.slot, p.plan.counts)}`)].join('\n');
  return { text, blocks: blocks.slice(0, 50) };
}

/** Email → Slack user id, remembered for the day: two sends, the same handful of people. */
const userIds = new Map<string, { id: string | null; at: number }>();
const USER_ID_TTL_MS = 12 * 3600_000;

async function userIdFor(token: string, email: string): Promise<string | null> {
  const key = `${token.slice(-8)}:${email.toLowerCase()}`;
  const hit = userIds.get(key);
  if (hit && Date.now() - hit.at < USER_ID_TTL_MS) return hit.id;
  const id = await lookupUserByEmail(token, email);
  userIds.set(key, { id, at: Date.now() });
  return id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendSlackReminders(orgId: string, input: SlackReminderInput): Promise<SlackReminderResult> {
  const result: SlackReminderResult = { sent: 0, notOnSlack: [], errors: [] };
  const slack = await resolveSlack(orgId);
  if (!slack.token) return { ...result, skipped: 'not_connected' };
  if (!slack.config.enabled) return { ...result, skipped: 'paused' };
  if (!slack.config.personalReminders) return { ...result, skipped: 'off' };
  const token = slack.token;

  const appUrl = (env.appUrl ?? '').replace(/\/+$/, '');
  const boardUrl = appUrl ? `${appUrl}/tasks` : null;
  const checkinUrl = appUrl ? `${appUrl}/assistant?checkin=1` : null;

  /** True when the rest should still be tried. */
  const dm = async (name: string, email: string | null, msg: SlackMessage): Promise<boolean> => {
    if (!email) {
      result.notOnSlack.push(name);
      return true;
    }
    try {
      const userId = await userIdFor(token, email);
      if (!userId) {
        result.notOnSlack.push(name);
        return true;
      }
      const channel = await openDm(token, userId);
      await postMessage(token, channel, msg);
      result.sent++;
      await sleep(1100); // about one post a second
      return true;
    } catch (err) {
      const message = err instanceof SlackError ? err.message : (err as Error).message;
      result.errors.push(`${name}: ${message}`);
      console.error(`[slack] reminder DM to ${name} failed:`, message);
      // A missing scope or a dead token fails for everyone, not just this person.
      const fatal = ['missing_scope', 'invalid_auth', 'not_authed', 'token_revoked', 'account_inactive', 'token_expired'];
      return !(err instanceof SlackError && fatal.includes(err.code));
    }
  };

  for (const person of input.people) {
    const msg = personalMessage({ name: person.name, slot: input.slot, plan: person.plan, boardUrl, checkinUrl });
    if (!(await dm(person.name, person.email, msg))) return result;
  }
  if (input.team.length || input.unassigned.sections.some((s) => s.total)) {
    const msg = teamMessage({ slot: input.slot, team: input.team, unassigned: input.unassigned, boardUrl });
    for (const owner of input.owners) {
      if (!(await dm(owner.name, owner.email, msg))) return result;
    }
  }
  return result;
}
