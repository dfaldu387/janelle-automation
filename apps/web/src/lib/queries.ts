import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiBlob, apiUpload, NetworkError } from './api';
import { readImpersonation } from './impersonate';
import { defaultTaskCategory, type TaskCategory } from '@janelle/shared';
import type {
  Action, AiRoutingTestResult, AiRoutingView, AiSettingsView, AiUsageReport, AssistantAnswer, DashboardSummary, IngestSettingsView,
  Prompt, ProjectStage, PoStatus,
  SelectableModel,
  FollowUpType, Resource, Seat, TaskKind, TaskStatus, UserRole,
} from '@janelle/shared';

// ── View models (what the UI renders) ───────────────────────
export interface ProjectView {
  id: string; name: string; client: string; stage: ProjectStage;
  /** The project's own budget figure; null when never set. */
  budget: number | null;
  install: string; openPOs: number;
  /** Total value of the project's purchase orders. */
  committed: number;
  specGaps: number;
  /** Closed work. Kept, but never mixed in with the live pipeline unasked. */
  archived: boolean;
}
export interface PoView {
  id: string; po: string; vendor: string; project: string;
  amount: number; status: PoStatus; eta: string;
  /** Who the order is with, for filtering by the selected vendor. '' when unlinked. */
  vendorId: string;
}
export interface FollowUpView {
  id: string; type: 'vendor_silence' | 'client_approval_overdue' | 'date_slipping' | 'spec_gap';
  who: string; project: string; reason: string; age: string;
  /** The address being nudged — a teammate's for the internal types. */
  target: string | null;
  /** Who owns the task this nudge is chasing, when it is chasing one. */
  taskAssignee: string | null;
  /** Who runs the job it concerns, when it names one. */
  projectOwner: string | null;
}
export interface VendorView {
  id: string; name: string; category: string;
  openPOs: number;
  /** Total value of those open orders. */
  openValue: number;
  /** The vendor's own site, normalized to a full URL; '' when unknown. */
  website: string;
  /** First contact address on file, for the directory subtitle; '' when none. */
  email: string;
}
export interface EmailView {
  id: string; from: string; subject: string; snippet: string;
  cls: string; project: string; when: string;
  /** Sender split out of the RFC header, so a table can show a name, not an address. */
  fromName: string; fromEmail: string;
  /** The vendor the mail was linked to; '' when none. */
  vendor: string;
  /** Design / FF&E / Procurement / Admin, from the task it raised; '' when unknown. */
  category: TaskCategory | '';
  /** Full ISO timestamp, for the exact date on hover. */
  receivedAt: string;
  /** Gmail's own message id — '' when this was raised by hand, with no mail behind it. */
  gmailId: string;
  /** Claude's one-line read of the message; '' when there is only the snippet. */
  summary: string;
}
export interface DocSource {
  kind: 'gmail' | 'drive';
  /** Display name of the sender (falls back to the address). */
  fromName: string;
  fromEmail: string;
  subject: string;
  /** ISO timestamp the email was received (null for Drive files). */
  sharedAt: string | null;
}
export interface DocView {
  id: string; type: string; vendor: string; project: string;
  total: number; confidence: number; when: string;
  /** Full ISO timestamp of the parse, for the exact date on hover. */
  createdAt: string;
  source: DocSource | null;
}
export interface ActivityView {
  id: string;
  action: string;
  entity: string | null;
  /** The raw meta, so the page can phrase it rather than dump key:value. */
  meta: Record<string, unknown> | null;
  /** Who did it — null means the system/automation. */
  actorId: string | null;
  actorName: string | null;
  /** ISO timestamp, for an exact time and tooltip. */
  at: string;
  /** A coarse "today / N days" age, kept for compatibility. */
  when: string;
}

export function ageFrom(iso: string | null): string {
  if (!iso) return '—';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
  return days <= 0 ? 'today' : `${days} day${days > 1 ? 's' : ''}`;
}

// ── Health & profile ────────────────────────────────────────
export interface Health {
  integrations: { supabase: string; google: string; anthropic: string };
}
export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: () => api<Health>('/health') });
}

export type GoogleService = 'gmail' | 'drive';
export interface Me {
  profile: { full_name: string | null; role: string } | null;
  google: {
    status: string;
    connected_at?: string | null;
    scopes?: string;
    services: Record<GoogleService, boolean>;
    /** Google refused the connected grant — set to its reason; null when fine. */
    needs_reconnect?: string | null;
  };
}
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
}

// ── Dashboard ───────────────────────────────────────────────
export type Summary = DashboardSummary;

/** Every card at zero, so the page renders before the first response. */
const ZERO_SUMMARY: DashboardSummary = {
  role: null,
  focus: '',
  cards: [],
  figures: {
    myOpenTasks: 0, myOverdueTasks: 0, unassignedTasks: 0, tasksWithoutNextStep: 0,
    openFollowUps: 0, awaitingClient: 0, draftsPending: 0, specGaps: 0, openPOs: 0,
    activeProjects: 0, installsSoon: 0, emailsRead: 0, documentsParsed: 0, escalations: 0,
  },
  byStage: {},
  vacantSeats: [],
};
export function useDashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardSummary>('/dashboard/summary') });
  return { ...q, data: q.data ?? ZERO_SUMMARY };
}

// ── Projects ────────────────────────────────────────────────
interface ProjectRow {
  id: string; name: string; client_name: string | null; stage: ProjectStage;
  status: string;
  budget: number | null; target_install: string | null;
  open_pos: number; po_total: number; spec_gaps: number;
}
export function useProjects() {
  const q = useQuery({
    queryKey: ['projects'],
    queryFn: async (): Promise<ProjectView[]> => {
      const rows = await api<ProjectRow[]>('/projects');
      return rows.map((r) => ({
        id: r.id, name: r.name, client: r.client_name ?? '—', stage: r.stage,
        budget: r.budget, install: r.target_install ?? '',
        openPOs: r.open_pos ?? 0, committed: r.po_total ?? 0, specGaps: r.spec_gaps ?? 0,
        archived: r.status === 'archived',
      }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

export interface ProjectDetail {
  project: {
    id: string; name: string; client_name: string | null; stage: ProjectStage;
    status: string; budget: number | null; target_install: string | null; notes: string | null;
    /** Town and state, as the studio's project sheet writes it. */
    location: string | null;
    /** 'Open' or 'In Progress' from that sheet; null for a project not on it. */
    sheet_status: string | null;
  };
  purchase_orders: {
    id: string; po_number: string | null; amount: number | null; status: string; eta: string | null;
    vendors: { name: string } | null;
    line_items: { id: string }[] | null;
  }[];
  spec_gaps: { id: string; item: string; missing_fields: string[] }[];
  emails: { id: string; subject: string | null; class: string; received_at: string | null; from_addr: string | null }[];
  documents: { id: string; type: string; parsed_json: { vendor?: string; total?: number } | null; created_at: string }[];
}
export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ['project', id],
    queryFn: () => api<ProjectDetail>(`/projects/${id}`),
    enabled: !!id,
  });
}

// ── Vendors ─────────────────────────────────────────────────
interface VendorRow {
  id: string; name: string; category: string | null; website?: string | null;
  contacts?: { name?: string; email?: string; phone?: string }[] | null;
  open_pos?: number; open_value?: number;
}
export function useVendors() {
  const q = useQuery({
    queryKey: ['vendors'],
    queryFn: async (): Promise<VendorView[]> => {
      const rows = await api<VendorRow[]>('/vendors');
      return rows.map((r) => ({
        id: r.id, name: r.name,
        // '' not '—' now: the row decides whether there is anything to show,
        // and an em dash on its own line was most of what the list displayed.
        category: r.category ?? '',
        openPOs: r.open_pos ?? 0,
        openValue: r.open_value ?? 0,
        website: r.website ?? '',
        email: (r.contacts ?? []).find((c) => c.email)?.email ?? '',
      }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

/** What the signed-in role may do to the vendor directory. */
export function useVendorAbilities() {
  return useQuery({
    queryKey: ['vendors', 'can'],
    queryFn: () => api<{ create: boolean; update: boolean; delete: boolean }>('/vendors/can'),
    staleTime: 60_000,
  });
}

export interface NewVendor {
  name: string; website: string; email: string; phone: string;
  contact_name: string; category: string; notes: string;
}
export function useCreateVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: NewVendor) => api<VendorRow>('/vendors', { method: 'POST', body: JSON.stringify(v) }),
    // The dashboard counts vendors too, so it goes stale on the same event.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vendors'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ── Purchase orders ─────────────────────────────────────────
interface PoRow {
  id: string; po_number: string | null; amount: number | null; status: PoStatus;
  eta: string | null; vendor_id: string | null;
  vendors: { name: string } | null; projects: { name: string } | null;
}
export function usePurchaseOrders() {
  const q = useQuery({
    queryKey: ['purchase-orders'],
    queryFn: async (): Promise<PoView[]> => {
      const rows = await api<PoRow[]>('/purchase-orders');
      return rows.map((r) => ({
        id: r.id, po: r.po_number ?? '', vendor: r.vendors?.name ?? '',
        project: r.projects?.name ?? '', amount: r.amount ?? 0, status: r.status, eta: r.eta ?? '',
        vendorId: r.vendor_id ?? '',
      }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

// ── Follow-ups ──────────────────────────────────────────────
interface FollowUpRow {
  id: string; type: FollowUpView['type']; reason: string | null; created_at: string;
  target: string | null; vendors: { name: string } | null;
  task_id: string | null; tasks: { assigned_to: string | null } | null;
  projects: { name: string; assigned_to?: string | null } | null;
}
export function useFollowUps() {
  const q = useQuery({
    queryKey: ['follow-ups'],
    queryFn: async (): Promise<FollowUpView[]> => {
      const rows = await api<FollowUpRow[]>('/follow-ups');
      return rows.map((r) => ({
        id: r.id, type: r.type,
        who: r.vendors?.name ?? r.projects?.name ?? r.target ?? '—',
        project: r.projects?.name ?? '—', reason: r.reason ?? '', age: ageFrom(r.created_at),
        target: r.target, taskAssignee: r.tasks?.assigned_to ?? null,
        projectOwner: r.projects?.assigned_to ?? null,
      }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

// ── Tasks ───────────────────────────────────────────────────
export interface TaskView {
  id: string; title: string; detail: string; kind: TaskKind; status: TaskStatus;
  assignedTo: string | null; assignee: string; project: string; due: string | null;
  age: string;
  /** Design, FF&E, Procurement or Admin — the stored one, else worked out from seat and kind. */
  category: TaskCategory;
  /** The single concrete action. The studio's SOP fails a task without one. */
  nextStep: string | null;
  seat: Seat | null;
  /** Past its due date and still live — the board tints these. */
  overdue: boolean;
  /**
   * Whether an email raised this task. Every task on the board should have
   * one — they are read out of the studio's mail — so a card without it was
   * added by hand and is worth being able to tell apart.
   */
  fromEmail: boolean;
  /** When it moved to Done; null while it is still live. */
  completedAt: string | null;
  /** Set when the system closed it from an email: which one, and the words that finished it. */
  closedNote: string | null;
  /** Days between finishing and the due date — positive is early, negative late. */
  daysEarly: number | null;
  /**
   * When the CURRENT owner got it — migration 0016, null before it applies.
   * Not created_at: a task handed to someone else is new to them, whatever
   * the day it was raised.
   */
  assignedAt: string | null;
  /** When the task was raised — what "added in the last 3 days" reads. */
  createdAt: string;
}
interface TaskRow {
  id: string; title: string; detail: string | null; kind: TaskKind; status: TaskStatus;
  assigned_to: string | null; due_date: string | null; created_at: string;
  updated_at?: string | null;
  /** Migration 0015; absent before it is applied. */
  completed_at?: string | null; completion_note?: string | null;
  /** Migration 0016; absent before it is applied. */
  assigned_at?: string | null;
  source_email_id?: string | null;
  next_step?: string | null; seat?: Seat | null;
  /** Migration 0026; absent before it is applied. */
  category?: TaskCategory | null;
  projects: { name: string } | null; vendors: { name: string } | null;
  profiles: { full_name: string | null } | null;
}

/**
 * Whole days from when a task was finished to when it was due. The finish
 * is a moment, the due date a calendar day, so the moment is read as the
 * day it fell on here rather than in UTC — an evening close in California
 * is already tomorrow in UTC.
 */
export function daysEarly(due: string | null, completedAt: string | null): number | null {
  if (!due || !completedAt) return null;
  const done = new Date(completedAt);
  const [y, m, d] = due.split('-').map(Number);
  if (Number.isNaN(done.getTime()) || !y || !m || !d) return null;
  const doneDay = Date.UTC(done.getFullYear(), done.getMonth(), done.getDate());
  return Math.round((Date.UTC(y, m - 1, d) - doneDay) / 86_400_000);
}
export function useTasks() {
  const q = useQuery({
    queryKey: ['tasks'],
    queryFn: async (): Promise<TaskView[]> => {
      const rows = await api<TaskRow[]>('/tasks');
      return rows.map((r) => {
        // Before migration 0015 there is no completed_at; a finished task's
        // last change is the closest record of when it was finished.
        const completedAt = r.status === 'done' ? r.completed_at ?? r.updated_at ?? null : null;
        return {
          id: r.id, title: r.title, detail: r.detail ?? '', kind: r.kind, status: r.status,
          assignedTo: r.assigned_to,
          assignee: r.profiles?.full_name ?? (r.assigned_to ? 'Assigned' : 'Unassigned'),
          project: r.projects?.name ?? r.vendors?.name ?? '—',
          due: r.due_date, age: ageFrom(r.created_at),
          nextStep: r.next_step ?? null,
          seat: r.seat ?? null,
          category: r.category ?? defaultTaskCategory(r.kind, r.seat),
          overdue:
            !!r.due_date &&
            r.due_date < new Date().toISOString().slice(0, 10) &&
            !['done', 'cancelled'].includes(r.status),
          fromEmail: Boolean(r.source_email_id),
          completedAt,
          closedNote: r.status === 'done' ? r.completion_note ?? null : null,
          daysEarly: daysEarly(r.due_date, completedAt),
          assignedAt: r.assigned_at ?? null,
          createdAt: r.created_at,
        };
      });
    },
  });
  return { ...q, data: q.data ?? [] };
}

export interface TeamMember {
  id: string; full_name: string | null; email: string | null; role: UserRole;
  /** The named seat from the roles document, where one is assigned. */
  seat?: Seat | null;
  created_at?: string; live_tasks?: number; is_you?: boolean;
  /** Their account is switched off: they cannot sign in until re-enabled. */
  disabled?: boolean;
  /** Whether their Google is connected — until it is, none of their mail is read. */
  google?: {
    connected: boolean; gmail: boolean; drive: boolean; connected_at: string | null;
    /** Set when Google has refused the stored access since they connected — only they can fix it. */
    needs_reconnect?: string | null;
  };
}
export function useTeam() {
  const q = useQuery({ queryKey: ['team'], queryFn: () => api<TeamMember[]>('/team') });
  return { ...q, data: q.data ?? [] };
}

/**
 * Change someone's role or their seat. Principal only; the API enforces it.
 *
 * The role is what the software lets them touch; the seat is the outcome the
 * roles document holds them to, and it is what routes work. Either can be
 * sent on its own — `seat: null` takes the seat away.
 */
export function useSetRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; role?: UserRole; seat?: Seat | null }) => {
      const body: Record<string, unknown> = {};
      if (v.role !== undefined) body.role = v.role;
      if (v.seat !== undefined) body.seat = v.seat;
      return api(`/team/${v.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

/** What the signed-in person may do on Team & roles, per the permission matrix. */
export function useTeamAbilities() {
  return useQuery({
    queryKey: ['team', 'can'],
    queryFn: () => api<{ create: boolean; update: boolean; delete: boolean; impersonate?: boolean }>('/team/can'),
    staleTime: 60_000,
  });
}

/** Change someone's name or sign-in email. No email is sent to them either way. */
export function useEditTeamMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; full_name?: string; email?: string }) =>
      api(`/team/${v.id}`, { method: 'PATCH', body: JSON.stringify({ full_name: v.full_name, email: v.email }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team'] });
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

/** Remove someone from the studio. Their open tasks stay on the board, unassigned. */
export function useRemoveTeamMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ id: string; unassigned_tasks: number }>(`/team/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export interface NewTeamMember {
  email: string; full_name: string; role: UserRole;
  /** True sends them a sign-in email; false just creates the account. */
  invite: boolean;
}
/** What an invite came back with — see the /team/invite route. */
export interface AddedMember {
  id: string;
  email: string;
  role: string;
  /** False when the welcome email could not be sent; the password then matters. */
  emailed?: boolean;
  mailError?: string | null;
  /** The generated password. Shown once so it can be handed over by hand. */
  password?: string;
}
export function useAddTeamMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: NewTeamMember) =>
      api<AddedMember>(v.invite ? '/team/invite' : '/team', {
        method: 'POST',
        body: JSON.stringify({ email: v.email, full_name: v.full_name, role: v.role }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team'] }),
  });
}

/**
 * Send an existing teammate their sign-in details again.
 *
 * Sets a NEW password — an old one cannot be read back by anyone — so the
 * screen warns before calling this.
 */
export function useSendInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<AddedMember>(`/team/${id}/invite`, { method: 'POST', body: '{}' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team'] }),
  });
}

export interface PasswordReset {
  id: string;
  email: string | null;
  emailed: boolean;
  mailError: string | null;
  /** The generated password, shown once; null when the admin typed it. */
  password: string | null;
}

/** Set a teammate's password — typed, or generated when `password` is left out. */
export function useResetMemberPassword() {
  return useMutation({
    mutationFn: (v: { id: string; password?: string; notify: boolean }) =>
      api<PasswordReset>(`/team/${v.id}/password`, {
        method: 'POST',
        body: JSON.stringify({ password: v.password || undefined, notify: v.notify }),
      }),
  });
}

/** Disable or re-enable a teammate's account. */
export function useSetMemberDisabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; disabled: boolean }) =>
      api<{ id: string; disabled: boolean }>(`/team/${v.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ disabled: v.disabled }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team'] }),
  });
}

// ── Morning digest ──────────────────────────────────────────
export interface DigestRow {
  id: string; title: string; kind: TaskKind; status: string;
  owner: string; project: string; age_days: number; due_date: string | null;
}
export interface Digest {
  id: string;
  digest_date: string;
  narrative: string | null;
  escalations: DigestRow[];
  figures: {
    open_tasks: number;
    overdue: DigestRow[];
    unassigned: DigestRow[];
    quote_breaches: DigestRow[];
    client_waiting: DigestRow[];
    by_owner: Record<string, number>;
  } | null;
}
export function useLatestDigest() {
  return useQuery({ queryKey: ['digest'], queryFn: () => api<Digest | null>('/digests/latest') });
}

export function useRunDigest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/digests/run', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['digest'] }),
  });
}

// ── Assistant ───────────────────────────────────────────────
export interface ProposedAction {
  tool: string;
  summary: string;
  input: Record<string, unknown>;
}
export interface AssistantReply {
  /** The answer as one block of text — what the history keeps. */
  reply: string;
  /** The same answer, laid out: a lead, the rows behind it, what was checked. */
  answer: AssistantAnswer;
  proposed: ProposedAction[];
  used: string[];
  /**
   * Earlier proposals the person answered in words — "yes", "cancel that" —
   * keyed as the browser sent them, so their buttons can be settled too.
   */
  settled?: { key: string; decision: 'confirmed' | 'cancelled'; id?: string | null; kind?: 'task' | 'draft' | 'task_update' }[];
  /**
   * Clips this question set off, which are still rendering.
   *
   * The answer is written and sent while the provider is still drawing, so
   * these ids are how the screen knows there is something to wait for.
   */
  startedJobs?: string[];
}

/** What a confirmed proposal became. */
export type SavedProposal =
  | { kind: 'task'; id: string; title: string; assignee: string | null; project: string | null; due_date: string | null; duplicate: boolean }
  | { kind: 'draft'; id: string; subject: string; to: string | null }
  | { kind: 'task_update'; id: string; title: string; assignee: string | null; due_date: string | null; status: string };

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

// ── The end-of-day check-in ─────────────────────────────────

export type CheckinOutcome = 'done' | 'blocked' | 'tomorrow';

export interface CheckinTask {
  id: string;
  title: string;
  project: string | null;
  due: string | null;
  status: string;
  bucket: 'open' | 'blocked' | 'done' | 'tomorrow';
  /** The last "Blocked: …" note, for a task that already is. */
  note: string | null;
  /** What the person answered in this check-in, kept with the message. */
  outcome?: CheckinOutcome | null;
  outcomeNote?: string | null;
}

export interface CheckinView {
  answer: AssistantAnswer;
  tasks: CheckinTask[];
}

export interface CheckinSaved {
  id: string;
  title: string;
  outcome: CheckinOutcome;
  status: string;
  due_date: string | null;
}

/** One answer in the check-in: Done, Blocked (and why) or Tomorrow. */
export function useRecordCheckin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { task_id: string; outcome: CheckinOutcome; note?: string | null }) =>
      api<CheckinSaved>('/assistant/checkin', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['task'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/** Commit a proposal the person confirmed. Separate from asking, on purpose. */
export function useConfirmAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { tool: string; input: Record<string, unknown> }) =>
      api<SavedProposal>('/assistant/confirm', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: (_data, v) => {
      if (v.tool === 'propose_draft') qc.invalidateQueries({ queryKey: ['drafts'] });
      else if (v.tool === 'propose_task_update') {
        qc.invalidateQueries({ queryKey: ['tasks'] });
        qc.invalidateQueries({ queryKey: ['task'] });
      }
      else qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ── Inbox / documents / activity ────────────────────────────
interface EmailRow {
  id: string; from_addr: string | null; subject: string | null; snippet: string | null;
  received_at: string | null; class: string; gmail_id: string | null;
  extracted_json: { summary?: string } | null;
  projects: { name: string } | null; vendors: { name: string } | null;
  tasks?: { category: TaskCategory | null; kind: TaskKind; seat: string | null }[] | null;
}

/**
 * Which part of the studio an email belongs to. The task it raised says so
 * (its own category, or the one its kind and seat imply); mail that raised no
 * task falls back on what it is — a quote is FF&E, an order confirmation is
 * procurement, an approval is design. '' when nothing says.
 */
const CLASS_CATEGORY: Record<string, TaskCategory> = {
  vendor_quote: 'ffe',
  order_confirmation: 'procurement',
  client_approval: 'design',
};
function emailCategory(r: EmailRow): TaskCategory | '' {
  const t = r.tasks?.[0];
  if (t) return t.category ?? defaultTaskCategory(t.kind, t.seat);
  return CLASS_CATEGORY[r.class] ?? '';
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', trade: '™', reg: '®', copy: '©',
};

/**
 * Gmail hands us HTML-escaped snippets, which were being rendered verbatim —
 * "I&#39;d love for you to quote" is what the Inbox actually showed. Decoded
 * by lookup rather than the usual innerHTML round-trip, which would parse
 * untrusted mail as markup just to unescape it.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function mapEmailRow(r: EmailRow): EmailView {
  const who = parseAddress(r.from_addr);
  return {
    id: r.id, from: r.from_addr ?? '', subject: decodeEntities(r.subject ?? '(no subject)'),
    snippet: decodeEntities(r.snippet ?? ''), cls: r.class,
    // '' not '—' — the table hides a column nothing fills rather than
    // printing a dash down every row of it.
    project: r.projects?.name ?? '', vendor: r.vendors?.name ?? '',
    category: emailCategory(r),
    fromName: who.name, fromEmail: who.email,
    receivedAt: r.received_at ?? '',
    when: r.received_at ? ageFrom(r.received_at) : '—',
    gmailId: r.gmail_id ?? '',
    summary: decodeEntities(r.extracted_json?.summary ?? ''),
  };
}

export function useEmails() {
  const q = useQuery({
    queryKey: ['emails'],
    queryFn: async (): Promise<EmailView[]> => {
      const rows = await api<EmailRow[]>('/emails');
      return rows.map(mapEmailRow);
    },
  });
  return { ...q, data: q.data ?? [] };
}

/**
 * One email by id, however old — for a deep link (e.g. a task's "Open in
 * Inbox") to a message that has since aged out of `useEmails`' list.
 */
export function useEmail(id: string | null) {
  return useQuery({
    queryKey: ['email', id],
    queryFn: async (): Promise<EmailView> => mapEmailRow(await api<EmailRow>(`/emails/${id}`)),
    enabled: !!id,
  });
}

/**
 * Where a message opens in the connected mailbox — never a fabricated compose.
 *
 * Targets the account by address (`?authuser=`) when the studio's Gmail is
 * known, so it opens the right account whatever its index is in the viewer's
 * Chrome profile. Falls back to the first account only when the address is
 * unknown.
 */
export function gmailMessageUrl(gmailId: string, mailboxEmail?: string | null): string {
  const base = 'https://mail.google.com/mail/';
  return mailboxEmail
    ? `${base}?authuser=${encodeURIComponent(mailboxEmail)}#all/${gmailId}`
    : `${base}u/0/#all/${gmailId}`;
}

interface DocRow {
  id: string; type: string; confidence: number | null; created_at: string;
  parsed_json: { vendor?: string; total?: number } | null; projects: { name: string } | null;
  source: { kind: 'gmail' | 'drive'; from: string | null; subject: string | null; shared_at: string | null } | null;
}

/** Split an RFC "Name <addr>" header into its parts. */
export function parseAddress(raw: string | null | undefined): { name: string; email: string } {
  const s = (raw ?? '').trim();
  const m = s.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim() };
  return { name: s, email: s };
}

function toDocSource(src: DocRow['source']): DocSource | null {
  if (!src) return null;
  const { name, email } = parseAddress(src.from);
  return { kind: src.kind, fromName: name, fromEmail: email, subject: src.subject ?? '', sharedAt: src.shared_at };
}
export function useDocuments() {
  const q = useQuery({
    queryKey: ['documents'],
    queryFn: async (): Promise<DocView[]> => {
      const rows = await api<DocRow[]>('/documents');
      return rows.map((r) => ({
        id: r.id, type: r.type,
        // '' not '—' — the table hides a column nothing fills rather than
        // printing a dash down every row of it.
        vendor: r.parsed_json?.vendor ?? '',
        project: r.projects?.name ?? '', total: r.parsed_json?.total ?? 0,
        confidence: r.confidence ?? 0, when: ageFrom(r.created_at),
        createdAt: r.created_at ?? '',
        source: toDocSource(r.source),
      }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

interface ActivityRow {
  id: string;
  action: string;
  entity: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  actor: string | null;
  profiles: { full_name: string | null } | null;
}

/** Narrow the trail: everyone, just people, just the system, or one person. */
export type ActivityFilters = { scope?: 'all' | 'people' | 'system'; actor?: string | null };

/**
 * The audit trail, with the raw meta kept so the page can phrase each row,
 * and the actor resolved to a name (null = the system/automation did it).
 */
export function useActivity(filters: ActivityFilters = {}) {
  const scope = filters.actor ? 'all' : filters.scope ?? 'all';
  const q = useQuery({
    queryKey: ['activity', scope, filters.actor ?? null],
    queryFn: async (): Promise<ActivityView[]> => {
      const params = new URLSearchParams();
      if (filters.actor) params.set('actor', filters.actor);
      else if (scope !== 'all') params.set('scope', scope);
      const qs = params.toString();
      const rows = await api<ActivityRow[]>(`/activity${qs ? `?${qs}` : ''}`);
      return rows.map((r) => ({
        id: r.id,
        action: r.action,
        entity: r.entity,
        meta: r.meta ?? null,
        actorId: r.actor,
        actorName: r.profiles?.full_name ?? null,
        at: r.created_at,
        when: ageFrom(r.created_at),
      }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

// ── Prompt library ──────────────────────────────────────────
export function usePromptLibrary() {
  const q = useQuery({ queryKey: ['prompts'], queryFn: () => api<Prompt[]>('/prompts') });
  return { ...q, data: q.data ?? [] };
}

/** A reference picture on its way to a render: uploaded, and named. */
export interface BoardReference {
  token: string;
  name: string;
  label: string;
  mimeType: string;
  /** A local object URL for the thumbnail; revoked when the modal closes. */
  preview: string;
}

export interface RenderedBoard {
  token: string;
  name: string;
  mimeType: string;
  model: string;
  note: string | null;
  references: number;
}

/**
 * Which prompts make a picture, what to attach to each, and whether the
 * studio has an image key at all. Asked once: the answer changes only when
 * someone edits Settings.
 */
export function useRenderable() {
  return useQuery({
    queryKey: ['prompts', 'renderable'],
    queryFn: () =>
      api<{ ready: boolean; prompts: Record<string, { label: string; references: string[] }> }>(
        '/prompts/renderable',
      ),
    staleTime: 60_000,
  });
}

/** Put a reference image in the studio's bucket and get a grant for it back. */
export async function uploadReference(file: File, label: string): Promise<BoardReference> {
  const stored = await apiUpload<{ token: string; name: string; mimeType: string }>(
    `/assistant/upload?name=${encodeURIComponent(file.name)}`,
    file,
  );
  return { ...stored, label, preview: URL.createObjectURL(file) };
}

export function useRenderBoard() {
  return useMutation({
    mutationFn: (v: {
      id: string;
      variables: Record<string, string>;
      files: { token: string; label: string }[];
      projectId?: string;
    }) =>
      api<RenderedBoard>(`/prompts/${v.id}/render`, {
        method: 'POST',
        body: JSON.stringify({ variables: v.variables, files: v.files, projectId: v.projectId }),
      }),
  });
}

/** The rendered board's bytes, as something an <img> can show. */
export function boardImageUrl(token: string): Promise<string> {
  return apiBlob(`/assistant/file?token=${encodeURIComponent(token)}`).then((b) => URL.createObjectURL(b));
}

// ── Reports ─────────────────────────────────────────────────
export interface ReportRow {
  id: string; week_of: string; narrative: string | null;
  generated_json: Record<string, unknown> | null;
  created_at: string | null;
}
export function useReports() {
  return useQuery({ queryKey: ['reports'], queryFn: () => api<ReportRow[]>('/reports') });
}

// ── Mutations ───────────────────────────────────────────────
export function useRunPrompt() {
  return useMutation({
    mutationFn: (vars: { id: string; variables: Record<string, string>; projectId?: string }) =>
      api<{ output: string }>(`/prompts/${vars.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ variables: vars.variables, projectId: vars.projectId }),
      }),
  });
}

/** One /ops/ingest response: a single time-budgeted pass. */
export interface IngestPass {
  ok?: boolean;
  reason?: string;
  emails: number;
  documents: number;
  replies: number;
  tasks?: number;
  /** False when the pass stopped on its time budget with work left. */
  done?: boolean;
  remaining?: number;
}

/** The whole run: every pass summed, plus how the last one ended. */
export interface IngestRun extends IngestPass {
  tasks: number;
  rounds: number;
  /** Set when the run stopped on a dropped connection rather than finishing. */
  interrupted?: string;
}

export interface IngestProgress {
  emails: number;
  documents: number;
  replies: number;
  tasks: number;
  round: number;
}

/**
 * How many passes one click may chain. Reading a message costs up to three
 * Claude calls, so a full inbox batch outlives any single invocation. The
 * cap stops a very large backlog from holding the button forever — what is
 * left is picked up by the next click or the scheduled run.
 *
 * Rounds are deliberately short (the API's budget, ~20s) rather than few:
 * a request held open for most of a minute is the one that gets dropped in
 * transit, and a dropped round used to lose the whole run.
 */
const INGEST_MAX_ROUNDS = 12;

/** How many times a round that never reached the server is re-sent. */
const INGEST_RETRIES = 2;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One pass, re-sent if the connection dropped.
 *
 * Only NetworkError is retried. It means no answer came back, so the pass
 * either never ran or ran and its result was lost — and either way asking
 * again is safe: ingestion dedupes on what it already stored. An error the
 * server actually returned (not authorised, not configured) is reported.
 */
async function ingestPass(): Promise<IngestPass> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<IngestPass>('/ops/ingest', { method: 'POST', body: '{}' });
    } catch (err) {
      if (!(err instanceof NetworkError) || attempt >= INGEST_RETRIES) throw err;
      await wait(1000 * (attempt + 1));
    }
  }
}

export function useOps() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['follow-ups'] });
    qc.invalidateQueries({ queryKey: ['reports'] });
    qc.invalidateQueries({ queryKey: ['emails'] });
    qc.invalidateQueries({ queryKey: ['documents'] });
    qc.invalidateQueries({ queryKey: ['activity'] });
  };
  const ingest = useMutation({
    // Each POST reads to a short time budget and reports `done: false` with
    // what it left behind, so keep asking until the queue is clear. Totals
    // are summed across the rounds; the last response is kept for ok/reason.
    mutationFn: async (onProgress?: (p: IngestProgress) => void): Promise<IngestRun> => {
      const total = { emails: 0, documents: 0, replies: 0, tasks: 0 };
      let last: IngestRun = { ...total, done: true, rounds: 0 };

      for (let round = 1; round <= INGEST_MAX_ROUNDS; round++) {
        let r: IngestPass;
        try {
          r = await ingestPass();
        } catch (err) {
          // Every round before this one committed its work server-side, so
          // report what got read and let them carry on — throwing here would
          // show "Failed to fetch" over a run that mostly succeeded.
          if (round === 1) throw err;
          return { ...last, done: false, interrupted: (err as Error).message, rounds: round - 1 };
        }

        // Nothing ran — already busy, or Google/Claude not connected.
        if (r.ok === false) return { ...r, ...total, rounds: round };

        total.emails += r.emails ?? 0;
        total.documents += r.documents ?? 0;
        total.replies += r.replies ?? 0;
        total.tasks += r.tasks ?? 0;
        last = { ...r, ...total, rounds: round };
        onProgress?.({ ...total, round });

        if (r.done !== false) break;
        // Show what has landed without competing with the next round for
        // connections — the full refresh happens once the run finishes.
        qc.invalidateQueries({ queryKey: ['dashboard'] });
      }
      return last;
    },
    onSuccess: invalidate,
  });
  const followUps = useMutation({
    mutationFn: () => api<{ raised: number; drafted: number }>('/follow-ups/run', { method: 'POST', body: '{}' }),
    onSuccess: invalidate,
  });
  const report = useMutation({
    mutationFn: () => api<{ weekOf: string }>('/reports/generate', { method: 'POST', body: '{}' }),
    onSuccess: invalidate,
  });
  return { ingest, followUps, report };
}

// ── Syncing one's own mailbox for a period ──────────────────

/** One /settings/mail-sync response: a single time-budgeted pass. */
interface MailSyncPass extends IngestPass {
  skipped?: number;
  /** Everything in the window before this moment is dealt with. */
  resumeFrom?: string;
}

export interface MailSyncProgress {
  /** 1-based: which day of the range is being read. */
  day: number;
  days: number;
  /** The day being read, as a local date. */
  current: Date;
  emails: number;
  documents: number;
  tasks: number;
  replies: number;
  skipped: number;
}

export interface MailSyncResult extends Omit<MailSyncProgress, 'day' | 'current'> {
  /** False when stopped by the person, or a day could not be finished. */
  complete: boolean;
  stopped: boolean;
  /** Days whose mail could not all be read this time. */
  unfinishedDays: number;
}

/** Why a pass did not run, in words somebody can act on. */
const SYNC_REASONS: Record<string, string> = {
  anthropic_not_configured:
    'Claude is not set up yet, so email cannot be read. Ask a principal to add the key under Settings → AI & media.',
  google_auth_failed: 'Google needs reconnecting — use Connect above, then sync again.',
  mailbox_failed: 'Your mailbox could not be read just now. Try again in a minute.',
  no_source_user: 'Connect Gmail above before syncing your email.',
  supabase_not_configured: 'The server is not configured to store email.',
};

/**
 * Local midnights between two moments: the range cut into calendar days.
 *
 * One day per run of passes keeps each Gmail listing small — a listing is
 * capped at 500 messages, and a month of a busy mailbox is well past that —
 * and gives the progress line something a person understands.
 */
export function syncDays(since: Date, until: Date): { since: Date; until: Date }[] {
  const days: { since: Date; until: Date }[] = [];
  let start = new Date(since);
  while (start < until) {
    const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    const end = next < until ? next : until;
    days.push({ since: start, until: end });
    start = end;
  }
  return days;
}

/** Most passes one day may take before it is reported as unfinished. */
const SYNC_MAX_ROUNDS_PER_DAY = 40;
/** How often to ask again while another reading pass holds the lock. */
const SYNC_BUSY_RETRIES = 8;

async function mailSyncPass(since: Date, until: Date): Promise<MailSyncPass> {
  const body = JSON.stringify({ since: since.toISOString(), until: until.toISOString() });
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<MailSyncPass>('/settings/mail-sync', { method: 'POST', body });
    } catch (err) {
      // No answer came back: asking again is safe, stored mail is skipped.
      if (!(err instanceof NetworkError) || attempt >= INGEST_RETRIES) throw err;
      await wait(1000 * (attempt + 1));
    }
  }
}

/**
 * Read the signed-in person's own Gmail for a period, day by day, newest
 * day first, until each day is done. `shouldStop` is checked between passes
 * so Stop never cuts a pass off half way.
 */
export function useMailSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      since: Date;
      until: Date;
      onProgress?: (p: MailSyncProgress) => void;
      shouldStop?: () => boolean;
    }): Promise<MailSyncResult> => {
      const days = syncDays(vars.since, vars.until).reverse();
      const total = { emails: 0, documents: 0, tasks: 0, replies: 0, skipped: 0 };
      let unfinishedDays = 0;

      for (const [index, day] of days.entries()) {
        let from = day.since;
        let finished = false;
        let busy = 0;

        for (let round = 0; round < SYNC_MAX_ROUNDS_PER_DAY; round++) {
          if (vars.shouldStop?.()) {
            return { ...total, days: days.length, complete: false, stopped: true, unfinishedDays };
          }
          vars.onProgress?.({ ...total, day: index + 1, days: days.length, current: day.since });

          const r = await mailSyncPass(from, day.until);
          if (r.ok === false) {
            if (r.reason === 'busy' && busy < SYNC_BUSY_RETRIES) {
              // The scheduled reading is running; it finishes in seconds.
              busy++;
              round--;
              await wait(4000);
              continue;
            }
            throw new Error(
              r.reason === 'busy'
                ? 'Email is already being read — try again in a minute.'
                : SYNC_REASONS[r.reason ?? ''] ?? `Sync stopped (${r.reason ?? 'unknown reason'}).`,
            );
          }

          total.emails += r.emails ?? 0;
          total.documents += r.documents ?? 0;
          total.tasks += r.tasks ?? 0;
          total.replies += r.replies ?? 0;
          total.skipped += r.skipped ?? 0;

          if (r.done !== false) {
            finished = true;
            break;
          }
          // Start the next pass where this one got to, less a second: Gmail
          // counts in whole seconds and re-reading one is free.
          if (r.resumeFrom) {
            const at = new Date(Date.parse(r.resumeFrom) - 1000);
            if (at > from && at < day.until) from = at;
          }
          qc.invalidateQueries({ queryKey: ['emails'] });
        }
        if (!finished) unfinishedDays++;
      }

      return { ...total, days: days.length, complete: unfinishedDays === 0, stopped: false, unfinishedDays };
    },
    onSettled: () => {
      for (const key of ['emails', 'dashboard', 'tasks', 'drafts', 'documents', 'projects', 'activity']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export function useFollowUpStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status: string }) =>
      api(`/follow-ups/${v.id}`, { method: 'PATCH', body: JSON.stringify({ status: v.status }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['follow-ups'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/**
 * Put a nudge down for a few days without killing it.
 *
 * Deliberately not a status change: the follow-up stays open, so the nightly
 * engine still counts it as raised and does not put a second copy of it on
 * the queue when the date comes back around. Needs migration 0017; without
 * it the API ignores the snooze and only a note-less status change lands.
 */
export function useSnoozeFollowUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; days: number; note?: string }) =>
      api(`/follow-ups/${v.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ snoozeDays: v.days, ...(v.note ? { note: v.note } : {}) }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['follow-ups'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/** Change a task's status, or hand it to someone else. */
/** Raise tasks from email ingested before the tasks table existed. */
export function useBackfillTasks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ ok: boolean; reason?: string; scanned: number; created: number; remaining: number; advanced?: number }>(
        '/ops/backfill-tasks',
        { method: 'POST' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// Duplicate projects are folded together by the server at the end of every
// reading pass, so there is nothing for the web app to ask for. The manual
// route (POST /ops/dedupe-projects) stays for clearing an old backlog.

export interface HouzzImportResult {
  ok: boolean;
  reason?: string;
  created: number;
  updated: number;
  skipped: number;
  /** Which CSV column each field was read from. */
  mapped: Record<string, string>;
  /** Columns in the file nothing was read from. */
  unusedColumns: string[];
}

/**
 * Load a Houzz Pro project export.
 *
 * Houzz has no API for a studio's own projects, so the CSV that
 * pro.houzz.com/manage/projects exports is the only way the list comes
 * across. Safe to run again: rows match on the Houzz id, then on name.
 */
export function useImportHouzz() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (csv: string) =>
      api<HouzzImportResult>('/ops/import-houzz', { method: 'POST', body: JSON.stringify({ csv }) }),
    onSuccess: () => {
      for (const key of ['projects', 'dashboard', 'activity']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

/**
 * Change a task's status, or hand it to someone else.
 *
 * Applied to the cache before the request goes out. Dragging a card across
 * the board is a direct manipulation — the card has to land where it was
 * dropped, immediately — and waiting for a round-trip plus a refetch made it
 * hang in the old column long enough to feel broken, or to be dragged twice.
 * The server is still the authority: a failure puts the board back exactly
 * as it was and surfaces the error.
 */
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status?: TaskStatus; assigned_to?: string | null; due_date?: string | null; next_step?: string | null; category?: TaskCategory; project_id?: string | null }) => {
      const { id, ...patch } = v;
      return api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    },

    onMutate: async (v) => {
      // Stop a refetch already in flight from landing on top of this.
      await qc.cancelQueries({ queryKey: ['tasks'] });
      const previous = qc.getQueryData<TaskView[]>(['tasks']);

      qc.setQueryData<TaskView[]>(['tasks'], (old) =>
        (old ?? []).map((t) => {
          if (t.id !== v.id) return t;
          const next: TaskView = { ...t };

          if (v.status !== undefined) {
            next.status = v.status;
            // Finished work is not overdue, whatever its date said.
            next.overdue =
              !!next.due &&
              next.due < new Date().toISOString().slice(0, 10) &&
              !['done', 'cancelled'].includes(v.status);
            // Finished now, by a person — so no system note. Reopening
            // clears both, as the server does.
            if (v.status === 'done' && t.status !== 'done') next.completedAt = new Date().toISOString();
            if (v.status !== 'done') next.completedAt = null;
            if (v.status !== t.status) next.closedNote = null;
          }

          if (v.due_date !== undefined) {
            next.due = v.due_date;
            next.overdue =
              !!v.due_date &&
              v.due_date < new Date().toISOString().slice(0, 10) &&
              !['done', 'cancelled'].includes(next.status);
          }
          next.daysEarly = daysEarly(next.due, next.completedAt);

          if (v.next_step !== undefined) next.nextStep = v.next_step;
          if (v.category !== undefined) next.category = v.category;

          if (v.project_id !== undefined) {
            const projects = qc.getQueryData<ProjectView[]>(['projects']) ?? [];
            const proj = projects.find((p) => p.id === v.project_id);
            next.project = proj?.name ?? '—';
          }

          if (v.assigned_to !== undefined) {
            next.assignedTo = v.assigned_to;
            // Name it from the roster we already hold, so the card does not
            // flash a placeholder before the refetch catches up.
            const team = qc.getQueryData<TeamMember[]>(['team']) ?? [];
            const who = team.find((m) => m.id === v.assigned_to);
            next.assignee = v.assigned_to
              ? who?.full_name ?? who?.email ?? 'Assigned'
              : 'Unassigned';
          }

          return next;
        }),
      );

      return { previous };
    },

    onError: (_err, _vars, ctx) => {
      // Put the board back; the error is rendered by the page.
      if (ctx?.previous) qc.setQueryData(['tasks'], ctx.previous);
    },

    // Reconcile with the server either way — the optimistic row is a guess
    // at what it stored, not a replacement for it.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['task'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      // Closing a task closes the nudges about it, server-side. Top Priority
      // Actions is built from those, so without this it keeps chasing work
      // that was finished a moment ago on the next screen over.
      qc.invalidateQueries({ queryKey: ['follow-ups'] });
    },
  });
}

/**
 * Delete a task outright.
 *
 * Principals and coordinators only, by default — the server decides, this
 * just asks. Optimistic, because a card that lingers after you removed it
 * reads as a failure.
 */
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['tasks'] });
      const previous = qc.getQueryData<TaskView[]>(['tasks']);
      qc.setQueryData<TaskView[]>(['tasks'], (old) => (old ?? []).filter((t) => t.id !== id));
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(['tasks'], ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      // The task's follow-ups cascade away with it in the database (0005),
      // so the queue they feed has to be refetched here too.
      qc.invalidateQueries({ queryKey: ['follow-ups'] });
    },
  });
}

// ── One task, in full ───────────────────────────────────────

export interface TaskEmail {
  id: string;
  subject: string | null;
  from_addr: string | null;
  to_addr: string | null;
  snippet: string | null;
  received_at: string | null;
  class: string;
  extracted_json: { summary?: string } | null;
}

export interface TaskHistoryEntry {
  id: string;
  type: FollowUpType;
  reason: string | null;
  status: string;
  created_at: string;
}

export interface TaskComment {
  id: string;
  body: string;
  created_at: string;
  /** Null once the person who wrote it has left the studio. */
  author: string | null;
  profiles?: { full_name: string | null } | null;
}

export interface TaskDetail {
  task: {
    id: string; title: string; detail: string | null; kind: TaskKind; status: TaskStatus;
    assigned_to: string | null; assigned_role: UserRole | null; seat: Seat | null;
    next_step: string | null; due_date: string | null;
    category?: TaskCategory | null;
    created_at: string; updated_at: string | null;
    reminded_at: string | null; reminder_count: number;
    /** Migration 0015; absent before it is applied. */
    completed_at?: string | null; completion_note?: string | null;
    /**
     * Who moved it to Done — migration 0032. A profile id, not an embedded
     * name: tasks already embed `profiles` for the assignee, and a second
     * relationship to the same table would make that join ambiguous. Read it
     * against the team roster. Null when the system closed it (then
     * `completion_note` says why) or when it was closed before 0032.
     */
    completed_by?: string | null;
    project_id?: string | null;
    projects: { name: string } | null;
    vendors: { name: string } | null;
    profiles: { full_name: string | null; email: string | null } | null;
  };
  email: TaskEmail | null;
  /**
   * Set only when the source email exists but is a teammate's personal mail
   * (migration 0018) — visible to them, not to whoever is looking at this
   * task. Distinguishes that from a task genuinely added by hand.
   */
  emailHiddenFrom?: string | null;
  history: TaskHistoryEntry[];
  comments: TaskComment[];
  /** False until migration 0033 is applied. */
  commentsAvailable: boolean;
}

/** Everything behind one task — fetched only while its panel is open. */
export function useTaskDetail(id: string | null) {
  return useQuery({
    queryKey: ['task', id],
    queryFn: () => api<TaskDetail>(`/tasks/${id}`),
    enabled: !!id,
  });
}

/** Say something on a task, naming anyone who needs to see it. */
export function useAddComment(taskId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: string; mentions: string[] }) =>
      api<{ comment: TaskComment; mentioned: number }>(`/tasks/${taskId}/comments`, {
        method: 'POST',
        body: JSON.stringify(v),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      // Someone else's bell, not this person's — but the panel may be open
      // on two screens, and a mention of yourself is filtered server-side.
      qc.invalidateQueries({ queryKey: ['mentions'] });
    },
  });
}

/** Fix a typo or clarify what you wrote. Only the author can edit. */
export function useUpdateComment(taskId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, body }: { commentId: string; body: string }) =>
      api(`/tasks/${taskId}/comments/${commentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['task', taskId] });
    },
  });
}

/** Remove a comment for good. Only the author can delete. */
export function useDeleteComment(taskId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) =>
      api(`/tasks/${taskId}/comments/${commentId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['task', taskId] });
    },
  });
}

export interface MentionRow {
  id: string;
  task_id: string;
  created_at: string;
  task_comments: { body: string; profiles: { full_name: string | null } | null } | null;
  tasks: { title: string } | null;
}

/**
 * Unread mentions, for the bell.
 *
 * Polled on the same terms as the rest of the panel rather than pushed:
 * there is no socket in this app, and a mention that arrives within a
 * minute of being written is soon enough for a studio of seven.
 */
export function useMentions() {
  const q = useQuery({
    queryKey: ['mentions'],
    queryFn: () => api<MentionRow[]>('/me/mentions'),
    refetchInterval: 60_000,
  });
  return { ...q, data: q.data ?? [] };
}

/** Mark mentions seen — the ones named, or all of them. */
export function useMarkMentionsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) =>
      api<{ read: number }>('/me/mentions/read', {
        method: 'POST',
        body: JSON.stringify(ids?.length ? { ids } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mentions'] }),
  });
}

export interface DraftRow {
  id: string;
  subject: string | null;
  body_preview: string | null;
  follow_up_id: string | null;
  created_at: string;
  /** Who saved it by hand; null for one the reading pass wrote. */
  created_by?: string | null;
  /** Whose mailbox it answers — migration 0018, absent before it applies. */
  owner_id?: string | null;
  /** Gmail's own draft id, when this one made it into the real Drafts folder. */
  gmail_draft_id?: string | null;
  /** The message underneath that draft — migration 0025, absent before it applies. */
  gmail_message_id?: string | null;
}
export function useDrafts() {
  const q = useQuery({ queryKey: ['drafts'], queryFn: () => api<DraftRow[]>('/drafts') });
  return { ...q, data: q.data ?? [] };
}

export function useCreateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { to?: string; subject?: string; body: string }) =>
      api<{ id: string }>('/drafts', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['drafts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export interface DraftEdit { to: string; cc: string; subject: string; body: string }
export function useUpdateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...v }: DraftEdit & { id: string }) =>
      api<DraftRow>(`/drafts/${id}`, { method: 'PATCH', body: JSON.stringify(v) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['drafts'] }),
  });
}

export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/drafts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['drafts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; patch: Record<string, unknown> }) =>
      api(`/projects/${v.id}`, { method: 'PATCH', body: JSON.stringify(v.patch) }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['project', v.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/** Start Google consent for one service (gmail | drive) or both. */
export function useConnectGoogle() {
  return useMutation({
    mutationFn: async (
      v: GoogleService | 'all' | { service?: GoogleService | 'all'; next?: 'settings' | 'dashboard' } = 'all',
    ) => {
      // Called both ways: Settings passes a service name, the first-run
      // prompt passes where it wants Google to come back to.
      const { service = 'all', next = 'settings' } = typeof v === 'string' ? { service: v } : v;
      // Signed in as a teammate, Google would attach whichever Google account
      // THIS browser is signed into — the admin's — to the teammate's login,
      // and all of the wrong mail would be read as theirs. Only they can
      // connect their own mailbox.
      if (readImpersonation()) {
        throw new Error('You are signed in as someone else. They must connect their own Google — ask them to sign in and do it.');
      }
      const { url } = await api<{ url: string }>(`/auth/google/url?service=${service}&next=${next}`);
      window.location.href = url;
    },
  });
}

/** Revoke the Google connection (both Gmail and Drive). */
/**
 * Stop using ONE Google service. Google cannot revoke half a grant, so
 * this drops that service’s scopes from the stored integration: the app
 * stops reading it, the other service keeps working, and reconnecting is
 * one consent screen away.
 */
export function useDisconnectGoogleService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (service: GoogleService) =>
      api<{ ok: boolean }>(`/auth/google/${service}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useDisconnectGoogle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean }>('/auth/google', { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ── Permission matrix (dynamic module access) ───────────────
export interface PermissionCell {
  role: UserRole;
  resource: Resource;
  action: Action;
  /** What the studio default says, before any override. */
  default: boolean;
  /** What is actually true right now. */
  allowed: boolean;
  overridden: boolean;
  /** Cells the studio is not allowed to change, so it cannot lock itself out. */
  locked: boolean;
  updated_at: string | null;
}

export function usePermissionMatrix() {
  return useQuery({
    queryKey: ['permissions'],
    queryFn: () =>
      api<{ cells: PermissionCell[]; canEdit: boolean; storageReady: boolean }>('/permissions'),
  });
}

/**
 * Grant or revoke one module for one role. Invalidates everything: a
 * permission change can add or remove controls anywhere in the app, and
 * the API re-reads the matrix on its next request.
 */
export function useSetPermission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { role: UserRole; resource: Resource; action: Action; allowed: boolean }) =>
      api<PermissionCell>('/permissions', { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

/** Put one cell back to the studio default. */
export function useResetPermission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { role: UserRole; resource: Resource; action: Action }) =>
      api<PermissionCell>(
        `/permissions?role=${v.role}&resource=${v.resource}&action=${v.action}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

// ── AI configuration ────────────────────────────────────────
export interface AiConfig extends AiSettingsView {
  models: SelectableModel[];
}

export function useAiConfig() {
  return useQuery({ queryKey: ['ai-config'], queryFn: () => api<AiConfig>('/settings/ai') });
}

/** Changing the key or model changes what every AI feature can do. */
function useAiMutation<V>(fn: (v: V) => Promise<AiSettingsView>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-config'] });
      qc.invalidateQueries({ queryKey: ['health'] });
    },
  });
}

export function useSetAiKey() {
  return useAiMutation((apiKey: string) =>
    api<AiSettingsView>('/settings/ai/key', { method: 'PUT', body: JSON.stringify({ apiKey }) }),
  );
}

export function useClearAiKey() {
  return useAiMutation(() => api<AiSettingsView>('/settings/ai/key', { method: 'DELETE' }));
}

// ── OpenAI (GPT Image) ──────────────────────────────────────

export interface OpenAiConfig {
  configured: boolean;
  source: 'studio' | 'environment' | 'none';
  keyHint: string | null;
  imageModel: string;
  quality: 'low' | 'medium' | 'high';
  models: { id: string; label: string; usd: Record<'low' | 'medium' | 'high', number>; approx?: boolean; note: string }[];
  qualities: { id: 'low' | 'medium' | 'high'; label: string }[];
}

export function useOpenAiConfig() {
  return useQuery({ queryKey: ['openai-config'], queryFn: () => api<OpenAiConfig>('/settings/openai') });
}

/** A new key changes which providers the Create buttons can use, so both are refreshed. */
function useOpenAiMutation<V>(fn: (v: V) => Promise<OpenAiConfig>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.setQueryData(['openai-config'], data);
      qc.invalidateQueries({ queryKey: ['imagine-options'] });
    },
  });
}

export function useSetOpenAiKey() {
  return useOpenAiMutation((apiKey: string) =>
    api<OpenAiConfig>('/settings/openai/key', { method: 'PUT', body: JSON.stringify({ apiKey }) }),
  );
}

export function useClearOpenAiKey() {
  return useOpenAiMutation(() => api<OpenAiConfig>('/settings/openai/key', { method: 'DELETE' }));
}

export function useSetOpenAiModel() {
  return useOpenAiMutation((v: { model?: string; quality?: string }) =>
    api<OpenAiConfig>('/settings/openai/model', { method: 'PUT', body: JSON.stringify(v) }),
  );
}

// ── Who does the work: the AI behind each action ────────────

export function useAiRouting() {
  return useQuery({ queryKey: ['ai-routing'], queryFn: () => api<AiRoutingView>('/settings/ai-routing') });
}

function useRoutingMutation<V>(fn: (v: V) => Promise<AiRoutingView>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (data) => qc.setQueryData(['ai-routing'], data) });
}

export function useSetAiRoute() {
  return useRoutingMutation(
    (v: { feature: string; provider: string; model?: string; inputPer1M?: number; outputPer1M?: number }) =>
      api<AiRoutingView>('/settings/ai-routing', { method: 'PUT', body: JSON.stringify(v) }),
  );
}

export function useSetGeminiTextKey() {
  return useRoutingMutation((apiKey: string) =>
    api<AiRoutingView>('/settings/ai-routing/gemini-key', { method: 'PUT', body: JSON.stringify({ apiKey }) }),
  );
}

export function useClearGeminiTextKey() {
  return useRoutingMutation(() => api<AiRoutingView>('/settings/ai-routing/gemini-key', { method: 'DELETE' }));
}

export function useTestAiRoute() {
  return useMutation({
    mutationFn: (v: { provider: string; model: string; inputPer1M?: number; outputPer1M?: number }) =>
      api<AiRoutingTestResult>('/settings/ai-routing/test', { method: 'POST', body: JSON.stringify(v) }),
  });
}

// ── Who draws pictures ──────────────────────────────────────

export interface PictureConfig {
  /** Who makes the picture on a board: `openai`, or a Claude model id. */
  engine: string;
  engines: { id: string; label: string; note: string }[];
}

// ── Slack (task and follow-up updates) ──────────────────────

export interface SlackConfig {
  connected: boolean;
  source: 'studio' | 'environment' | 'none';
  keyHint: string | null;
  channel: string;
  enabled: boolean;
  tasks: boolean;
  followUps: boolean;
  dailyDigest: boolean;
  /** Channels for the completed / pending / overdue task reports; '' = not sent. */
  reportChannels: SlackReportChannels;
  /** Each person's 9am priorities and 5pm check-in as a DM, and the team summary to the owner. */
  personalReminders: boolean;
  lastRunAt: string | null;
  lastPosted: number;
  lastError: string | null;
}

export interface SlackReportChannels {
  completed: string;
  pending: string;
  overdue: string;
}

export interface SlackReportSent {
  ok: boolean;
  skipped?: 'not_connected' | 'paused' | 'no_channels';
  reports: { kind: keyof SlackReportChannels; channel: string; tasks: number; posted: boolean; error?: string }[];
}

export function useSlackReportNow() {
  return useMutation({ mutationFn: () => api<SlackReportSent>('/settings/slack/report', { method: 'POST' }) });
}

export function useSlackConfig() {
  return useQuery({ queryKey: ['slack-config'], queryFn: () => api<SlackConfig>('/settings/slack') });
}

function useSlackMutation<V>(fn: (v: V) => Promise<SlackConfig>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (data) => qc.setQueryData(['slack-config'], data) });
}

export function useSetSlackToken() {
  return useSlackMutation((token: string) =>
    api<SlackConfig>('/settings/slack/token', { method: 'PUT', body: JSON.stringify({ token }) }),
  );
}

export function useClearSlackToken() {
  return useSlackMutation(() => api<SlackConfig>('/settings/slack/token', { method: 'DELETE' }));
}

export function useSetSlackConfig() {
  return useSlackMutation((v: { channel?: string; enabled?: boolean; tasks?: boolean; followUps?: boolean; dailyDigest?: boolean; personalReminders?: boolean; reportChannels?: Partial<SlackReportChannels> }) =>
    api<SlackConfig>('/settings/slack/config', { method: 'PUT', body: JSON.stringify(v) }),
  );
}

export function useSlackTest() {
  return useSlackMutation(() => api<SlackConfig>('/settings/slack/test', { method: 'POST' }));
}

export interface SlackDigestSent {
  ok: boolean;
  skipped?: string;
  tasks: number;
  followUps: number;
  projectPosts?: number;
  warnings?: string[];
  error?: string;
}

export function useSlackDigestNow() {
  return useMutation({ mutationFn: () => api<SlackDigestSent>('/settings/slack/digest', { method: 'POST' }) });
}

export interface SlackProjectChannels {
  /** Migration 0029 is applied, so a channel can be assigned. */
  ready: boolean;
  /** The bot may not read the channel list, so there is no automatic matching. */
  missingScope: boolean;
  projects: {
    id: string;
    name: string;
    /** What an admin assigned; empty when left to match by name. */
    channel: string;
    /** The channel found by name, if any. */
    auto: string | null;
    /** False when the bot is known not to be in the channel it would post to. */
    botIn: boolean | null;
  }[];
}

export function useSlackProjects(enabled: boolean) {
  return useQuery({
    queryKey: ['slack-projects'],
    queryFn: () => api<SlackProjectChannels>('/settings/slack/projects'),
    enabled,
  });
}

export function useSetProjectChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; channel: string }) =>
      api<{ ok: true }>(`/settings/slack/projects/${v.id}`, { method: 'PUT', body: JSON.stringify({ channel: v.channel }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['slack-projects'] }),
  });
}

export function useSlackSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ result: { posted: number; updated: number; error?: string }; settings: SlackConfig }>('/settings/slack/sync', {
        method: 'POST',
      }),
    onSuccess: (data) => qc.setQueryData(['slack-config'], data.settings),
  });
}

export function usePictureConfig() {
  return useQuery({ queryKey: ['picture-config'], queryFn: () => api<PictureConfig>('/settings/images') });
}

export function useSetPictureEngine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (engine: string) =>
      api<PictureConfig>('/settings/images/engine', { method: 'PUT', body: JSON.stringify({ engine }) }),
    onSuccess: (data) => {
      qc.setQueryData(['picture-config'], data);
      qc.invalidateQueries({ queryKey: ['imagine-options'] });
    },
  });
}

/**
 * The chasing ladder — how long the studio waits before it says something.
 *
 * Read by the nightly engine, the digest and the task board; until now it
 * could only be changed in the database.
 */
export type Sla = {
  quote_response_days: number;
  client_waiting_hours: number;
  vendor_silence_days: number;
  client_approval_days: number;
  escalation_days: number;
  task_reminder_days: number;
  reminder_repeat_days: number;
};

export function useSla() {
  return useQuery({
    queryKey: ['sla'],
    queryFn: () => api<Sla>('/settings/sla'),
  });
}

export function useSaveSla() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Sla>) =>
      api<Sla>('/settings/sla', { method: 'PUT', body: JSON.stringify(patch) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sla'] });
      // The board's due dates are computed from these.
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export type ClaritySettings = { projectId: string | null; enabled: boolean };

/** Microsoft Clarity session-replay config. Admin-only endpoint. */
export function useClaritySettings() {
  return useQuery({
    queryKey: ['clarity-settings'],
    queryFn: () => api<ClaritySettings>('/settings/clarity'),
  });
}

export function useSaveClaritySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { projectId?: string | null; enabled?: boolean }) =>
      api<ClaritySettings>('/settings/clarity', { method: 'PUT', body: JSON.stringify(patch) }),
    onSuccess: (data) => qc.setQueryData(['clarity-settings'], data),
  });
}

export function useIngestSettings() {
  return useQuery({
    queryKey: ['ingest-settings'],
    queryFn: () => api<IngestSettingsView>('/settings/ingest'),
  });
}

/** How often email is read, and whether Claude reads it. */
export function useSetIngestSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { intervalMinutes?: number; useAi?: boolean; taskReviewMinutes?: number }) =>
      api<IngestSettingsView>('/settings/ingest', { method: 'PUT', body: JSON.stringify(patch) }),
    onSuccess: (data) => qc.setQueryData(['ingest-settings'], data),
  });
}

export function useSetAiModel() {
  return useAiMutation((model: string) =>
    api<AiSettingsView>('/settings/ai/model', { method: 'PUT', body: JSON.stringify({ model }) }),
  );
}

// ── AI usage ────────────────────────────────────────────────
export interface UsageLink {
  token: string | null;
  path: string | null;
  created_at: string | null;
}

/** What the Create buttons can offer right now, and what a clip would cost. */
export interface ImagineOptions {
  image: { ready: boolean; provider: 'openai' | 'grok' | 'gemini' | 'cloudflare' | 'claude' | null };
  video: {
    ready: boolean;
    model: string;
    defaultSeconds: number;
    maxSeconds: number;
    usdPerSecond: number;
    spentTodayUsd: number;
    dailyCapUsd: number;
  };
}

export function useImagineOptions() {
  return useQuery({
    queryKey: ['imagine-options'],
    queryFn: () => api<ImagineOptions | null>('/assistant/imagine/options'),
    // Keys and caps change in Settings, not between keystrokes.
    staleTime: 5 * 60_000,
  });
}

export function useAiUsage(days = 30) {
  // The reader's offset, so the report's "today" is their day rather than
  // UTC's — which otherwise rolls over mid-afternoon on the US west coast.
  const tz = new Date().getTimezoneOffset();
  return useQuery({
    queryKey: ['ai-usage', days, tz],
    queryFn: () => api<AiUsageReport>(`/usage?days=${days}&tz=${tz}`),
  });
}

export function useUsageLink() {
  return useQuery({ queryKey: ['usage-link'], queryFn: () => api<UsageLink>('/usage/link') });
}

export function useRotateUsageLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<UsageLink>('/usage/link/rotate', { method: 'POST' }),
    onSuccess: (data) => qc.setQueryData(['usage-link'], data),
  });
}

export function useRevokeUsageLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<UsageLink>('/usage/link', { method: 'DELETE' }),
    onSuccess: (data) => qc.setQueryData(['usage-link'], data),
  });
}

/* ── Login history ───────────────────────────────────────────── */

export type LoginMethodName = 'password' | 'google' | 'recovery' | 'invite' | 'unknown';

export interface LoginEvent {
  id: string;
  created_at: string;
  email: string | null;
  method: LoginMethodName;
  outcome: 'success' | 'failure';
  reason: string | null;
  /** Kept for a real investigation; the screen shows the place instead. */
  ip: string | null;
  user_agent: string | null;
  /** 'backfill' — read out of Supabase's audit trail by migration 0034. */
  source: 'app' | 'backfill';
  user_id: string | null;
  name: string | null;
  /**
   * Where the address was AT THE TIME, resolved once when the attempt was
   * recorded. Null for a private address, a failed lookup, and every row
   * written before migration 0035.
   */
  city: string | null;
  region: string | null;
  country: string | null;
  country_code: string | null;
  /**
   * How the address was known. 'server' — observed on the connection.
   * 'client' — the browser reported it, because what the server saw was
   * loopback or a private LAN address. Null for rows before 0036.
   */
  ip_source: 'server' | 'client' | null;
}

export interface LoginHistorySummary {
  total: number;
  successes: number;
  failures: number;
  people: number;
  byMethod: { method: LoginMethodName; successes: number; failures: number }[];
  /**
   * Whether a Google sign-in has EVER succeeded, over the whole table
   * rather than the window. False on its own proves nothing — a table with
   * no rows yet says the same thing — so read it beside recentFailures.
   */
  googleEverWorked: boolean;
  recentFailures: LoginEvent[];
}

export interface LoginHistory {
  /** False until migration 0034 has been applied. */
  ready: boolean;
  days: number;
  rows: LoginEvent[];
  summary: LoginHistorySummary | null;
}

export function useLoginHistory(days: number) {
  return useQuery({
    queryKey: ['login-history', days],
    queryFn: () => api<LoginHistory>(`/login-history?days=${days}`),
  });
}
