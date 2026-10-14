// ============================================================
//  @janelle/shared — types shared by the API and the web app.
//  Kept in step with supabase/schema.sql.
// ============================================================

export type UserRole =
  | 'principal'
  | 'designer'
  | 'procurement'
  | 'coordinator'
  | 'assistant';

export type ProjectStage =
  | 'lead'
  | 'concept'
  | 'spec'
  | 'approval'
  | 'po'
  | 'production'
  | 'shipping'
  | 'install'
  | 'complete';

export const PROJECT_STAGES: ProjectStage[] = [
  'lead', 'concept', 'spec', 'approval', 'po',
  'production', 'shipping', 'install', 'complete',
];

export const STAGE_LABELS: Record<ProjectStage, string> = {
  lead: 'Lead',
  concept: 'Concept',
  spec: 'Spec',
  approval: 'Approval',
  po: 'PO',
  production: 'Production',
  shipping: 'Shipping',
  install: 'Install',
  complete: 'Complete',
};

export type PoStatus =
  | 'draft'
  | 'placed'
  | 'confirmed'
  | 'in_production'
  | 'shipped'
  | 'received'
  | 'cancelled';

export type FollowUpType =
  | 'vendor_silence'
  | 'client_approval_overdue'
  | 'date_slipping'
  | 'spec_gap'
  | 'quote_overdue'
  | 'client_waiting'
  /** Internal nudge: the person who owns a task has let it go overdue. */
  | 'task_overdue'
  /** The nudge was ignored, so the principal is told. */
  | 'task_escalation'
  // Task hygiene. A task missing any of these is not yet a task the studio's
  // own SOP would accept, and it cannot be chased for lateness when it has no
  // date — so these chase the shape of the work rather than its timing.
  /** Nobody owns it. */
  | 'task_unowned'
  /** No single concrete action has been written down. */
  | 'task_no_next_step'
  /** No date to be late against. */
  | 'task_no_due_date';

/**
 * Service levels the studio actually works to, captured from the
 * 2026-09-10 kickoff call. Stored per-org in `organizations.settings`;
 * these are the defaults when nothing is set.
 */
export interface SlaSettings {
  /** A quote request unresolved this long → proactively update the client. */
  quote_response_days: number;
  /** A client left waiting this long → nudge the owner internally. */
  client_waiting_hours: number;
  /** A PO placed but unconfirmed this long → chase the vendor. */
  vendor_silence_days: number;
  /** A project parked in "approval" this long → chase the client. */
  client_approval_days: number;
  /** A task overdue by this much → escalate to the principal. */
  escalation_days: number;
  /** How long a task may sit past its due date before its owner is nudged. */
  task_reminder_days: number;
  /** Days between repeat nudges on the same task, so it is a cadence not a nightly spam. */
  reminder_repeat_days: number;
}

export const DEFAULT_SLA: SlaSettings = {
  quote_response_days: 2,
  client_waiting_hours: 24,
  vendor_silence_days: 3,
  client_approval_days: 5,
  escalation_days: 2,
  task_reminder_days: 1,
  reminder_repeat_days: 2,
};

export type FollowUpStatus = 'open' | 'drafted' | 'sent' | 'dismissed' | 'done';

export type TaskKind =
  | 'quote_request'
  | 'order_followup'
  | 'client_approval'
  | 'spec_review'
  | 'scheduling'
  | 'admin';

/**
 * The department a task belongs to, which is a different question from its
 * kind: a "spec review" can be Design (a drawing) or FF&E (a furniture
 * schedule). Picked by the ingest AI from the email and editable on the card.
 */
export type TaskCategory = 'design' | 'ffe' | 'procurement' | 'admin';

export const TASK_CATEGORIES: TaskCategory[] = ['design', 'ffe', 'procurement', 'admin'];

export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = {
  design: 'Design',
  ffe: 'FF&E',
  procurement: 'Procurement & shipping',
  admin: 'Admin & operations',
};

/**
 * A category for a task nobody has categorised: every task raised before the
 * column existed, and any the AI left blank. Worked out from the seat that
 * owns it where there is one, then from its kind.
 */
export function defaultTaskCategory(kind: TaskKind, seat?: string | null): TaskCategory {
  if (seat === 'design') return 'design';
  if (seat === 'hotel_ffe') return 'ffe';
  switch (kind) {
    case 'spec_review':
    case 'client_approval':
      return 'design';
    case 'quote_request':
      return 'ffe';
    case 'order_followup':
    case 'scheduling':
      return 'procurement';
    default:
      return 'admin';
  }
}

export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';

export const TASK_KINDS: TaskKind[] = [
  'quote_request', 'order_followup', 'client_approval',
  'spec_review', 'scheduling', 'admin',
];

export const TASK_STATUSES: TaskStatus[] = [
  'open', 'in_progress', 'blocked', 'done', 'cancelled',
];

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  quote_request: 'Quote request',
  order_followup: 'Order follow-up',
  client_approval: 'Client approval',
  spec_review: 'Spec review',
  scheduling: 'Scheduling',
  admin: 'Admin',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

/**
 * Which role owns each kind of task. Claude decides the kind from the
 * email; this table decides the person, so assignment stays explainable.
 */
export const TASK_KIND_ROLE: Record<TaskKind, UserRole> = {
  quote_request: 'procurement',
  order_followup: 'procurement',
  client_approval: 'principal',
  spec_review: 'designer',
  scheduling: 'coordinator',
  admin: 'assistant',
};

/**
 * How long each kind of work may sit before it is late, when the email
 * itself never said.
 *
 * Almost no email states a deadline, so Claude returns none and the task
 * arrived with an empty due date — which reads on the board as "no rush"
 * and, worse, makes the task unchaseable: the follow-up engine can only
 * call something late against a date. The studio's own SLA already answers
 * this per kind of work, so the date comes from there rather than being
 * invented.
 *
 * Read against SlaSettings, so a studio that changes its SLA changes these
 * with it. A date the email DID state always wins.
 */
export function defaultDueDays(kind: TaskKind, sla: SlaSettings): number {
  switch (kind) {
    // A quote unresolved past this is exactly what the SLA is about.
    case 'quote_request':
      return sla.quote_response_days;
    case 'client_approval':
      return sla.client_approval_days;
    case 'order_followup':
      return sla.vendor_silence_days;
    // Nothing in the SLA speaks to these two, so they take the studio's
    // shortest external promise — work the client can see should not sit
    // longer than work the client is waiting on.
    case 'spec_review':
    case 'scheduling':
      return sla.quote_response_days;
    // Internal admin is the only kind nobody outside is waiting on.
    case 'admin':
    default:
      return sla.vendor_silence_days;
  }
}

/** That many days from today, as an ISO date. */
export function dueDateFor(kind: TaskKind, sla: SlaSettings, from = new Date()): string {
  const due = new Date(from);
  due.setDate(due.getDate() + defaultDueDays(kind, sla));
  return due.toISOString().slice(0, 10);
}

/**
 * The studio's named seats, from "Team Roles Scorecards v3 — Named Seats"
 * (10 September 2026). The rule that document sets is one owner per
 * outcome: dual-seat is allowed, dual-ownership of the same outcome is not.
 *
 * A seat is more specific than a role. Both Carissa and Joanna do
 * coordination, but only Carissa owns the data standard and POs, and the
 * document is explicit that Joanna "is not a second Carissa". Routing by
 * seat keeps that distinction; routing by role alone loses it.
 */
export type Seat =
  | 'owner'
  | 'coo'
  | 'operations'
  | 'pm_support'
  | 'technical_production'
  | 'hotel_ffe'
  | 'design';

export interface SeatBrief {
  /**
   * The person holding it today, by full name; null where the document says
   * HIRE. Two people sharing a seat are separated by " / " — read them with
   * seatPeople() rather than splitting by hand.
   */
  person: string | null;
  label: string;
  role: UserRole;
  /** What this seat owns, in the document's own words — used to route work. */
  owns: string;
  /** What it must NOT own. Just as important: it stops mis-assignment. */
  notOwns: string;
}

export const SEATS: Record<Seat, SeatBrief> = {
  owner: {
    person: 'Janelle Kandziora',
    label: 'Owner',
    role: 'principal',
    owns: 'vision, brand, new-client close, hotel relationship at principal level, hire/fire, approving money leaving the bank, checks and wires, live-project renames',
    notOwns: 'assembling status, issuing finish schedules, building POs, being default designer, the daily task board',
  },
  coo: {
    person: null, // vacant — the document's first hire
    label: 'Integrator / COO',
    role: 'coordinator',
    owns: 'the weekly meeting, scorecards, seat capacity, making sure the RFI tracker exists and is used, CRM cadence, cross-seat issues with no other owner, protecting the calendar of the Owner',
    notOwns: 'design intent, drawing, vendor negotiation, writing POs, being the day-to-day contact for the hotel client',
  },
  operations: {
    person: 'Carissa Kolbeck',
    label: 'Operations + Finance',
    role: 'coordinator',
    owns: 'Houzz data standard and hygiene, RFI numbering and the M/W/F digest, due dates, QuickBooks COGS/AR/AP, purchase orders from complete specs, card payment after approval, the weekly ops pack',
    notOwns: 'aesthetic decisions, issued-set version control, being default designer, approving spend',
  },
  pm_support: {
    person: 'Joanna Ramos',
    label: 'Operations Support / PM assistant',
    role: 'assistant',
    owns: 'pushing tasks so each has ONE owner, a due date and a next step, chasing overdue and unassigned tasks, scanning proposals for ones with no next step',
    notOwns: 'answering design RFIs, inventing specs, rewriting the data standard, being a second Operations seat',
  },
  technical_production: {
    person: 'Victoria Manayan',
    label: 'Technical production',
    role: 'assistant',
    owns: 'Canva finish schedules built from the current Drive set, matching Canva to Drive, logging disagreements as RFIs, Houzz record cleanup and folder hygiene',
    notOwns: 'client email, purchase orders, renaming live projects, design intent, being Lead Designer or PM',
  },
  hotel_ffe: {
    // The roles document spells her "Adelaide"; her account is Adeleigh.
    // The misspelling matched nobody, so hotel work never reached her.
    person: 'Adeleigh McGee',
    label: 'Hotel FF&E / Procurement',
    role: 'procurement',
    owns: 'hotel buying, order tracking, receiving and damage claims, vendor follow-up, flagging delays within 24 hours, hotel order status',
    notOwns: 'finding the next hotel client, residential design boards, approving spend',
  },
  design: {
    person: 'Brianna Johnson / Amanda Neubecker',
    label: 'Lead / Technical Designer',
    role: 'designer',
    owns: 'design intent and issued sets on assigned projects, elevations and drawings, complete specs with no TBD rows, client design email',
    notOwns: 'due dates, purchase orders, sale or contract, hotel backup',
  },
};

export const SEAT_KEYS: Seat[] = [
  'owner', 'coo', 'operations', 'pm_support', 'technical_production', 'hotel_ffe', 'design',
];

/** The people holding a seat, one full name each; [] for a vacant seat. */
export function seatPeople(seat: Seat): string[] {
  return (SEATS[seat]?.person ?? '')
    .split('/')
    .map((name) => name.trim())
    .filter(Boolean);
}

export type EmailClass =
  | 'vendor_quote'
  | 'order_confirmation'
  | 'client_approval'
  | 'houzz_notification'
  | 'general'
  | 'unclassified';

export type DocumentType = 'quote' | 'purchase_order' | 'order_confirmation' | 'other';

export type PromptCategory = 'design' | 'procurement' | 'client' | 'admin';

// ── Permissions ─────────────────────────────────────────────

export type Resource =
  | 'projects'
  | 'spec_gaps'
  | 'vendors'
  | 'purchase_orders'
  | 'documents'
  | 'emails'
  | 'tasks'
  | 'follow_ups'
  | 'drafts'
  | 'prompts'
  | 'reports'
  | 'digests'
  | 'team'
  | 'settings'
  | 'ops';

export type Action = 'read' | 'create' | 'update' | 'delete';

/** Every resource, in the order the permission matrix should display them. */
export const RESOURCES: Resource[] = [
  'projects', 'spec_gaps', 'vendors', 'purchase_orders', 'documents', 'emails',
  'tasks', 'follow_ups', 'drafts', 'prompts', 'reports', 'digests',
  'team', 'settings', 'ops',
];

export const RESOURCE_LABELS: Record<Resource, string> = {
  projects: 'Projects',
  spec_gaps: 'Spec gaps',
  vendors: 'Vendors',
  purchase_orders: 'Purchase orders',
  documents: 'Documents',
  emails: 'Email',
  tasks: 'Tasks',
  follow_ups: 'Follow-ups',
  drafts: 'Drafts',
  prompts: 'Prompt library',
  reports: 'Reports',
  digests: 'Morning digest',
  team: 'Team & roles',
  settings: 'Studio settings',
  ops: 'Run jobs',
};

export const ACTIONS: Action[] = ['read', 'create', 'update', 'delete'];

export const USER_ROLES: UserRole[] = [
  'principal', 'designer', 'procurement', 'coordinator', 'assistant',
];

/**
 * Who may do what. A five-person studio does not need compartmented
 * reads — everyone can see the org's work, which is the point of the
 * system. What is restricted is *writing*: changing money, changing
 * someone else's assignment, and changing the rules.
 *
 * Mirrored by the RLS policies in supabase/schema.sql. Change both.
 */
const WRITERS: Record<Resource, UserRole[]> = {
  projects: ['principal', 'coordinator', 'designer'],
  spec_gaps: ['principal', 'coordinator', 'designer', 'procurement', 'assistant'],
  vendors: ['principal', 'coordinator', 'procurement'],
  purchase_orders: ['principal', 'coordinator', 'procurement'],
  documents: ['principal', 'coordinator', 'designer', 'procurement', 'assistant'],
  emails: ['principal', 'coordinator'],
  tasks: ['principal', 'coordinator', 'designer', 'procurement', 'assistant'],
  follow_ups: ['principal', 'coordinator', 'procurement'],
  drafts: ['principal', 'coordinator', 'designer', 'procurement', 'assistant'],
  prompts: ['principal', 'coordinator', 'designer'],
  reports: ['principal', 'coordinator'],
  digests: ['principal', 'coordinator'],
  team: ['principal'],
  settings: ['principal'],
  ops: ['principal', 'coordinator'],
};

/** Destructive actions stay with the people accountable for the studio. */
const DELETERS: UserRole[] = ['principal', 'coordinator'];

/** Reassigning someone else's work, and reading the full audit trail. */
export const SUPERVISOR_ROLES: UserRole[] = ['principal', 'coordinator'];

export function can(role: UserRole | null, resource: Resource, action: Action): boolean {
  if (!role) return false;
  // Settings and team membership are CHANGED only by a principal, and read
  // by anyone. The comment here used to claim the opposite of the code —
  // "never readable by everyone" over a line returning true — which read as
  // a bug and is not one: the roster is where every assignee name in the app
  // comes from, and revoking it would empty the owner dropdown on the task
  // board rather than hide an admin screen. The screens themselves are
  // hidden by whether the person may change them, not read them.
  if (resource === 'settings' || resource === 'team') {
    return action === 'read' ? true : WRITERS[resource].includes(role);
  }
  if (action === 'read') return true;
  if (action === 'delete') return DELETERS.includes(role) && WRITERS[resource].includes(role);
  return WRITERS[resource].includes(role);
}

/** True when this person may reassign work that is not their own. */
export function canSupervise(role: UserRole | null): boolean {
  return !!role && SUPERVISOR_ROLES.includes(role);
}

/**
 * Seats that run the task board, whatever role they carry.
 *
 * The roles document hands PM support "pushing tasks so each has ONE owner,
 * a due date and a next step, chasing overdue and unassigned tasks". That is
 * the task board, and it cannot be done without moving other people's work —
 * yet the seat's role is `assistant`, which `canSupervise` excludes.
 *
 * Widening the ROLE would have been the easy fix and the wrong one: it would
 * hand the same power to Technical production, an assistant whose seat says
 * in as many words that it must not be "Lead Designer or PM". Only the seat
 * separates them.
 */
export const TASK_BOARD_SEATS: Seat[] = ['owner', 'coo', 'operations', 'pm_support'];

/**
 * The seat accountable for task hygiene — the one chased when a task has no
 * owner, no next step or no due date.
 */
export const TASK_HYGIENE_SEAT: Seat = 'pm_support';

/**
 * True when this person may move work that is not their own.
 *
 * Deliberately separate from `canSupervise`, which still guards money,
 * settings and the studio's rules. Running the board is not the same
 * authority as approving spend, and the document keeps them apart.
 */
export function canManageTasks(role: UserRole | null, seat: Seat | null | undefined): boolean {
  if (canSupervise(role)) return true;
  return !!seat && TASK_BOARD_SEATS.includes(seat);
}

export const ROLE_LABELS: Record<UserRole, string> = {
  principal: 'Principal / Owner',
  designer: 'Designer',
  procurement: 'Procurement / FF&E',
  coordinator: 'Coordinator / Admin',
  assistant: 'Assistant',
};

// ── Entity shapes ───────────────────────────────────────────

export interface Organization {
  id: string;
  name: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Profile {
  id: string;
  org_id: string;
  full_name: string | null;
  email: string | null;
  role: UserRole;
  avatar_url: string | null;
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  client_name: string | null;
  stage: ProjectStage;
  status: string;
  budget: number | null;
  start_date: string | null;
  target_install: string | null;
  assigned_to: string | null;
  houzz_ref: string | null;
  /** Town and state, as the studio's project sheet writes it ("Ojai, CA"). */
  location: string | null;
  /**
   * 'Open' or 'In Progress', verbatim from the studio's project sheet.
   *
   * Not a second `stage`. The sheet's two words do not map onto the nine
   * pipeline stages, so the import keeps what the sheet said rather than
   * guessing a stage per project; `stage` is set by a person in the UI.
   * Null for a project that did not come from the sheet.
   */
  sheet_status: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Vendor {
  id: string;
  org_id: string;
  name: string;
  category: string | null;
  contacts: { name?: string; email?: string; phone?: string }[];
  notes: string | null;
  /** The vendor's own site, e.g. "https://houzz.com". Null until someone adds it. */
  website: string | null;
}

export interface PurchaseOrder {
  id: string;
  org_id: string;
  po_number: string | null;
  project_id: string | null;
  vendor_id: string | null;
  amount: number | null;
  status: PoStatus;
  order_date: string | null;
  eta: string | null;
  received_date: string | null;
}

export interface FollowUp {
  id: string;
  org_id: string;
  type: FollowUpType;
  project_id: string | null;
  vendor_id: string | null;
  target: string | null;
  reason: string | null;
  due_date: string | null;
  status: FollowUpStatus;
  draft_id: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  org_id: string;
  title: string;
  detail: string | null;
  kind: TaskKind;
  /** Migration 0026; null on tasks raised before it. */
  category?: TaskCategory | null;
  status: TaskStatus;
  assigned_to: string | null;
  assigned_role: UserRole | null;
  project_id: string | null;
  vendor_id: string | null;
  source_email_id: string | null;
  due_date: string | null;
  created_at: string;
}

export interface SpecGap {
  id: string;
  org_id: string;
  project_id: string;
  item: string;
  missing_fields: string[];
  resolved: boolean;
}

export interface PromptVariable {
  key: string;
  label: string;
  required?: boolean;
}

export interface Prompt {
  id: string;
  org_id: string;
  title: string;
  category: PromptCategory;
  description: string | null;
  template: string;
  variables: PromptVariable[];
}

// ── API envelope ────────────────────────────────────────────

export interface ApiError {
  error: string;
  detail?: string;
}

export type ApiResult<T> = { data: T } | ApiError;

// ── Dynamic module access ───────────────────────────────────

/**
 * The matrix above is the studio's DEFAULT. A principal can override any
 * single cell of it — "let procurement edit projects", "stop assistants
 * creating drafts" — from Team & Roles, and those overrides live in the
 * `role_permissions` table, keyed exactly like this.
 *
 * Overrides are SPARSE: a missing key means "use the default". A studio
 * that has never opened the screen behaves exactly as it did before, and
 * the matrix above stays the thing you read to understand the system.
 *
 * Mirrored by can_act() in supabase/migrations/0008. Change both.
 */
export type PermissionKey = string; // `${UserRole}:${Resource}:${Action}`
export type PermissionOverrides = Record<PermissionKey, boolean>;

export function permissionKey(role: UserRole, resource: Resource, action: Action): PermissionKey {
  return `${role}:${resource}:${action}`;
}

/**
 * Cells that may never be revoked. Without them a studio can lock itself
 * out of its own permission screen, with no way back short of editing the
 * database by hand.
 *
 * That risk is exactly one thing: the principal losing the two screens that
 * hand access back. Every read used to be locked too, on the reasoning that
 * seeing the studio's work is the point of the system — but "the assistant
 * should not see purchase order values" is a legitimate decision a studio
 * gets to make, and the whole VIEW column being greyed out gave it no way to
 * make it. A principal can now close a module to a role, and can still
 * always reach Team & roles and Studio settings to reopen it.
 */
export function isLockedPermission(role: UserRole, resource: Resource, action: Action): boolean {
  void action;
  if (role !== 'principal') return false;
  return resource === 'team' || resource === 'settings';
}

/** `can()`, with the studio's own overrides applied. */
export function canWith(
  overrides: PermissionOverrides | null | undefined,
  role: UserRole | null,
  resource: Resource,
  action: Action,
): boolean {
  if (!role) return false;
  if (isLockedPermission(role, resource, action)) return can(role, resource, action);
  const override = overrides?.[permissionKey(role, resource, action)];
  if (typeof override === 'boolean') return override;
  return can(role, resource, action);
}

/** One stored override, as the permissions API returns it. */
export interface RolePermissionRow {
  role: UserRole;
  resource: Resource;
  action: Action;
  allowed: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

// ── AI usage ────────────────────────────────────────────────

/**
 * Every place the studio spends Claude tokens. Recorded at the single
 * chokepoint in services/anthropic.ts, so a new caller cannot quietly
 * spend money without showing up here.
 */
export type AiFeature =
  | 'email.extract'
  | 'task.extract'
  | 'document.extract'
  | 'followup.draft'
  | 'reply.draft'
  | 'digest.summary'
  | 'report.narrative'
  | 'prompt.run'
  | 'assistant.answer'
  | 'document.read'
  | 'image.render'
  | 'video.render'
  | 'audit.chat';

export const AI_FEATURES: AiFeature[] = [
  'email.extract', 'task.extract', 'document.extract', 'followup.draft',
  'reply.draft', 'digest.summary', 'report.narrative', 'prompt.run', 'assistant.answer', 'document.read',
  'image.render', 'video.render', 'audit.chat',
];

export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
  'email.extract': 'Reading email',
  'task.extract': 'Raising tasks',
  'document.extract': 'Parsing documents',
  'followup.draft': 'Drafting follow-ups',
  'reply.draft': 'Drafting replies',
  'digest.summary': 'Morning digest',
  'report.narrative': 'Weekly report',
  'prompt.run': 'Prompt Studio',
  'assistant.answer': 'Assistant answers',
  'document.read': 'Reading documents on request',
  'image.render': 'Presentation boards',
  'video.render': 'Video clips',
  'audit.chat': 'Audit Chat',
};

/** Whether the spend was the agent working, or a person pressing a button. */
export const AI_FEATURE_TRIGGER: Record<AiFeature, 'agent' | 'person'> = {
  'email.extract': 'agent',
  'task.extract': 'agent',
  'document.extract': 'agent',
  'followup.draft': 'agent',
  'reply.draft': 'agent',
  'digest.summary': 'agent',
  'report.narrative': 'agent',
  'prompt.run': 'person',
  'assistant.answer': 'person',
  'document.read': 'person',
  'image.render': 'person',
  'video.render': 'person',
  'audit.chat': 'person',
};

/**
 * US dollars per MILLION tokens, from Anthropic's published rates.
 * Cache writes bill at ~1.25x input and cache reads at ~0.1x, so both are
 * derived from the input rate rather than listed per model.
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/**
 * The image models, priced PER IMAGE rather than per token.
 *
 * Kept beside the Claude rates because they land on the same spend report:
 * a studio looking at what the month cost should not have to know that one
 * number came from tokens and the other from a count of pictures.
 *
 * Board work defaults to Pro. The whole point of the house template is that
 * every room's board looks like the same drawing set, and holding a supplied
 * reference exactly is what the premium tier is actually better at.
 */
export interface ImageModel {
  id: string;
  label: string;
  usdPerImage: number;
  note: string;
  /**
   * How it makes the page.
   *
   * `raster` models photograph it — the elevation looks built, the swatches
   * look like real tile, and it costs per image on a billed account.
   * `vector` models are text models that draw SVG instead: flat and
   * illustrated, but the typography is exact and there is no image billing,
   * which matters because Google gives image generation no free tier at all.
   */
  kind: 'raster' | 'vector';
}

export const IMAGE_MODELS: ImageModel[] = [
  {
    id: 'gemini-3-pro-image',
    label: 'Gemini 3 Pro Image',
    usdPerImage: 0.18,
    kind: 'raster',
    note: 'Photoreal. Best at holding the house template and the supplied materials. Needs image billing.',
  },
  {
    id: 'gemini-3.1-flash-image',
    label: 'Gemini 3.1 Flash Image',
    usdPerImage: 0.067,
    kind: 'raster',
    note: 'Photoreal, a third of the price and quicker. Needs image billing.',
  },
  {
    id: 'gemini-2.5-flash-image',
    label: 'Gemini 2.5 Flash Image',
    usdPerImage: 0.039,
    kind: 'raster',
    note: 'Photoreal and the cheapest raster model. Needs image billing.',
  },
  {
    id: 'gemini-flash-lite-latest',
    label: 'Gemini Flash Lite (drawn)',
    usdPerImage: 0,
    kind: 'vector',
    note: 'Draws the board as SVG on the free tier: exact type, illustrated rather than photographed.',
  },
];

/**
 * Who makes the picture on a rendering board.
 *
 * `gemini` uses the Gemini model chosen beside it (Claude stepping in only
 * if it fails). A Claude id makes Claude draw every picture itself, as an
 * illustrated SVG — never a photograph, whichever Claude it is. The slower
 * models draw a smaller picture so they finish inside one request.
 */
export interface PictureEngine {
  id: string;
  label: string;
  note: string;
}

export const PICTURE_ENGINES: PictureEngine[] = [
  {
    id: 'openai',
    label: 'OpenAI GPT Image',
    note: 'Photoreal renderings, and the best at keeping lettering and layouts accurate. Billed per image on the OpenAI key below; Claude sketches if it fails.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5 — sketch',
    note: 'Fastest Claude drawing (~20s). Simple shapes; never a photograph.',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5 — sketch',
    note: 'Better-judged drawing, slower (~35–50s). Can time out on a long brief.',
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5 — sketch',
    note: 'Most careful drawing and the slowest; the likeliest to time out.',
  },
];

export const DEFAULT_PICTURE_ENGINE = 'openai';

/**
 * Cloudflare Workers AI image models. Priced in "neurons" against a free
 * daily allowance of 10,000 rather than in dollars; `neuronsPerImage` is at
 * the default 1024×1024, for the settings screen to say how far it goes.
 */
export interface CloudflareImageModel {
  id: string;
  label: string;
  note: string;
  /** Diffusion steps the model accepts; the setting is clamped to this. */
  maxSteps: number;
}

export const CLOUDFLARE_IMAGE_MODELS: CloudflareImageModel[] = [
  {
    id: '@cf/black-forest-labs/flux-1-schnell',
    label: 'FLUX.1 [schnell]',
    note: 'Photoreal and fast. ~58 neurons an image at 4 steps, ~96 at 8 — roughly 100–170 free images a day.',
    maxSteps: 8,
  },
  {
    id: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
    label: 'Stable Diffusion XL',
    note: 'The older model. Softer detail; worth trying only if FLUX is unavailable.',
    maxSteps: 20,
  },
];

export const DEFAULT_CLOUDFLARE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

/** 1024×1024 at 4 or 8 steps for FLUX: speed against detail. */
export const DEFAULT_CLOUDFLARE_STEPS = 8;

/** Whether this model photographs the page or draws it. Unknown ids are assumed raster. */
export function imageModelKind(id: string): 'raster' | 'vector' {
  return IMAGE_MODELS.find((m) => m.id === id)?.kind ?? 'raster';
}

export const DEFAULT_IMAGE_MODEL = 'gemini-3-pro-image';

/** What a render cost, in USD. An unpriced model reports 0 rather than guessing. */
export function imageCostUsd(model: string, images = 1): number {
  return (IMAGE_MODELS.find((m) => m.id === model)?.usdPerImage ?? 0) * images;
}

/**
 * Grok's own models, kept in a list of their own rather than mixed into
 * IMAGE_MODELS.
 *
 * They are not interchangeable with the board models: `services/images.ts`
 * posts to Gemini's endpoint and nothing else, so a Grok id selected in the
 * board dropdown would be sent to Google and 404. Two providers, two lists,
 * and no way to pick one and reach the other.
 */
export interface GrokImageModel {
  id: string;
  label: string;
  usdPerImage: number;
  note: string;
}

export const GROK_IMAGE_MODELS: GrokImageModel[] = [
  {
    id: 'grok-imagine-image-2.0',
    label: 'Grok Imagine 2.0',
    usdPerImage: 0.04,
    note: 'Photoreal renderings and concept imagery. xAI recommends this one.',
  },
  {
    id: 'grok-imagine-image',
    label: 'Grok Imagine',
    usdPerImage: 0.02,
    note: 'Half the price, for iterating on a direction before anyone sees it.',
  },
  {
    id: 'grok-imagine-image-quality',
    label: 'Grok Imagine (quality)',
    usdPerImage: 0.05,
    note: 'The dearest tier, for the one that goes in front of a client.',
  },
];

export const DEFAULT_GROK_IMAGE_MODEL = 'grok-imagine-image-2.0';

/**
 * OpenAI's GPT Image models. Priced per image, and by quality and shape:
 * `usd` is the price of a 1024×1024 image at each quality, and a wide or
 * tall one (1536×1024 / 1024×1536) costs about half as much again.
 */
export type OpenAiQuality = 'low' | 'medium' | 'high';

export interface OpenAiImageModel {
  id: string;
  label: string;
  usd: Record<OpenAiQuality, number>;
  /** The price is an estimate, not OpenAI's published figure. */
  approx?: boolean;
  note: string;
}

export const OPENAI_IMAGE_MODELS: OpenAiImageModel[] = [
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    usd: { low: 0.011, medium: 0.042, high: 0.167 },
    approx: true,
    note: 'Recommended. Draws clean, correctly spelled lettering and coherent layouts — the one for plans and boards. About 20–50 seconds a picture. Price shown is an estimate.',
  },
  {
    id: 'chatgpt-image-latest',
    label: 'ChatGPT Image (latest)',
    usd: { low: 0.011, medium: 0.042, high: 0.167 },
    approx: true,
    note: 'The model ChatGPT itself draws with, always its newest. Best lettering and layout. Price shown is an estimate; OpenAI bills by usage.',
  },
  {
    id: 'gpt-image-1.5',
    label: 'GPT Image 1.5',
    usd: { low: 0.009, medium: 0.034, high: 0.133 },
    approx: true,
    note: 'A step up from GPT Image 1 at a slightly lower price. Price shown is an estimate.',
  },
  {
    id: 'gpt-image-1',
    label: 'GPT Image 1',
    usd: { low: 0.011, medium: 0.042, high: 0.167 },
    note: 'The full model. Follows a long brief closely and draws legible text. Needs a verified OpenAI organization.',
  },
  {
    id: 'gpt-image-1-mini',
    label: 'GPT Image 1 mini',
    usd: { low: 0.005, medium: 0.011, high: 0.036 },
    note: 'About a quarter of the price, for drafts and iterating on a direction.',
  },
];

export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2';
export const DEFAULT_OPENAI_QUALITY: OpenAiQuality = 'medium';
export const OPENAI_QUALITIES: { id: OpenAiQuality; label: string }[] = [
  { id: 'low', label: 'Low — quickest, cheapest' },
  { id: 'medium', label: 'Medium — good for most renders' },
  { id: 'high', label: 'High — for the one a client sees' },
];

export function openAiImageCostUsd(model: string, quality: OpenAiQuality, wide = false, images = 1): number {
  const base = OPENAI_IMAGE_MODELS.find((m) => m.id === model)?.usd[quality] ?? 0;
  return base * (wide ? 1.5 : 1) * images;
}

export function grokImageCostUsd(model: string, images = 1): number {
  return (GROK_IMAGE_MODELS.find((m) => m.id === model)?.usdPerImage ?? 0) * images;
}

/**
 * Video, priced per SECOND rather than per picture.
 *
 * Worth stating plainly wherever this list is shown: at eight cents a
 * second, one fifteen-second clip costs more than six presentation boards.
 * `maxSeconds` is the provider's own ceiling, and the studio's own cap
 * (MEDIA_MAX_SECONDS) may be lower still.
 */
export interface VideoModel {
  id: string;
  label: string;
  usdPerSecond: number;
  maxSeconds: number;
  note: string;
}

export const VIDEO_MODELS: VideoModel[] = [
  {
    id: 'grok-imagine-video-1.5',
    label: 'Grok Imagine Video 1.5',
    usdPerSecond: 0.08,
    maxSeconds: 15,
    note: 'Up to 1080p from text or a still. xAI recommends this one.',
  },
  {
    id: 'grok-imagine-video',
    label: 'Grok Imagine Video',
    usdPerSecond: 0.05,
    maxSeconds: 15,
    note: 'Cheaper and lower resolution — right for a draft nobody outside the studio sees.',
  },
];

export const DEFAULT_VIDEO_MODEL = 'grok-imagine-video-1.5';

/** What a clip cost, in USD. An unpriced model reports 0 rather than guessing. */
export function videoCostUsd(model: string, seconds: number): number {
  return (VIDEO_MODELS.find((m) => m.id === model)?.usdPerSecond ?? 0) * Math.max(0, seconds);
}

/** The provider's ceiling for a model, so a caller cannot ask for 60 seconds. */
export function maxVideoSeconds(model: string): number {
  return VIDEO_MODELS.find((m) => m.id === model)?.maxSeconds ?? 15;
}

/**
 * A piece of media the studio asked for, as the browser sees it.
 *
 * An image is `done` the moment it is asked for; a video is not, and that
 * is the whole reason this shape exists — something has to be shown while
 * the provider is still drawing.
 */
export type MediaJobStatus = 'pending' | 'done' | 'failed' | 'expired';

export interface MediaJobView {
  id: string;
  kind: 'image' | 'video';
  status: MediaJobStatus;
  model: string;
  prompt: string;
  seconds: number | null;
  createdAt: string;
  /** Set once it is done: the row to drop into the answer, preview and all. */
  item: AssistantItem | null;
  /** Set when it failed or expired: what to tell the person, in words. */
  error: string | null;
}

export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens?: number;
  cache_read_tokens?: number;
}

/**
 * Cost of one call, in USD. An unknown model prices at 0 rather than
 * guessing: a wrong number on a spend page is worse than a missing one,
 * and the report names any model it could not price.
 */
export function estimateCostUsd(model: string, t: TokenCounts): number {
  const rate = MODEL_PRICING[model];
  if (!rate) return 0;
  const perInputToken = rate.input / 1_000_000;
  return (
    t.input_tokens * perInputToken +
    t.output_tokens * (rate.output / 1_000_000) +
    (t.cache_write_tokens ?? 0) * perInputToken * CACHE_WRITE_MULTIPLIER +
    (t.cache_read_tokens ?? 0) * perInputToken * CACHE_READ_MULTIPLIER
  );
}

export interface AiUsageRow {
  id: string;
  feature: string;
  model: string;
  actor_name: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  latency_ms: number | null;
  ok: boolean;
  error: string | null;
  created_at: string;
}

export interface AiUsageBucket {
  key: string;
  label: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface AiUsageReport {
  org_name: string;
  /** Days covered, counted back from now. */
  window_days: number;
  generated_at: string;
  totals: {
    calls: number;
    failed: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cost_usd: number;
    avg_latency_ms: number | null;
  };
  /** Cost over the window immediately before this one, for the trend. */
  previous_cost_usd: number;
  /**
   * What has been spent since midnight, and what a day normally costs.
   *
   * Separate from the window totals because it answers a different
   * question: the window says what the agent costs to run, and this says
   * whether today is going the usual way. A studio watching a bill wants
   * to know that before the month closes, not after.
   *
   * `date` is the day this covers, resolved in the reader's own timezone —
   * a report opened in California must not roll over to tomorrow at five
   * in the afternoon.
   */
  today: {
    date: string;
    cost_usd: number;
    calls: number;
    /** The mean daily cost over the rest of the window; 0 when there is no history. */
    avg_daily_cost_usd: number;
  };
  by_feature: AiUsageBucket[];
  by_model: AiUsageBucket[];
  by_day: AiUsageBucket[];
  by_person: AiUsageBucket[];
  recent: AiUsageRow[];
  /** Models present in the data that have no published price here. */
  unpriced_models: string[];
}

// ── Role-wise dashboard ─────────────────────────────────────

/**
 * A dashboard card, named. The API computes every figure once; each role
 * is then shown only the ones its seat is accountable for, in the order
 * that person actually works. The client's stated test is "you don't need
 * to be in this system" — so the first card someone sees has to be the one
 * that would otherwise have arrived as a text message.
 */
export type DashboardCardKey =
  | 'myOpenTasks'
  | 'myOverdueTasks'
  | 'unassignedTasks'
  | 'tasksWithoutNextStep'
  | 'openFollowUps'
  | 'awaitingClient'
  | 'draftsPending'
  | 'specGaps'
  | 'openPOs'
  | 'activeProjects'
  | 'installsSoon'
  | 'emailsRead'
  | 'documentsParsed'
  | 'escalations';

export const DASHBOARD_CARD_KEYS: DashboardCardKey[] = [
  'myOpenTasks', 'myOverdueTasks', 'unassignedTasks', 'tasksWithoutNextStep',
  'openFollowUps', 'awaitingClient', 'draftsPending', 'specGaps', 'openPOs',
  'activeProjects', 'installsSoon', 'emailsRead', 'documentsParsed', 'escalations',
];

export const DASHBOARD_CARD_LABELS: Record<DashboardCardKey, string> = {
  myOpenTasks: 'My open tasks',
  myOverdueTasks: 'My overdue tasks',
  unassignedTasks: 'Unassigned tasks',
  tasksWithoutNextStep: 'No next step',
  openFollowUps: 'Open follow-ups',
  awaitingClient: 'Awaiting client',
  draftsPending: 'Drafts to review',
  specGaps: 'Open spec gaps',
  openPOs: 'Open purchase orders',
  activeProjects: 'Active projects',
  installsSoon: 'Installs approaching',
  emailsRead: 'Emails read',
  documentsParsed: 'Documents parsed',
  escalations: 'Escalated to you',
};

/** Where a card sends you when it is not zero. */
export const DASHBOARD_CARD_LINKS: Record<DashboardCardKey, string> = {
  myOpenTasks: '/tasks',
  myOverdueTasks: '/tasks',
  unassignedTasks: '/tasks',
  tasksWithoutNextStep: '/tasks',
  openFollowUps: '/follow-ups',
  awaitingClient: '/follow-ups',
  draftsPending: '/drafts',
  specGaps: '/projects',
  openPOs: '/vendors',
  activeProjects: '/projects',
  installsSoon: '/projects',
  emailsRead: '/inbox',
  documentsParsed: '/documents',
  escalations: '/follow-ups',
};

export interface RoleDashboard {
  /** The one sentence this role should read first. */
  focus: string;
  cards: DashboardCardKey[];
}

/**
 * Derived from "Team Roles Scorecards v3 — Named Seats" (10 Sep 2026):
 * each role sees what its seat OWNS, and not what the document says it
 * must not own. Procurement gets orders and vendor silence, never the task
 * board; the assistant seats get the board and never the money; the
 * principal gets only what the document reserves to the Owner, because
 * the studio's acceptance test is that she does not need to be in here.
 */
export const ROLE_DASHBOARD: Record<UserRole, RoleDashboard> = {
  principal: {
    focus: 'What needs you, and only you. Everything else belongs to a seat.',
    cards: ['escalations', 'awaitingClient', 'draftsPending', 'activeProjects', 'openPOs', 'installsSoon'],
  },
  coordinator: {
    focus: 'The board: nothing unassigned, nothing without a next step, nothing silent.',
    cards: ['unassignedTasks', 'tasksWithoutNextStep', 'openFollowUps', 'myOverdueTasks', 'openPOs', 'activeProjects'],
  },
  designer: {
    focus: 'Design intent and issued sets. No TBD rows reaching procurement.',
    cards: ['myOpenTasks', 'myOverdueTasks', 'specGaps', 'draftsPending', 'activeProjects', 'documentsParsed'],
  },
  procurement: {
    focus: 'Orders moving, vendors answering. A delay gets flagged inside 24 hours.',
    cards: ['openPOs', 'myOpenTasks', 'myOverdueTasks', 'openFollowUps', 'installsSoon', 'documentsParsed'],
  },
  assistant: {
    focus: 'Your queue first, then the gaps: one owner, a date and a next step on every task.',
    cards: ['myOpenTasks', 'myOverdueTasks', 'unassignedTasks', 'tasksWithoutNextStep', 'draftsPending', 'emailsRead'],
  },
};

export interface DashboardSummary {
  role: UserRole | null;
  focus: string;
  /** The cards this role should see, already ordered. */
  cards: DashboardCardKey[];
  figures: Record<DashboardCardKey, number>;
  byStage: Record<string, number>;
  /** Seats with nobody in them — work routed there has no owner. */
  vacantSeats: { seat: Seat; label: string; role: UserRole }[];
}

// ── The assistant ───────────────────────────────────────────

/**
 * What the studio's assistant is called. She answers from the studio's own
 * records — projects, tasks, orders, email — rather than from anything
 * general, so she needs a name people can ask for by name.
 */
export const ASSISTANT_NAME = 'Jenny';
/**
 * The one question the browser answers itself rather than sending to the
 * model: it opens the end-of-day check-in (GET /assistant/checkin). Offered
 * as a chip under the briefing after four, and typed by anyone who knows it.
 */
export const CHECKIN_PROMPT = 'Do my end-of-day check-in';

/**
 * The other question the browser answers itself: it reads back the stored
 * morning digest (GET /assistant/digest) rather than spending a whole Claude
 * turn to fetch and paraphrase what was already written at 7am. Offered as a
 * chip under the briefing to those who supervise, and typed by anyone who
 * knows it.
 */
export const DIGEST_PROMPT = "Read me this morning's digest";

/**
 * The named personas a person can switch Jenny to — narrowing her to one
 * job, the way separate bots in another tool each do one thing. Picking
 * none means the full, unrestricted assistant: today's default behaviour.
 *
 * Named to match the six bots the studio already runs elsewhere, so the
 * picker reads as the same lineup rather than a different taxonomy.
 * "Calendar Ops" is deliberately not here yet — it would need a Google
 * Calendar connection this app has never asked for.
 */
export const AGENT_KEYS = ['inbox', 'vendors', 'projects', 'george', 'chief'] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export const AGENT_LABELS: Record<AgentKey, string> = {
  inbox: 'Inbox Triage',
  vendors: 'Vendor Follow-ups',
  projects: 'Project Coordinator',
  george: 'George',
  chief: 'Chief of Staff',
};

/** One line each — shown in the picker, and read back to Jenny herself. */
export const AGENT_BLURBS: Record<AgentKey, string> = {
  inbox: 'Reads and triages the mailbox and Drive, and drafts replies.',
  vendors: 'Chases vendors, and tracks purchase orders and follow-ups.',
  projects: 'Projects, tasks, spec gaps and the studio’s design work.',
  george: 'Quick capture only — turn what you just said into a task, nothing else.',
  chief: 'The daily digest, the team, reports, spend and the studio’s rules.',
};

/**
 * What an answer is made of.
 *
 * The assistant used to hand back one string, which meant every answer was
 * a paragraph: eight late orders arrived as eight clauses, and the reader
 * had to parse prose to find the one that mattered. Worse, the reply named
 * records the app already has screens for — a task, a project, an order —
 * with no way to get to them, so "chase PO-1042" ended in a search box.
 *
 * So an answer is now a lead sentence plus the rows behind it. The lead is
 * still the answer; the items are what it is about, each one linkable. The
 * model fills these in by calling the `answer` tool, which is also what
 * ends its turn — see services/assistant.ts.
 */
export type AssistantItemKind =
  | 'task'
  | 'project'
  | 'purchase_order'
  | 'vendor'
  | 'email'
  | 'document'
  | 'draft'
  | 'follow_up'
  | 'person'
  | 'report'
  /** A file that can be handed over: an email attachment or a Drive file. */
  | 'file'
  /** A bare URL worth pulling out of the prose — a Canva board, a tracker. */
  | 'link'
  /** A line that is not a record: a figure, a step, an observation. */
  | 'note';

/** How urgently a row reads. Drives one colour, nothing else. */
export type AssistantTone = 'neutral' | 'good' | 'warn' | 'crit';

/** One labelled value on a row — a column, when rows share their labels. */
export interface AssistantField {
  label: string;
  value: string;
}

/**
 * A file the assistant found and can hand over.
 *
 * Carries no Gmail or Drive id. `token` is an encrypted, org-bound,
 * expiring grant minted by the server at the moment the file was surfaced
 * to someone allowed to see it; the download endpoint trusts that and
 * nothing the browser could compose for itself.
 */
export interface AssistantFile {
  name: string;
  mimeType: string;
  /** Bytes; 0 when the source did not say. */
  size: number;
  /** Where it lives: the studio's Gmail or Drive, or uploaded by a person into a conversation. */
  source: 'gmail' | 'drive' | 'upload';
  /** Opaque download grant, for GET /api/assistant/file?token=… */
  token: string;
  /**
   * False when the file is too large for the API to relay (a serverless
   * response has a hard size cap). `webUrl` is the way in instead.
   */
  downloadable: boolean;
  /** The file where it lives — the Gmail message or the Drive file. */
  webUrl: string | null;
  /**
   * A short-lived URL the browser can play or draw from directly.
   *
   * Set only for media the app itself produced and stored. It exists
   * because the download endpoint cannot carry a video: a serverless
   * response caps at a few megabytes and an mp4 is larger than that, so a
   * clip is streamed from storage instead of relayed through the API. It
   * expires on its own; anything holding one refreshes by asking again.
   */
  streamUrl?: string | null;
}

export interface AssistantItem {
  kind: AssistantItemKind;
  /** The row's own id, exactly as a tool returned it, so the UI can link. */
  id?: string | null;
  title: string;
  /** One short line under the title: the owner, the project, the amount. */
  detail?: string | null;
  /** The right-hand fact — "12 days late", "$4,200", "due Friday". */
  meta?: string | null;
  /** An external URL: a document, a Canva board, a tracking page. */
  url?: string | null;
  tone?: AssistantTone;
  /**
   * The row's facts, labelled. Filled by the server from the record itself,
   * never transcribed by the model, so a list of twenty projects shows the
   * database's figures rather than a retelling of them.
   */
  fields?: AssistantField[];
  /** Set on `file` rows: what to download, and how. */
  file?: AssistantFile | null;
  /**
   * Show the file itself, not just its name: the pages of a PDF, or an
   * image. For a PDF the grant serves only the pages that matter, and
   * `pages` says which pages of the original they are.
   */
  preview?: 'pdf' | 'image' | 'video' | null;
  pages?: number[] | null;
}

export interface AssistantAnswer {
  /** The answer itself, in a sentence or two. Never empty. */
  lead: string;
  items: AssistantItem[];
  /** How many more exist beyond `items`; 0 when the list is complete. */
  more: number;
  /** One clause about anything that could not be checked. */
  caveat?: string | null;
  /**
   * The same answer as plain prose, for reading aloud.
   *
   * Kept separate because the two mediums want opposite things: a screen
   * wants eight scannable rows, and a speaker wants one sentence naming
   * the worst of them. Making either serve both makes both worse.
   */
  speech: string;
  /**
   * Long-form work the answer produced — a moodboard, a finish schedule, a
   * design direction — as Markdown, shown under the lead.
   *
   * `lead` is deliberately a sentence or two: it is also what gets read
   * aloud, and a schedule read aloud is noise. Work that runs to headings
   * and tables needs somewhere of its own to go, or the assistant either
   * crushes it into prose or does not attempt it at all.
   */
  document?: string | null;
  /** What that work is called, for its heading and for the draft it can become. */
  documentTitle?: string | null;
  /** Which parts of the studio's records the answer came from. */
  sources: string[];
  /**
   * What the person is likely to ask next, phrased as they would say it.
   *
   * An assistant that only answers leaves the person to think of the next
   * question; a good one already has it ready. Shown as tap-to-ask chips
   * under the latest answer. At most three.
   */
  suggestions?: string[];
}

/**
 * Where the person is in the app when they ask.
 *
 * Sent with every question so "what is late on this one?" means the
 * project on screen. Only the path travels: the server looks up what it
 * names with the caller's own permissions, so a crafted path can never
 * reveal a record the person could not already open.
 */
export interface AssistantPageContext {
  path: string;
}

/** Every item kind that has somewhere to go, and where. */
const ITEM_ROUTES: Record<AssistantItemKind, string | null> = {
  task: '/tasks',
  project: '/projects',
  purchase_order: '/vendors',
  vendor: '/vendors',
  email: '/inbox',
  document: '/documents',
  draft: '/drafts',
  follow_up: '/follow-ups',
  person: '/team',
  report: '/reports',
  // A file row is its buttons — download, open — not a link to a screen.
  file: null,
  link: null,
  note: null,
};

/** A uuid, so a hallucinated id never becomes a broken deep link. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where an answer item lives in the app, or null when it has nowhere.
 *
 * An id is only used when it really is one: the model is asked to pass the
 * row's id and mostly does, but a made-up "PO-1042" in that field would
 * otherwise become a link to a page that cannot exist. Without a usable id
 * the row still links to the screen its kind belongs on, which is always
 * better than a dead end.
 */
export function assistantItemHref(item: AssistantItem): string | null {
  if (item.kind === 'file') return null;
  if (item.kind === 'link' || item.url) return item.url ?? null;

  const base = ITEM_ROUTES[item.kind];
  if (!base) return null;

  const id = typeof item.id === 'string' && UUID.test(item.id) ? item.id : null;
  if (!id) return base;

  // These four can open one record: a project has its own route, the task
  // board opens a detail panel from ?task=, and Inbox / Drafts each open
  // and highlight the one message or draft from ?open=. The rest land on
  // the screen that holds them.
  if (item.kind === 'project') return `/projects/${id}`;
  if (item.kind === 'task') return `/tasks?task=${id}`;
  if (item.kind === 'email') return `/inbox?open=${id}`;
  if (item.kind === 'draft') return `/drafts?open=${id}`;
  return base;
}

// ── AI configuration ────────────────────────────────────────

export const DEFAULT_MODEL = 'claude-opus-5';

export interface SelectableModel {
  id: string;
  label: string;
  /** Why a studio would pick this one. */
  note: string;
}

/**
 * The models a studio may choose between, most capable first. Deliberately
 * short: every extra option is a decision someone has to make, and the
 * three here span the real trade-off — quality, speed, cost.
 */
export const SELECTABLE_MODELS: SelectableModel[] = [
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    note: 'Most capable. Best at reading messy email and getting the details right.',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    note: 'Noticeably cheaper and quicker. A good default once the studio is busy.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    note: 'Cheapest and fastest. Fine for simple extraction, weaker on judgement.',
  },
];

/** What the studio's AI settings look like to the app. Never the key itself. */
export interface AiSettingsView {
  /** True once a key is stored, whether in the database or the environment. */
  configured: boolean;
  /** Where the key came from — the studio cannot edit an environment key. */
  source: 'studio' | 'environment' | 'none';
  /** Last four characters, so a person can tell which key is in use. */
  keyHint: string | null;
  model: string;
  /** True when the model is the built-in default rather than a choice. */
  modelIsDefault: boolean;
}

// ── Reading email ───────────────────────────────────────────

/**
 * How often the system goes looking for new mail.
 *
 * Every new email costs a Claude call to classify, another to decide
 * whether it raises a task, and sometimes a third to draft a reply — so
 * how often the studio looks, and whether it thinks about what it finds,
 * are the two dials that actually move the bill.
 */
export interface IngestInterval {
  minutes: number;
  label: string;
}

export const INGEST_INTERVALS: IngestInterval[] = [
  { minutes: 0, label: 'Only when I ask' },
  { minutes: 10, label: 'Every 10 minutes' },
  { minutes: 15, label: 'Every 15 minutes' },
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Every hour' },
];

/**
 * Ten minutes: email is not an emergency channel, and a quote that
 * arrives at 10:02 being noticed at 10:10 changes nothing about the day.
 */
export const DEFAULT_INGEST_MINUTES = 10;

/**
 * How often open tasks are put beside the mail since they were raised and
 * closed when it shows they are done. Only a task with mail it has not been
 * checked against costs a Claude call, so a quiet interval costs nothing.
 */
export const TASK_REVIEW_INTERVALS: IngestInterval[] = [
  { minutes: 0, label: 'Off' },
  { minutes: 15, label: 'Every 15 minutes' },
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 120, label: 'Every 2 hours' },
  { minutes: 240, label: 'Every 4 hours' },
  { minutes: 1440, label: 'Once a day' },
];

export const DEFAULT_TASK_REVIEW_MINUTES = 60;

export interface IngestSettingsView {
  intervalMinutes: number;
  /**
   * False fetches and files the mail without asking Claude to read it —
   * no classification, no tasks raised, no reply drafts. The Inbox still
   * fills up; nothing is spent on it.
   */
  useAi: boolean;
  intervals: IngestInterval[];
  /** How often finished tasks are looked for and closed; 0 = only on request. */
  taskReviewMinutes: number;
  taskReviewIntervals: IngestInterval[];
}

// ── Who does the work: choosing the AI behind each action ───────────

/**
 * The companies whose models can read mail, draft replies and write the
 * digest. Claude is the default and the only one the Assistant's tool loop
 * and PDF reading run on; the others take over the plain text-in, text-out
 * actions below.
 */
export type LlmProvider = 'anthropic' | 'openai' | 'gemini';

export const LLM_PROVIDERS: { id: LlmProvider; label: string }[] = [
  { id: 'anthropic', label: 'Claude' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' },
];

/**
 * The actions whose AI can be switched. Each reads text and answers in text
 * or JSON, which every provider can do. Left out on purpose, and always Claude:
 * the Assistant (a multi-step tool loop built on Claude's tool use and
 * caching), and anything that reads a PDF or a picture (Claude takes the file
 * itself; the others would need it converted first).
 */
export const SWITCHABLE_FEATURES: { id: AiFeature; label: string; note: string }[] = [
  { id: 'email.extract', label: 'Reading email', note: 'Classifies each email and pulls out the job, vendor and what is being asked. The biggest spender.' },
  { id: 'task.extract', label: 'Raising tasks', note: 'Turns an email into a task with an owner and a date.' },
  { id: 'followup.draft', label: 'Drafting follow-ups', note: 'Writes the chaser to a vendor or client.' },
  { id: 'reply.draft', label: 'Drafting replies', note: 'Writes a reply when someone asks for one.' },
  { id: 'digest.summary', label: 'Morning digest', note: 'Summarises the day for the studio.' },
  { id: 'report.narrative', label: 'Weekly report', note: 'Writes the weekly narrative.' },
  { id: 'prompt.run', label: 'Prompt Studio', note: 'Runs a saved prompt on request.' },
];

/** One action's choice. A price is only needed for a model the table below does not know. */
export interface LlmRoute {
  provider: LlmProvider;
  model: string;
  /** US dollars per million tokens; used to cost a model that is not in LLM_MODEL_PRESETS. */
  inputPer1M?: number;
  outputPer1M?: number;
}

/**
 * Models to offer, with the price the provider published when this was
 * written. Prices move: they are a starting point the studio can override
 * per action, and the usage report uses whatever is saved with the choice.
 * A model typed in by hand has no entry here and is costed at the price
 * entered beside it.
 */
export const LLM_MODEL_PRESETS: { provider: Exclude<LlmProvider, 'anthropic'>; id: string; label: string; inputPer1M: number; outputPer1M: number }[] = [
  { provider: 'openai', id: 'gpt-5-nano', label: 'GPT-5 nano — cheapest', inputPer1M: 0.05, outputPer1M: 0.4 },
  { provider: 'openai', id: 'gpt-4o-mini', label: 'GPT-4o mini — steady for extraction', inputPer1M: 0.15, outputPer1M: 0.6 },
  { provider: 'openai', id: 'gpt-5-mini', label: 'GPT-5 mini — more careful', inputPer1M: 0.25, outputPer1M: 2 },
  { provider: 'gemini', id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite — cheapest', inputPer1M: 0.25, outputPer1M: 1.5 },
  { provider: 'gemini', id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', inputPer1M: 0.3, outputPer1M: 2.5 },
  { provider: 'gemini', id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash — more careful', inputPer1M: 1.5, outputPer1M: 9 },
];

/** What Settings shows for one switchable action. */
export interface AiRoutingFeatureView {
  id: AiFeature;
  label: string;
  note: string;
  /** Null means the default: Claude, on the model chosen under "Jenny's brain". */
  route: LlmRoute | null;
}

export interface AiRoutingView {
  features: AiRoutingFeatureView[];
  providers: { id: LlmProvider; label: string; configured: boolean; keyHint: string | null }[];
  presets: typeof LLM_MODEL_PRESETS;
}

/** What a test run of one provider on a sample email sends back. */
export interface AiRoutingTestResult {
  ok: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** The fields that came back, so a person can judge whether it read the sample properly. */
  sample: Record<string, unknown> | null;
  error?: string;
}
