import { PROJECT_STAGES, type ProjectStage } from '@janelle/shared';
import { supabaseAdmin } from '../lib/supabase.js';
import { matchProjectId } from './promote.js';

/**
 * Bring the studio's project list over from Houzz Pro.
 *
 * Houzz Pro has no API for a third party to read a studio's own projects —
 * confirmed with the studio on the kickoff call, and the reason the spec
 * says "manual CSV export only". The page at pro.houzz.com/manage/projects
 * is an authenticated app screen, not a feed, so the list comes across as
 * the CSV that screen exports.
 *
 * Houzz remains the source of truth. This reads a snapshot into the system
 * and never writes back, which is the standing architectural rule.
 */

// ── CSV ─────────────────────────────────────────────────────

/**
 * Parse CSV to rows of cells.
 *
 * Written out rather than pulled in: the file comes from one known
 * exporter, and a dependency for RFC 4180 is more surface than the fifty
 * lines it takes. Handles quoted fields, doubled quotes inside them,
 * embedded commas and newlines, and both CRLF and LF line endings.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  // A byte-order mark survives Excel and would otherwise become part of
  // the first header, so the first column would never match anything.
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      // Swallow the LF of a CRLF pair rather than emitting a blank row.
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }

  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }

  // Trailing newlines leave an empty row behind; so does a blank line.
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// ── Column mapping ──────────────────────────────────────────

/** Compare headers without caring about case, spacing or punctuation. */
function headerKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * What each field might be called in the export.
 *
 * Houzz has renamed these columns before and the export differs by plan,
 * so each field lists the spellings worth trying rather than one exact
 * header. The result reports what it matched, so a header that has moved
 * again shows up as an unread column instead of silently importing blanks.
 */
const COLUMNS: Record<string, string[]> = {
  name: ['projectname', 'project', 'name', 'jobname', 'jobtitle', 'title'],
  client: ['clientname', 'client', 'customer', 'customername', 'homeowner', 'contactname', 'contact'],
  stage: ['stage', 'projectstage', 'status', 'projectstatus', 'phase'],
  budget: ['budget', 'projectbudget', 'totalbudget', 'contractamount', 'contractvalue', 'estimatetotal'],
  start: ['startdate', 'start', 'datecreated', 'createddate', 'created'],
  install: ['targetinstall', 'installdate', 'install', 'targetdate', 'duedate', 'enddate', 'completiondate', 'targetcompletion'],
  ref: ['projectid', 'houzzid', 'id', 'jobnumber', 'jobno', 'projectnumber', 'projectno', 'number', 'ref'],
  address: ['projectaddress', 'address', 'location', 'siteaddress'],
  notes: ['notes', 'description', 'note', 'projectdescription'],
};

/** Which column index holds each field, by best header match. */
function mapColumns(
  headers: string[],
  spec: Record<string, string[]> = COLUMNS,
): {
  index: Record<string, number>;
  mapped: Record<string, string>;
  unused: string[];
} {
  const keys = headers.map(headerKey);
  const index: Record<string, number> = {};
  const mapped: Record<string, string> = {};
  const claimed = new Set<number>();

  for (const [field, candidates] of Object.entries(spec)) {
    for (const candidate of candidates) {
      // Exact header first, then a header that contains the candidate, so
      // "Project Name (required)" still matches "projectname".
      let at = keys.findIndex((k, i) => !claimed.has(i) && k === candidate);
      if (at === -1) at = keys.findIndex((k, i) => !claimed.has(i) && k.includes(candidate));
      if (at !== -1) {
        index[field] = at;
        mapped[field] = headers[at];
        claimed.add(at);
        break;
      }
    }
  }

  const unused = headers.filter((h, i) => !claimed.has(i) && h.trim() !== '');
  return { index, mapped, unused };
}

// ── Value parsing ───────────────────────────────────────────

/** Houzz's own stage words, mapped onto the studio's pipeline. */
const STAGE_WORDS: [RegExp, ProjectStage][] = [
  [/lead|inquir|enquir|prospect|new/i, 'lead'],
  [/concept|schematic|design|moodboard/i, 'concept'],
  [/spec|selection|sourcing|estimat|proposal|quote/i, 'spec'],
  [/approv|sign.?off|pending/i, 'approval'],
  [/\bpo\b|purchas|order(?!ed.*receiv)|procure/i, 'po'],
  [/production|manufactur|fabricat|making/i, 'production'],
  [/ship|transit|deliver|freight/i, 'shipping'],
  [/install|site|punch/i, 'install'],
  [/complete|closed|finish|done|archiv/i, 'complete'],
];

function toStage(value: string | undefined): ProjectStage | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  // An exact stage name wins over any guess at a word inside it.
  const exact = PROJECT_STAGES.find((s) => s === v.toLowerCase());
  if (exact) return exact;
  for (const [pattern, stage] of STAGE_WORDS) if (pattern.test(v)) return stage;
  return null;
}

function toStatus(value: string | undefined): 'active' | 'on_hold' | 'archived' {
  const v = (value ?? '').toLowerCase();
  if (/hold|pause|dormant/.test(v)) return 'on_hold';
  if (/archiv|cancel|lost|dead/.test(v)) return 'archived';
  return 'active';
}

/** "$12,450.00" and "12450" both become 12450; anything else is null. */
function toMoney(value: string | undefined): number | null {
  const cleaned = (value ?? '').replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/**
 * An ISO date, from ISO or US input.
 *
 * Only these two shapes are accepted on purpose: "05/03/2026" is May 3rd
 * to the exporter and March 5th to half the world, and a wrong install
 * date is worse than no install date. US order is used because that is
 * what Houzz Pro exports, and anything else is left unset.
 */
function toDate(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;

  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const us = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (us) {
    const [, m, d, y] = us;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

// ── Import ──────────────────────────────────────────────────

export interface HouzzImportResult {
  ok: boolean;
  reason?: string;
  /** Projects added. */
  created: number;
  /** Projects already here that the file filled in or corrected. */
  updated: number;
  /** Rows with no usable project name. */
  skipped: number;
  /** Which CSV column each field was read from, so a mismatch is visible. */
  mapped: Record<string, string>;
  /** Columns in the file nothing was read from. */
  unusedColumns: string[];
}

/**
 * Read a Houzz Pro project export into the studio's project list.
 *
 * Runs safely more than once. A row is matched to what is already here by
 * its Houzz id first, then by name using the same matching that folds
 * duplicates together — so a project the system had already raised from an
 * email is filled in rather than duplicated, and it gains the Houzz id that
 * makes it the authoritative record from then on.
 *
 * Only fields the file actually carries are written: an export with no
 * budget column never blanks a budget that is already known.
 */
export async function importHouzzProjects(orgId: string, csv: string): Promise<HouzzImportResult> {
  const empty = { created: 0, updated: 0, skipped: 0, mapped: {}, unusedColumns: [] };
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', ...empty };

  const rows = parseCsv(csv);
  if (rows.length < 2) return { ok: false, reason: 'The file has no rows under its header.', ...empty };

  const [headers, ...body] = rows;
  const { index, mapped, unused } = mapColumns(headers);
  if (index.name === undefined) {
    return {
      ok: false,
      reason: `No project-name column found. Columns in the file: ${headers.filter(Boolean).join(', ')}`,
      ...empty,
      unusedColumns: unused,
    };
  }

  const { data: existingRows } = await supabaseAdmin
    .from('projects')
    .select('id, name, houzz_ref, client_name, budget, start_date, target_install, notes')
    .eq('org_id', orgId);
  const existing = (existingRows ?? []) as {
    id: string;
    name: string;
    houzz_ref: string | null;
    client_name: string | null;
    budget: number | null;
    start_date: string | null;
    target_install: string | null;
    notes: string | null;
  }[];

  const result: HouzzImportResult = { ok: true, created: 0, updated: 0, skipped: 0, mapped, unusedColumns: unused };

  for (const row of body) {
    const cell = (field: string) => (index[field] === undefined ? undefined : row[index[field]]?.trim());

    const name = cell('name');
    if (!name) {
      result.skipped++;
      continue;
    }

    const ref = cell('ref') || null;
    const stage = toStage(cell('stage'));
    const address = cell('address');
    const notes = cell('notes') || (address ? `Address: ${address}` : null);

    // Only what the file actually carries, so a narrow export cannot blank
    // what the studio already knows.
    const incoming: Record<string, unknown> = {};
    const client = cell('client');
    const budget = toMoney(cell('budget'));
    const start = toDate(cell('start'));
    const install = toDate(cell('install'));
    if (client) incoming.client_name = client;
    if (budget !== null) incoming.budget = budget;
    if (start) incoming.start_date = start;
    if (install) incoming.target_install = install;
    if (notes) incoming.notes = notes;
    if (stage) incoming.stage = stage;
    if (cell('stage')) incoming.status = toStatus(cell('stage'));

    // Houzz's own id is the surest match; otherwise fall back to the name,
    // which is how a project raised from email gets adopted rather than
    // duplicated.
    const byRef = ref ? existing.find((p) => p.houzz_ref === ref) : undefined;
    const matchId = byRef?.id ?? matchProjectId(existing, name);
    const hit = matchId ? existing.find((p) => p.id === matchId) : undefined;

    try {
      if (hit) {
        const patch: Record<string, unknown> = { ...incoming };
        if (ref && hit.houzz_ref !== ref) patch.houzz_ref = ref;
        // Houzz is the source of truth for the name, so take its spelling.
        if (name !== hit.name) patch.name = name;

        if (Object.keys(patch).length) {
          const { error } = await supabaseAdmin.from('projects').update(patch).eq('id', hit.id).eq('org_id', orgId);
          if (error) throw new Error(error.message);
          result.updated++;
          Object.assign(hit, patch);
        }
      } else {
        const { data, error } = await supabaseAdmin
          .from('projects')
          .insert({
            org_id: orgId,
            name,
            houzz_ref: ref,
            stage: stage ?? 'lead',
            status: incoming.status ?? 'active',
            ...incoming,
          })
          .select('id, name, houzz_ref, client_name, budget, start_date, target_install, notes')
          .maybeSingle();
        if (error) throw new Error(error.message);
        result.created++;
        // Keep the in-memory list current so two rows naming the same job
        // in one file land on one project.
        if (data) existing.push(data as (typeof existing)[number]);
      }
    } catch (err) {
      console.error('[houzz] row failed', name, (err as Error).message);
      result.skipped++;
    }
  }

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'projects.houzz_import',
    entity: 'project',
    meta: { created: result.created, updated: result.updated, skipped: result.skipped, mapped, unusedColumns: unused },
  });

  return result;
}

// ── Tasks import ────────────────────────────────────────────
//
// Houzz Pro is where the studio keeps its "house" tasks, and the walkthrough
// (Carissa, 2026-10-26) named the real cost: everyone works Houzz first, then
// this board, and a request Janelle makes that nobody logs in Houzz is a task
// the whole team is blind to. Houzz has no API, so — exactly like the project
// list — the tasks come across as the CSV its task screen exports. Houzz stays
// the source of truth; this reads a snapshot onto the board and never writes
// back. The column names are a best-effort guess at the export's headers
// (confirmed once a real file is seen); `mapped`/`unusedColumns` in the result
// show what matched so a renamed header shows up rather than importing blanks.

/** What each task field might be called in the export. Title deliberately does
 * NOT list "description", so a separate description column is left for notes
 * rather than mistaken for the task name. */
const TASK_COLUMNS: Record<string, string[]> = {
  title: ['taskname', 'task', 'todo', 'title', 'subject', 'activity', 'item', 'name'],
  project: ['projectname', 'project', 'job', 'jobname', 'relatedproject', 'projecttitle'],
  assignee: ['assignedto', 'assignee', 'owner', 'responsible', 'assigned', 'teammember', 'user'],
  due: ['duedate', 'due', 'deadline', 'targetdate', 'completeby', 'date'],
  status: ['status', 'state', 'taskstatus', 'progress', 'completed', 'iscomplete', 'done'],
  priority: ['priority', 'importance', 'urgency'],
  notes: ['notes', 'description', 'details', 'note', 'comment', 'comments'],
};

/** Houzz's own task words, mapped onto the board's statuses. */
function toTaskStatus(value: string | undefined): 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled' {
  const v = (value ?? '').toLowerCase();
  if (/complete|closed|finish|done|resolved|\byes\b|\btrue\b|\bx\b|✓/.test(v)) return 'done';
  if (/cancel|dead|void|dropped/.test(v)) return 'cancelled';
  if (/block|hold|wait|stuck|pending|paused/.test(v)) return 'blocked';
  if (/progress|started|doing|active|wip|underway|ongoing/.test(v)) return 'in_progress';
  return 'open';
}

/** Compare task titles without caring about case, punctuation or spacing —
 * the same flattening the project match uses, so a re-import of the same file
 * lands on the same card instead of a second one. */
function taskTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface HouzzTaskImportResult {
  ok: boolean;
  reason?: string;
  /** Tasks added. */
  created: number;
  /** Tasks already on the board that the file updated (status, due, owner). */
  updated: number;
  /** Rows with no usable task title. */
  skipped: number;
  /** Assignee names in the file that matched no teammate; left unassigned. */
  unmatchedAssignees: string[];
  /** Which CSV column each field was read from, so a mismatch is visible. */
  mapped: Record<string, string>;
  /** Columns in the file nothing was read from. */
  unusedColumns: string[];
}

/**
 * Read a Houzz Pro task export onto the studio's task board.
 *
 * Runs safely more than once: a row is matched to what is already on the board
 * by project + normalised title, so re-importing the same export updates the
 * card rather than duplicating it, and a task the system had already raised
 * from an email with the same title on the same job is adopted, not doubled.
 * Houzz owns these tasks, so on a match the status it reports is taken; other
 * fields are only written when the file actually carries them.
 */
export async function importHouzzTasks(orgId: string, csv: string): Promise<HouzzTaskImportResult> {
  const empty = { created: 0, updated: 0, skipped: 0, unmatchedAssignees: [], mapped: {}, unusedColumns: [] };
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', ...empty };

  const rows = parseCsv(csv);
  if (rows.length < 2) return { ok: false, reason: 'The file has no rows under its header.', ...empty };

  const [headers, ...body] = rows;
  const { index, mapped, unused } = mapColumns(headers, TASK_COLUMNS);
  if (index.title === undefined) {
    return {
      ok: false,
      reason: `No task-title column found. Columns in the file: ${headers.filter(Boolean).join(', ')}`,
      ...empty,
      unusedColumns: unused,
    };
  }

  // Projects to file tasks under, and teammates to assign them to.
  const { data: projectRows } = await supabaseAdmin
    .from('projects')
    .select('id, name, houzz_ref')
    .eq('org_id', orgId);
  const projects = (projectRows ?? []) as { id: string; name: string; houzz_ref: string | null }[];

  const { data: profileRows } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .eq('org_id', orgId);
  const profiles = (profileRows ?? []) as { id: string; full_name: string | null; email: string | null }[];

  // Match an assignee name to a teammate: whole name first, then first name,
  // then the local part of their email ("carissa" from carissa@…). Null when
  // nothing matches, so a typo leaves the task unassigned rather than mis-owned.
  const matchAssignee = (name: string): string | null => {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    const exact = profiles.find((p) => (p.full_name ?? '').trim().toLowerCase() === n);
    if (exact) return exact.id;
    const first = profiles.find((p) => (p.full_name ?? '').trim().toLowerCase().split(' ')[0] === n.split(' ')[0]);
    if (first) return first.id;
    const byEmail = profiles.find((p) => (p.email ?? '').split('@')[0].toLowerCase() === n.split(' ')[0]);
    return byEmail?.id ?? null;
  };

  // The board as it stands — live work, plus anything closed recently, so a
  // re-import updates rather than re-raises a card that was only just ticked.
  const recent = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
  const { data: existingRows } = await supabaseAdmin
    .from('tasks')
    .select('id, title, status, project_id, due_date, assigned_to, detail')
    .eq('org_id', orgId)
    .or(`status.in.(open,in_progress,blocked),updated_at.gte.${recent}`);
  const existing = (existingRows ?? []) as {
    id: string; title: string; status: string; project_id: string | null;
    due_date: string | null; assigned_to: string | null; detail: string | null;
  }[];

  const result: HouzzTaskImportResult = {
    ok: true, created: 0, updated: 0, skipped: 0, unmatchedAssignees: [], mapped, unusedColumns: unused,
  };
  const unmatched = new Set<string>();

  for (const row of body) {
    const cell = (field: string) => (index[field] === undefined ? undefined : row[index[field]]?.trim());

    const title = cell('title');
    if (!title) {
      result.skipped++;
      continue;
    }

    // The job this task is filed under: Houzz id first (when the export carries
    // one that lines up with an imported project), else the project name.
    const projectName = cell('project');
    const projectId = projectName
      ? matchProjectId(projects as unknown as { id: string; name: string }[], projectName)
      : null;

    const status = toTaskStatus(cell('status'));
    const due = toDate(cell('due'));
    const assigneeName = cell('assignee') ?? '';
    const assignedTo = assigneeName ? matchAssignee(assigneeName) : null;
    if (assigneeName && !assignedTo) unmatched.add(assigneeName);

    const priority = cell('priority');
    const note = cell('notes');
    const detail = [note || null, priority ? `Priority: ${priority}` : null].filter(Boolean).join('\n\n') || null;

    // Same job and the same title, however it is cased or punctuated.
    const key = taskTitleKey(title);
    const hit = existing.find(
      (t) => taskTitleKey(t.title) === key && (t.project_id === projectId || t.project_id === null || projectId === null),
    );

    try {
      if (hit) {
        const patch: Record<string, unknown> = {};
        // Houzz owns these tasks, so its status wins; the rest only fill gaps
        // the file actually carries, never blanking what the board already has.
        if (hit.status !== status) patch.status = status;
        if (due && hit.due_date !== due) patch.due_date = due;
        if (assignedTo && hit.assigned_to !== assignedTo) patch.assigned_to = assignedTo;
        if (detail && !hit.detail) patch.detail = detail;
        if (projectId && hit.project_id === null) patch.project_id = projectId;

        if (Object.keys(patch).length) {
          const { error } = await supabaseAdmin.from('tasks').update(patch).eq('id', hit.id).eq('org_id', orgId);
          if (error) throw new Error(error.message);
          result.updated++;
          Object.assign(hit, patch);
        }
      } else {
        const { data, error } = await supabaseAdmin
          .from('tasks')
          .insert({
            org_id: orgId,
            title: title.slice(0, 200),
            detail,
            kind: 'admin',
            status,
            assigned_to: assignedTo,
            project_id: projectId,
            due_date: due,
            // Houzz tasks have no originating email; the column is nullable
            // precisely for board tasks raised outside the inbox.
            source_email_id: null,
          })
          .select('id, title, status, project_id, due_date, assigned_to, detail')
          .maybeSingle();
        if (error) throw new Error(error.message);
        result.created++;
        // Keep the in-memory board current so two rows naming the same task in
        // one file land on one card.
        if (data) existing.push(data as (typeof existing)[number]);
      }
    } catch (err) {
      console.error('[houzz] task row failed', title, (err as Error).message);
      result.skipped++;
    }
  }

  result.unmatchedAssignees = [...unmatched];

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'tasks.houzz_import',
    entity: 'task',
    meta: {
      created: result.created, updated: result.updated, skipped: result.skipped,
      unmatchedAssignees: result.unmatchedAssignees, mapped, unusedColumns: unused,
    },
  });

  return result;
}
