import type Anthropic from '@anthropic-ai/sdk';
import {
  TASK_KINDS,
  TASK_KIND_ROLE,
  canSupervise,
  type TaskKind,
  type UserRole,
} from '@janelle/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AGENT_BLURBS,
  AGENT_LABELS,
  AI_FEATURE_LABELS,
  ASSISTANT_NAME,
  DEFAULT_SLA,
  ROLE_LABELS,
  STAGE_LABELS,
  SEATS,
  canManageTasks,
  canWith,
  videoCostUsd,
  type AgentKey,
  type AssistantAnswer,
  type AssistantField,
  type AssistantItem,
  type AssistantItemKind,
  type AssistantPageContext,
  type AssistantTone,
  type PermissionOverrides,
  type ProjectStage,
  type Seat,
} from '@janelle/shared';
import { agentAllows, agentsFor } from './assistantAgents.js';
import type { drive_v3 } from '@googleapis/drive';
import type { gmail_v1 } from '@googleapis/gmail';
import { createMessage, isAiReady, isTimeoutError } from './anthropic.js';
import { fillTemplate, matchPrompt, missingInputs, runLibraryPrompt } from './promptRunner.js';
import { BOARD_PROMPTS, boardPrompt, freeformBoard, isRenderable } from './boards.js';
import { isImageReady, renderImage, type ImageReference } from './images.js';
import { clampSeconds, grokModels } from './grok.js';
import { makePicture, startClip } from './imagine.js';
import { storeUpload, type UploadType } from '../lib/uploads.js';
import {
  ProposalError,
  commitProposal,
  friendlyDay,
  matchPerson,
  matchProject,
  peopleOf,
  projectsOf,
  teamOf,
} from './proposals.js';
import { hasColumn, profileColumns } from '../lib/columns.js';
import { STUDIO_TEAM, isStudioMailbox, seatRole, studioPerson } from '../lib/studioTeam.js';
import { bodyColumnsReady, readStoredText } from '../lib/emailStore.js';
import { env } from '../env.js';
import { isGoogleAuthFailure, orgSourceUserId } from '../lib/tokens.js';
import {
  MAX_RELAY_BYTES,
  UPLOAD_GRANT_TTL_MS,
  openFileGrant,
  sealFileGrant,
  type FileGrant,
} from '../lib/fileTokens.js';
import { FileFetchError, fetchGrantedFile } from './files.js';
import { readDocument } from './documentReader.js';
import {
  addressOf,
  getMessageWithAttachments,
  gmailFor,
  gmailMessageUrl,
  linksIn,
  searchMessages,
} from './gmail.js';
import {
  downloadShape,
  driveFor,
  findFolderId,
  getDriveFile,
  readDriveText,
  searchDriveFiles,
  type DriveHit,
  type DriveKind,
} from './drive.js';

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ProposedAction {
  tool: string;
  summary: string;
  input: Record<string, unknown>;
}

/** A proposal shown earlier and not yet answered — the browser's own key for it. */
export interface PendingProposal extends ProposedAction {
  key: string;
}

/** What became of a pending proposal during this question. */
export interface SettledProposal {
  key: string;
  decision: 'confirmed' | 'cancelled';
  /** The saved row, when confirmed. */
  id?: string | null;
  kind?: 'task' | 'draft' | 'task_update';
}

export interface AssistantResult {
  /**
   * The answer as one block of text.
   *
   * Kept alongside the structured answer because the conversation history
   * is a list of strings — the next question needs to know what was said,
   * not how it was laid out — and because an error path has prose and
   * nothing else.
   */
  reply: string;
  /** The same answer, laid out: a lead, the rows behind it, what it cost to find. */
  answer: AssistantAnswer;
  /** Writes the assistant wants to make, awaiting the person's confirmation. */
  proposed: ProposedAction[];
  /** Tools actually consulted, so the UI can show its working. */
  used: string[];
  /**
   * Earlier proposals the person answered in words — "yes", "cancel that" —
   * and what became of them, so the browser can mark them done.
   */
  settled: SettledProposal[];
  /**
   * Media jobs this question started and did not finish.
   *
   * A clip is still being drawn when the answer is sent, so the ids travel
   * with it and the browser waits on them. Empty for every other question.
   */
  startedJobs: string[];
}

export interface AssistantContext {
  db: SupabaseClient;
  userId: string;
  orgId: string | null;
  role: UserRole | null;
  /** The person's own name, as the studio knows them — "my tasks" depends on it. */
  name: string;
  /** Their named seat, where one is held: finer than the role. */
  seat?: Seat | null;
  /** The screen they are on when they ask, so "this one" has a meaning. */
  page?: AssistantPageContext | null;
  /** The studio's edits to the permission matrix, applied to anything saved. */
  permissions?: PermissionOverrides | null;
  /** Proposals shown earlier that are still waiting for an answer. */
  pending?: PendingProposal[];
  /**
   * Named agent(s) switched on for this conversation, if any — narrows
   * which tools may run (see services/assistantAgents.ts). Empty or unset
   * means unrestricted: every tool reachable, today's default.
   */
  agents?: AgentKey[] | null;
  /**
   * Set when the question was spoken: every way the browser heard it, best
   * first. Speech recognition mishears — names most of all — and the model
   * reads the question better knowing that, and knowing the other hearings.
   */
  spoken?: { alternatives: string[] } | null;
  /**
   * Files Jenny handed over earlier in this conversation, as grants the
   * server has already opened — so "from this PDF" can mean the one she just
   * gave them, though a reference like F1 only lives for one question.
   */
  recentFiles?: { token: string; grant: FileGrant }[];
  /** Files the person attached to this very question — their own uploads. */
  attached?: { token: string; grant: FileGrant }[];
}

/** Where a granted file lives outside this app, when it lives anywhere else. */
function grantWebUrl(grant: FileGrant): string | null {
  if (grant.source === 'gmail') return gmailMessageUrl(grant.messageId);
  if (grant.source === 'drive') return `https://drive.google.com/file/d/${grant.fileId}/view`;
  return null;
}

/** "2.1 MB", "340 KB" — a size as it is said. */
function sizeLabel(bytes: number): string {
  if (!bytes) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Hooks a caller can use to watch the assistant work. */
export interface AskOptions {
  /**
   * Called as the work moves along — "Searching Gmail", "Putting it
   * together" — so a person waiting sees what is happening rather than
   * a spinner that could mean anything.
   */
  onStatus?: (text: string) => void;
}

const LIVE = ['open', 'in_progress', 'blocked'];

// ── Per-question state ──────────────────────────────────────

/**
 * Rows the tools have shown the model, each under a short reference.
 *
 * When someone asks for the project list, the list has to come back as
 * rows with every figure right. Asking the model to copy twenty projects
 * into its answer gets neither: output is the slowest thing a model does,
 * and a retyped uuid or a transposed amount is exactly the error nobody
 * spots. So every row a tool returns is registered here, fully formatted,
 * and the tool hands the model a reference — `P3`, `E1`, `F2`. The answer
 * lists references; the server swaps each for the row it stands for.
 */
class RefRegistry {
  private readonly items = new Map<string, AssistantItem>();
  private readonly counters = new Map<string, number>();

  /** Register a row and get the reference the model should use for it. */
  add(prefix: string, item: AssistantItem): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    const ref = `${prefix}${n}`;
    this.items.set(ref, item);
    return ref;
  }

  get(ref: string): AssistantItem | undefined {
    return this.items.get(ref.trim().toUpperCase());
  }
}

/**
 * The studio's Google account, opened at most once per question.
 *
 * Every live tool needs a Gmail or Drive client, and building one reads and
 * decrypts the stored grant. A question that searches, then reads, then
 * fetches attachments would otherwise do that three times.
 */
class GoogleAccess {
  private userId: Promise<string | null> | null = null;
  private gmailClient: Promise<gmail_v1.Gmail | null> | null = null;
  private driveClient: Promise<drive_v3.Drive | null> | null = null;

  constructor(private readonly orgId: string | null) {}

  private source(): Promise<string | null> {
    this.userId ??= this.orgId ? orgSourceUserId(this.orgId) : Promise.resolve(null);
    return this.userId;
  }

  /** Gmail, or a ToolDataError saying why not — never a silent null. */
  async gmail(): Promise<gmail_v1.Gmail> {
    this.gmailClient ??= this.source().then((id) => (id ? gmailFor(id) : null));
    const client = await this.gmailClient;
    if (!client) {
      throw new ToolDataError('Gmail is not connected for the studio — the principal connects it in Settings → Integrations');
    }
    return client;
  }

  async drive(): Promise<drive_v3.Drive> {
    this.driveClient ??= this.source().then((id) => (id ? driveFor(id) : null));
    const client = await this.driveClient;
    if (!client) {
      throw new ToolDataError('Google Drive is not connected for the studio — the principal connects it in Settings → Integrations');
    }
    return client;
  }
}

/** Everything a tool may touch beyond the database. */
interface ToolSession {
  proposed: ProposedAction[];
  refs: RefRegistry;
  google: GoogleAccess;
  settled: SettledProposal[];
  /**
   * Work a studio prompt produced this turn.
   *
   * Held because the model cannot be relied on to hand it back: asked for a
   * kitchen design it will happily answer "I've written a full kitchen
   * design review" and leave the design behind — and on the out-of-time
   * path it answers under a 1536-token cap, where a real one could not fit
   * even if it tried. The work exists; delivering it is not the model's
   * decision to get wrong.
   */
  produced: ProducedWork | null;
  /**
   * Video jobs this question set off.
   *
   * Carried back to the browser because the clip does not exist yet: the
   * answer is written and sent while the provider is still drawing, and
   * these ids are how the screen knows there is something to wait for.
   */
  startedJobs: string[];
  /**
   * When this question started. A tool that can run long — a render — sizes
   * itself to what is left of the FUNCTION, not only of the answer budget:
   * the answer still has to be written after it, inside the same 60s.
   */
  startedAt: number;
}

/**
 * The latest a render inside a turn may finish, from the question's start.
 * What follows it is one forced answer (a few seconds) before the platform's
 * 60s — so a picture that finishes by here still reaches the screen.
 */
const RENDER_IN_TURN_CEILING_MS = Number(process.env.RENDER_IN_TURN_CEILING_MS || 42_000);

interface ProducedWork {
  title: string;
  body: string;
}

/**
 * How long one question may take before the assistant must answer with
 * what it has. Must stay under the serverless function's maxDuration (60s
 * in vercel.json): past that the platform kills the request and the person
 * gets nothing back at all.
 */
const ASSISTANT_BUDGET_MS = Number(process.env.ASSISTANT_BUDGET_MS || 40_000);

// ── Tool surface ────────────────────────────────────────────
// Read tools answer questions from real rows so the assistant cannot
// invent a status. Write tools never execute here — they come back as
// proposals a person confirms, because this is driven by voice and a
// misheard sentence must not silently reassign someone's work.

/**
 * The tool that delivers the answer, and by delivering it ends the turn.
 *
 * Declared apart from the read tools because it is also offered ON ITS OWN
 * when the clock runs out (see finalAnswer) — the one path where the shape
 * of the answer has to be guaranteed rather than asked for.
 */
export const ANSWER_TOOL: Anthropic.Tool = {
  name: 'answer',
  description:
    'Give your final answer. This ENDS your turn — call it exactly once, on its own, after every lookup you need is done, and never alongside another tool. Do not also write the answer as ordinary text: whatever you put here is what the person sees and hears.',
  input_schema: {
    type: 'object',
    properties: {
      lead: {
        type: 'string',
        description:
          'The answer itself, in one or two sentences of plain prose. Lead with it — never with what you checked or could not do. No markdown, no headings, no bullet characters; the rows go in items.',
      },
      items: {
        type: 'array',
        description:
          'The records the answer is about, one entry each — the projects, the late orders, the overdue tasks, the files. Leave it empty when the answer is simply a sentence. At most 25; put the count of the rest in `more`.',
        items: {
          type: 'object',
          properties: {
            ref: {
              type: 'string',
              description:
                'The `ref` a tool gave this row ("P3", "F1"). PREFER THIS: a ref alone is a complete row — the server fills in the title, every figure and, for a file, the download — so send { "ref": "P3" } and add only meta or tone if you have judgement to add. Only write out kind and title for something no tool gave a ref.',
            },
            kind: {
              type: 'string',
              enum: [
                'task', 'project', 'purchase_order', 'vendor', 'email', 'document',
                'draft', 'follow_up', 'person', 'report', 'file', 'link', 'note',
              ],
              description:
                "What this row IS, so it can be linked to its screen. Not needed with a ref. Use 'link' for a bare URL and 'note' only for a line that is not a record at all.",
            },
            id: {
              type: 'string',
              description:
                'The row id EXACTLY as the tool returned it. This is what makes the row openable — pass it whenever you have it, and omit it rather than inventing one.',
            },
            title: { type: 'string', description: 'What it is, in a few words. No trailing punctuation.' },
            detail: { type: 'string', description: 'One short line: the owner, the project, the amount.' },
            meta: {
              type: 'string',
              description: 'The single fact that matters most — "12 days late", "$4,200", "due Friday". Keep it under 30 characters.',
            },
            url: { type: 'string', description: 'The URL, when this row is a link or a document that can be opened.' },
            tone: {
              type: 'string',
              enum: ['neutral', 'good', 'warn', 'crit'],
              description: "How it reads: 'crit' for a client left waiting or a real breach, 'warn' for slipping, 'good' for settled.",
            },
          },
          // Nothing is required: a row is EITHER a ref, or a kind and a
          // title. JSON Schema cannot say "one of" in a way every model
          // honours, so toItem() enforces it instead.
          required: [],
        },
      },
      more: {
        type: 'number',
        description: 'How many further rows exist beyond the ones listed. 0 when the list is complete.',
      },
      caveat: {
        type: 'string',
        description:
          'One clause about anything you could not check, and only when something genuinely failed. Never use it to hedge an answer you do have.',
      },
      document: {
        type: 'string',
        description:
          'Long-form work you were asked to PRODUCE — a moodboard, a design direction, a finish or FF&E schedule, a brief, a review. Markdown, with headings, lists and tables as the work needs them. Put the work here and keep `lead` to a sentence saying what it is; never crush a schedule into `lead`, and never put an ordinary answer here. Leave it out entirely when nothing was produced.',
      },
      documentTitle: {
        type: 'string',
        description: 'What the document is, in a few words — "Primary bathroom moodboard". Only with `document`.',
      },
      speech: {
        type: 'string',
        description:
          'The same answer as one or two sentences to be read ALOUD. No lists, no ids, no URLs — name the worst one or two and say how many others there are. This is what a person hears when they are driving. Write only words a person would say: no dashes, slashes, bullets, brackets, quotation marks, hashes or asterisks, and nothing abbreviated that would be read letter by letter.',
      },
      suggestions: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Up to three things the person is likely to want next, written as THEY would say them — "Draft a chase to Ashcroft Mill", "Which of these is the client waiting on?". Each must be something you can actually do with your tools, and specific to this answer, not generic. Under 60 characters each.',
      },
    },
    required: ['lead', 'speech'],
  },
};

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_projects',
    description:
      "List the studio's live projects with stage, client, target install date AND money: each project's budget, the total value of its purchase orders (on_order), how many POs are open, and how many spec gaps are unresolved. Archived projects are left out unless include_archived is set. Use for \"what is happening with X\", \"how many projects are in production\", and for any question about cost, value, budget or which project is biggest — sort_by: 'cost' answers that directly.",
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional name or client to filter on (case-insensitive substring).' },
        stage: { type: 'string', description: 'Limit to one pipeline stage, e.g. "production".' },
        include_archived: {
          type: 'boolean',
          description: 'Include archived (closed) projects. Only when the person asks about old or finished work.',
        },
        sort_by: {
          type: 'string',
          enum: ['cost', 'recent', 'install'],
          description: "'cost' ranks by on_order value, highest first — use this for \"highest cost project\".",
        },
        limit: { type: 'number', description: 'Return at most this many projects.' },
      },
    },
  },
  {
    name: 'list_tasks',
    description:
      'List work items. Use to answer who owes what, what is overdue, and what someone is working on.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['live', 'all', 'open', 'in_progress', 'blocked', 'done', 'cancelled'] },
        assignee_name: { type: 'string', description: 'Filter to one person by name (substring).' },
        project: { type: 'string', description: 'Filter to one project by name (substring).' },
        kind: { type: 'string', enum: [...TASK_KINDS] },
        overdue_only: { type: 'boolean' },
      },
    },
  },
  {
    name: 'get_project_status',
    description:
      'Everything about one project at once: stage, open POs, open tasks, spec gaps and recent email. Use when asked for progress on a named project.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Project or client name (substring).' } },
      required: ['name'],
    },
  },
  {
    name: 'list_team',
    description: 'The people in the studio: seat, role, email and how many live tasks each is carrying — including teammates who have no account yet, and which inboxes are shared rather than a person.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_today',
    description:
      "This morning's digest: what is overdue, what breached the quote SLA, what is unassigned, and what needs the principal.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_email',
    description:
      'Read the email the system has ingested. Use for "check the emails", "what came in from X", "how many quotes arrived", or anything about the inbox. Returns the most recent matching messages plus a breakdown by type.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Match against subject, sender or snippet.' },
        project: { type: 'string', description: 'Limit to one project by name (substring).' },
        klass: {
          type: 'string',
          enum: ['vendor_quote', 'order_confirmation', 'client_approval', 'houzz_notification', 'general', 'unclassified'],
          description: 'Limit to one kind of email.',
        },
        days: { type: 'number', description: 'Only messages received in the last N days.' },
        without_task: {
          type: 'boolean',
          description: 'Only email that has NO task yet — for "which new emails still need a task?", or to find the one they want a task raised from.',
        },
      },
    },
  },
  {
    name: 'read_email',
    description:
      "Read one stored email IN FULL — the text of what was actually written, every link in it, and every attachment parsed from it (quotes, order confirmations, with vendor and total). Use this whenever the answer depends on the wording or on a detail the summary would not carry: a link ('the Canva link', 'the Drive folder'), a measurement, a price, an address, a name, a date, or 'what exactly did X say'. Pass the id from search_email, or a search phrase to find the most recent match. Costs more than search_email, so reach for it when the summary is not enough — but DO reach for it rather than saying something was not captured.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The email id from search_email.' },
        search: { type: 'string', description: 'Instead of an id: match subject, sender or body; the newest match is read.' },
      },
    },
  },
  {
    name: 'search_documents',
    description:
      'Find parsed documents — vendor quotes, order confirmations and purchase orders pulled from Drive and from email attachments. Use for "send me the quote for X", "which documents do we have on this project", "what did the vendor quote". Returns what each document contains plus a link to open the original.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Limit to one project by name. Only when you KNOW it is a project.' },
        vendor: { type: 'string', description: 'Limit to documents from one vendor. Only when you KNOW it is a vendor.' },
        type: {
          type: 'string',
          enum: ['quote', 'purchase_order', 'order_confirmation', 'other'],
        },
        search: {
          type: 'string',
          description:
            'Words to match against the vendor, PO number, client, project and kind of document — every word must match somewhere. Use THIS for a name when you are not sure whether it is a vendor, a client or a project.',
        },
      },
    },
  },
  {
    name: 'list_vendors',
    description:
      'The studio\'s suppliers: category, contact, how many purchase orders are open with each and what they are worth. Use for "who do we buy from", "which vendor has the most on order", "what is X\'s email".',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Vendor name or category (substring).' },
      },
    },
  },
  {
    name: 'list_purchase_orders',
    description:
      'Purchase orders with vendor, project, amount, status and expected date. Use for "what is on order", "what is arriving this month", "how much have we committed with X", "which orders are late".',
    input_schema: {
      type: 'object',
      properties: {
        vendor: { type: 'string', description: 'Limit to one vendor (substring).' },
        project: { type: 'string', description: 'Limit to one project (substring).' },
        status: {
          type: 'string',
          enum: ['open', 'all', 'draft', 'sent', 'confirmed', 'partial', 'received', 'cancelled'],
          description: "'open' means anything not received or cancelled.",
        },
        late_only: { type: 'boolean', description: 'Only orders past their expected date.' },
      },
    },
  },
  {
    name: 'list_follow_ups',
    description:
      'The follow-up queue — where the system has noticed silence and wants someone chased: vendors who have not replied, client approvals overdue, dates slipping, spec gaps, overdue tasks and escalations. Use for "what is waiting on someone", "who has gone quiet", "what needs chasing".',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'all', 'open', 'drafted', 'sent', 'dismissed', 'done'] },
        type: {
          type: 'string',
          description: 'One follow-up type, e.g. vendor_silence, client_approval_overdue, quote_overdue.',
        },
      },
    },
  },
  {
    name: 'list_drafts',
    description:
      'Reply drafts the system has written and parked in Gmail for a person to review and send. Nothing here has been sent. Use for "what is waiting for me to approve", "did we reply to X".',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Match subject or recipient.' },
      },
    },
  },
  {
    name: 'list_spec_gaps',
    description:
      'Missing specification details that block an order being placed — a finish, dimension or model number with no answer. Use for "what is blocking the order", "what is still TBD".',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Limit to one project (substring).' },
        include_resolved: { type: 'boolean', description: 'Default false — only open gaps.' },
      },
    },
  },
  {
    name: 'list_studio_prompts',
    description:
      "The studio's own prompt library — the prompts Janelle wrote for design direction, moodboards, material selection, finish and FF&E schedules, elevations, reviews and audits. Use it BEFORE writing any design work of your own, so the studio's standard is the one that gets applied. Returns each prompt's title and the inputs it needs.",
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Words to match in the title or description — "moodboard", "finish schedule".' },
      },
    },
  },
  {
    name: 'render_board',
    description:
      "DRAW a presentation board or a rendering, as a picture. FIRST check the studio has not already issued the thing they named — a flooring plan or a schedule is usually one page inside a plan set, and the issued page beats anything drawn fresh; read_document returns a ref that shows that page. Only some of the studio's prompts make one — the elevation + moodboard board, a room rendering, a moodboard page, a materials page, a snapshot retouch — and list_studio_prompts marks them. Use this when someone asks to SEE something: \"make the board\", \"render the kitchen\", \"draw the moodboard\". It needs no project record. Anything the person attached to the question becomes reference imagery, which is how the approved house template gets matched — draw it with whatever they gave you and say what would improve it, rather than refusing until they attach more. Put the ref it returns in the answer's items so they can see it.",
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: "A renderable prompt's title, as list_studio_prompts gave it. Use one when it fits." },
        variables: {
          type: 'object',
          description: 'That prompt\'s inputs, keyed as list_studio_prompts named them.',
          additionalProperties: { type: 'string' },
        },
        brief: {
          type: 'string',
          description:
            'What to draw, in your own words, when NO library prompt fits — a flooring-plan board, a lighting-plan board, anything the library never covered. Write it as you would brief a designer: the room, the page, what goes on it, and every specification the person gave you. The library is a shortcut, not the limit of what can be drawn, so reach for this rather than reporting that no prompt exists.',
        },
        project_id: { type: 'string', description: 'The project this belongs to, so the render is filed against it.' },
      },
    },
  },
  {
    name: 'run_studio_prompt',
    description:
      "Produce studio work by running one of the studio's prompts. This WRITES the moodboard, schedule, direction, review, purchase order or comparison — it is how you make something rather than look something up. It needs NO project record: a room and a direction are enough, and a project that does not exist in the system is not a reason to refuse. Put what comes back in the answer's `document`, whole and unedited.\n\nFILLING THE INPUTS — the rule differs by category, and getting it wrong is costly.\nDESIGN prompts: fill every input from what the person told you, from what you have read, and otherwise from what a senior designer would assume of a room like that. The prompts themselves say to mark an assumption rather than hide it, so an assumed ceiling height is useful work.\nPROCUREMENT and CLIENT prompts (purchase orders, vendor comparisons, FF&E schedules, approval requests): pass ONLY what the person gave you or what you read in the studio's own records. Never supply a PO number, a price, a quantity, a SKU, a lead time, a ship-to address, a date or a vendor contact that was not stated — an invented figure on a purchase order is an order the studio did not place, and an invented price is one it did not agree. Leave the input out entirely and let the prompt mark it TBD; the prompt is written to do that and to list what is missing at the end. If a required input is genuinely unknown, ask the person for it instead of running.",
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: "The prompt's title, exactly as list_studio_prompts gave it." },
        variables: {
          type: 'object',
          description: 'The prompt\'s inputs, keyed as list_studio_prompts named them.',
          additionalProperties: { type: 'string' },
        },
        project_id: { type: 'string', description: 'The project this belongs to, when there is one, so the run is filed against it.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'get_weekly_report',
    description:
      "The latest weekly report: the written summary and the figures behind it. Use for \"how was last week\", \"what did the report say\".",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_studio_rules',
    description:
      'The studio\'s own settings: how many days of vendor silence before a nudge, how long a client approval may sit, when something escalates to the principal, and which day the weekly report runs. Use for "how long do we wait before chasing".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_recent_activity',
    description:
      'The audit trail — what the system and the team have actually done: email ingested, tasks created, roles changed, follow-ups sent. Use for "what has happened today", "who changed that", "has the system run".',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many entries, newest first. Default 20.' },
      },
    },
  },
  {
    name: 'get_ai_spend',
    description:
      'What the studio has spent on Claude recently, by job and in total. Use for "what is this costing", "how much have we spent on AI".',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Window in days. Default 30.' },
      },
    },
  },
  {
    name: 'propose_task',
    description:
      'Prepare a new task for the Tasks board of this system — the task list, the task module, "the board". Does NOT save it: the person confirms by saying yes or pressing Confirm, and respond_to_proposal saves it. Use when asked for something to be done, added to the list, or delegated. Names are matched to the team for you; if the person cannot be matched you are told to ask.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Imperative, names the counterparty. Max 80 chars.' },
        detail: { type: 'string' },
        kind: { type: 'string', enum: [...TASK_KINDS] },
        assignee_name: { type: 'string', description: 'Who should own it, as said — spelling slips are matched. Omit to route it by role.' },
        project: { type: 'string' },
        due_date: { type: 'string', description: 'ISO date YYYY-MM-DD, worked out from what they said ("Friday", "end of next week").' },
        email_id: {
          type: 'string',
          description:
            'When the task comes from an email, the id of that email from search_email or read_email. It links the task to the email and brings its project and vendor with it.',
        },
        next_step: { type: 'string', description: 'The single concrete next action, in a few words.' },
      },
      required: ['title', 'kind'],
    },
  },

  // ── Live Gmail and Drive ──────────────────────────────────
  // The tools above read what ingestion stored: the last few days of mail,
  // classified and linked to projects. These read the studio's Google
  // account itself — any message, any attachment, any file, however old.
  {
    name: 'find_attachments',
    description:
      'Find email attachments in the studio\'s LIVE Gmail and hand them over as files. Use this whenever someone asks for an attachment, a file someone sent, "the PDF from X", "the drawings Brianna emailed", "the photos the client sent". One call searches and returns every matching file, each with a ref — put those refs in your answer and the person gets Download and Open buttons. Searches the whole mailbox, not just recent mail.',
    input_schema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Words to match: a project, a subject, what the file is. Gmail search operators work too.',
        },
        from: { type: 'string', description: 'Sender name or address.' },
        filename: { type: 'string', description: 'Part of the file name, or a type such as "pdf", "xlsx", "jpg".' },
        days: { type: 'number', description: 'Only mail from the last N days.' },
      },
    },
  },
  {
    name: 'gmail_search',
    description:
      'Search the studio\'s LIVE Gmail — the whole mailbox, including old mail and anything never ingested. Use when search_email (stored mail only) finds nothing, or the question is about older mail, sent mail, or a specific thread. Returns message summaries with a message_id for gmail_read.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Gmail search syntax: from:, to:, subject:, has:attachment, filename:, newer_than:7d, older_than:, in:sent, "exact phrase". Plain words work too.',
        },
        max: { type: 'number', description: 'At most this many messages (default 10, max 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gmail_read',
    description:
      'Read one message from LIVE Gmail in full: the text, every link, and EVERY attachment of any type, each returned as a file with a ref. Pass a message_id from gmail_search.',
    input_schema: {
      type: 'object',
      properties: { message_id: { type: 'string', description: 'The message_id from gmail_search.' } },
      required: ['message_id'],
    },
  },
  {
    name: 'drive_search',
    description:
      'Search the studio\'s Google Drive — any file, by name AND by what is written inside it. Use for drawings, finish schedules, spreadsheets, proposals, photos, contracts: "the Harborview floor plan", "our latest price list". Every file comes back with a ref for handing it over.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Words in the file name or its contents.' },
        kind: {
          type: 'string',
          enum: ['pdf', 'image', 'document', 'spreadsheet', 'presentation', 'folder'],
          description: 'Only files of this kind.',
        },
        folder: { type: 'string', description: 'Only inside the folder with this name.' },
        max: { type: 'number', description: 'At most this many files (default 10, max 25).' },
      },
    },
  },
  {
    name: 'drive_read',
    description:
      'Read what a Drive file SAYS — a Google Doc, a Sheet, an uploaded .xlsx workbook, or a text file — to answer questions about its contents. Pass a file_id from drive_search. A PDF or image cannot be read this way: pass its ref to read_document instead.',
    input_schema: {
      type: 'object',
      properties: { file_id: { type: 'string', description: 'The file_id from drive_search.' } },
      required: ['file_id'],
    },
  },
  {
    name: 'propose_draft',
    description:
      'Prepare an email for someone to send. Does NOT send it, and does not save it until the person confirms — it then lands in Drafts AND in the studio\'s real Gmail Drafts, ready to open, edit and send from there. Use when asked to write, reply to or draft an email.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient address(es), comma-separated.' },
        cc: { type: 'string', description: 'Cc address(es), comma-separated.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'The message itself, in plain text, signed off as the studio.' },
        reply_to_email_id: {
          type: 'string',
          description:
            'The id (from search_email or read_email) of the email this replies to. Set it whenever this is a reply to a specific message you looked up, so the Gmail draft lands inside that actual conversation instead of arriving as a disconnected new message.',
        },
      },
      required: ['subject', 'body'],
    },
  },
  {
    name: 'respond_to_proposal',
    description:
      'Save or drop something you prepared EARLIER, now that the person has answered it. When their message agrees — "yes", "confirmed", "go ahead", "add it", "do it", "yes and add it to the list", typed or spoken — call this with decision "confirm" FIRST, before anything else they asked. When they decline — "no", "cancel", "leave it" — use "cancel". If they want it changed ("yes but make it Monday"), do not confirm: prepare it again with the change and cancel the old one. Only the proposals listed as waiting can be answered; one prepared in this same reply cannot, because the person has not seen it.',
    input_schema: {
      type: 'object',
      properties: {
        proposal: { type: 'string', description: 'Which waiting proposal: "#1", "#2"…' },
        decision: { type: 'string', enum: ['confirm', 'cancel'] },
      },
      required: ['proposal', 'decision'],
    },
  },
  {
    name: 'read_document',
    description:
      'Read what a PDF, an image or a SPREADSHEET says and shows, to answer a question about its contents — "from this PDF give me the living room furniture and decor", "what finishes are in the Lemon proposal", "what flooring is scheduled", "what does page 4 show". A schedule, an FF&E list or a vendor\'s quote as .xlsx opens here and its cells are read. Pass the file ref (F1, F2…) of a file already in the conversation or one you just found with find_attachments, search_documents, read_email or drive_search. ALWAYS read a file before telling someone what is in it: naming a schedule and saying the selections "are listed in it" is not an answer when you could have opened it. Returns the answer, the individual findings, and a ref that shows the relevant pages themselves as images — put that ref in items.',
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'The file ref, e.g. "F1".' },
        question: { type: 'string', description: 'What to find in it, in the person’s own terms.' },
      },
      required: ['file', 'question'],
    },
  },
  {
    name: 'propose_task_update',
    description:
      'Prepare a change to a task ALREADY on the board: give it an owner, set or move its due date, change its status, or set its next step. Like propose_task it saves nothing until the person says yes or presses Confirm. Use it for "assign that to Denish", "make it due Friday", "mark it done" — and when an email they want a task for already has one.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task id, from list_tasks, search_email or read_email.' },
        assignee_name: { type: 'string', description: 'The new owner, as said — spelling slips are matched.' },
        due_date: { type: 'string', description: 'The new due date, ISO YYYY-MM-DD.' },
        status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'done', 'cancelled'] },
        next_step: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'make_image',
    description:
      "MAKE a picture: TRANSFORM one the person attached — a sketch made photoreal, a plan rendered, a room restyled — or draw one from words. Whenever someone attaches a picture and asks for it changed, rendered or visualised, use this: the attachment is held to and keeps its proportions. Never answer that in words, and never refuse it as a board. Use render_board for the house-template boards; for a deliverable the studio has already issued, find and hand over the real page instead. Put the ref it returns in the answer's items.",
    input_schema: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description:
            "A description of the PICTURE, written for whoever is drawing it — never your message to the person. Nothing like \"Here's a complete interior design\" or \"I've created\": that is narration, and it goes into the render as words. Describe only what is in the frame: the room, the pieces and where they sit, the materials and finishes, the light and time of day, the camera position. Pass the person's own wording when they wrote a full brief — do not paraphrase a careful prompt. When they were brief, fill it out as a photographer's brief and say what you assumed.",
        },
        aspect_ratio: {
          type: 'string',
          description: '16:9, 4:3, 3:4, 1:1, 9:16. Ignored when transforming an attachment, which keeps its own shape.',
        },
        resolution: { type: 'string', enum: ['1K', '2K'], description: '2K for anything a client will see. Default 2K.' },
        project_id: { type: 'string', description: 'The project this belongs to, so it is filed against it.' },
      },
      required: ['brief'],
    },
  },
  {
    name: 'make_video',
    description:
      "START a short video clip (a few seconds) from a brief, or animate a still the person attached. It does NOT finish inside this answer: it returns a job that renders in the background, and the clip appears on screen by itself when it is ready. Say it is rendering and roughly how long — never say it is done, and never put a file ref in the items, because there is no video yet. It costs real money by the second, so it is prepared as a proposal the person confirms, exactly like a task.",
    input_schema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'What should happen in the clip: the room, the move, the light.' },
        seconds: { type: 'number', description: 'How long, in seconds. Default 6; the studio caps it.' },
        aspect_ratio: { type: 'string', description: '16:9, 1:1, 9:16. Default 16:9.' },
        from_attachment: {
          type: 'boolean',
          description: 'True to animate the still the person attached to this question rather than drawing from words.',
        },
        project_id: { type: 'string', description: 'The project this belongs to, so it is filed against it.' },
      },
      required: ['brief'],
    },
  },
  ANSWER_TOOL,
];

/**
 * Tools that act as the studio's Google account rather than as the person
 * asking.
 *
 * Everything else runs on the caller's own database client, so row-level
 * security decides what they see. These cannot: Gmail and Drive see the
 * whole account — the principal's own — which holds far more than studio
 * work, and reads in this system are open to every role by design. So the
 * live tools are held to the roles that already read the full audit trail.
 * Everyone else still gets attachments from mail and documents they can
 * already see, through read_email and search_documents.
 */
const LIVE_GOOGLE_TOOLS = ['find_attachments', 'gmail_search', 'gmail_read', 'drive_search', 'drive_read'];

/** What each tool reads, in the studio's words, for "Checked:" under an answer. */
const TOOL_SOURCES: Record<string, string> = {
  list_projects: 'projects',
  get_project_status: 'projects',
  list_tasks: 'tasks',
  propose_task: 'tasks',
  respond_to_proposal: 'tasks',
  propose_task_update: 'tasks',
  read_document: 'the document',
  list_team: 'the team',
  get_today: "today's digest",
  search_email: 'email',
  read_email: 'email',
  search_documents: 'documents',
  list_vendors: 'vendors',
  list_purchase_orders: 'purchase orders',
  list_follow_ups: 'follow-ups',
  list_drafts: 'drafts',
  list_spec_gaps: 'spec gaps',
  get_weekly_report: 'the weekly report',
  list_studio_prompts: 'the prompt library',
  run_studio_prompt: 'the prompt library',
  render_board: 'the prompt library',
  make_image: 'Grok',
  make_video: 'Grok',
  get_studio_rules: "the studio's rules",
  get_recent_activity: 'the audit log',
  get_ai_spend: 'AI spend',
  find_attachments: 'Gmail',
  gmail_search: 'Gmail',
  gmail_read: 'Gmail',
  drive_search: 'Google Drive',
  drive_read: 'Google Drive',
  propose_draft: 'drafts',
};

/**
 * The tool list with a cache breakpoint on its last entry.
 *
 * Measured after caching the system prompt alone: only a quarter of the
 * input was being read from cache, because the system prompt is not stable —
 * it carries the page they are on, anything pending, and how they asked. The
 * tools ARE stable, byte for byte, on every turn of every conversation for
 * every person, and they are the larger half. Marking the last one caches
 * the whole tool block, which sits at the very front of the prefix.
 *
 * Built once: rebuilding the array per call would defeat nothing, but it
 * would allocate the same 25 KB on every turn.
 */
const CACHED_TOOLS: Anthropic.Tool[] = TOOLS.map((tool, i) =>
  i === TOOLS.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' as const } } : tool,
);

/** What each tool is doing, said the way a person would say it while they work. */
const TOOL_STATUS: Record<string, string> = {
  list_projects: 'Looking through the projects',
  get_project_status: 'Pulling up the project',
  list_tasks: 'Checking the task board',
  list_team: 'Checking who is carrying what',
  get_today: "Reading this morning's digest",
  search_email: 'Looking through the stored email',
  read_email: 'Reading the email',
  search_documents: 'Looking through the documents',
  list_vendors: 'Checking the vendors',
  list_purchase_orders: 'Checking the purchase orders',
  list_follow_ups: 'Checking the follow-ups',
  list_drafts: 'Checking the drafts',
  list_spec_gaps: 'Checking the spec gaps',
  get_weekly_report: 'Reading the weekly report',
  list_studio_prompts: "Checking the studio's prompts",
  run_studio_prompt: 'Writing it, to the studio\'s prompt',
  render_board: 'Drawing the board',
  make_image: 'Drawing it',
  make_video: 'Starting the clip',
  get_studio_rules: "Checking the studio's rules",
  get_recent_activity: 'Reading the audit log',
  get_ai_spend: 'Adding up the AI spend',
  find_attachments: 'Searching Gmail for attachments',
  gmail_search: 'Searching Gmail',
  gmail_read: 'Reading the message in Gmail',
  drive_search: 'Searching Google Drive',
  drive_read: 'Reading the file in Drive',
  propose_task: 'Preparing the task',
  respond_to_proposal: 'Saving it',
  propose_task_update: 'Preparing the change',
  read_document: 'Reading the document',
  propose_draft: 'Writing the draft',
};

// ── Shaping the answer ──────────────────────────────────────

const ITEM_KINDS: AssistantItemKind[] = [
  'task', 'project', 'purchase_order', 'vendor', 'email', 'document',
  'draft', 'follow_up', 'person', 'report', 'file', 'link', 'note',
];
const TONES: AssistantTone[] = ['neutral', 'good', 'warn', 'crit'];

/**
 * At most this many rows reach the screen; the rest are counted in `more`.
 *
 * Enough for a studio's whole project list in one answer. It used to be
 * eight, when every row was typed out by the model and each one cost
 * seconds; a ref costs a handful of tokens, so the list can be the list.
 */
const MAX_ITEMS = 25;

const text = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';

/**
 * The same, for a field whose newlines are its meaning.
 *
 * `text` flattens every run of whitespace, which is right for a sentence and
 * fatal for Markdown: it turns a moodboard into one unbroken line with the
 * hashes still in it. Here only trailing spaces and runs of blank lines go.
 */
const block = (v: unknown, max: number): string =>
  typeof v === 'string'
    ? v
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, max)
    : '';

/** Optional text: empty becomes null, so the UI can test one thing. */
const maybe = (v: unknown, max: number): string | null => text(v, max) || null;

/**
 * Only a real, absolute web address.
 *
 * A URL is the one field here that gets clicked, so a `javascript:` or
 * `data:` string reaching the page would be an injection through whatever
 * an email happened to contain. Anything that is not plainly http(s) is
 * dropped rather than rendered.
 */
function safeUrl(v: unknown): string | null {
  const raw = text(v, 2000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * One row of an answer, clamped to what the layout can actually hold.
 *
 * A row with a known `ref` is the registered record, exactly: its title,
 * its figures, its file. The model may add judgement on top — a `meta`
 * like "worst", a tone — but never replaces the facts, because the facts
 * are the reason the ref exists. A ref the registry has never seen is
 * dropped rather than rendered as a row of nothing: it was invented.
 */
function toItem(raw: unknown, refs?: RefRegistry): AssistantItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const tone = TONES.includes(r.tone as AssistantTone) ? (r.tone as AssistantTone) : undefined;

  const ref = text(r.ref, 16);
  if (ref) {
    const known = refs?.get(ref);
    if (!known) return null;
    return {
      ...known,
      detail: maybe(r.detail, 160) ?? known.detail ?? null,
      meta: maybe(r.meta, 40) ?? known.meta ?? null,
      tone: tone ?? known.tone ?? 'neutral',
    };
  }

  const title = text(r.title, 120);
  if (!title) return null;

  const kind = ITEM_KINDS.includes(r.kind as AssistantItemKind)
    ? (r.kind as AssistantItemKind)
    : 'note';

  // A file with no ref has no grant behind it, so it cannot be downloaded;
  // it is shown as what it is — a named thing — rather than as a broken
  // button.
  return {
    kind: kind === 'file' ? 'note' : kind,
    id: maybe(r.id, 64),
    title,
    detail: maybe(r.detail, 160),
    meta: maybe(r.meta, 40),
    url: safeUrl(r.url),
    tone: tone ?? 'neutral',
  };
}

/**
 * Turn what the model passed to `answer` into the answer the app renders.
 *
 * Everything here is defensive on purpose: this is the one place a tool
 * input becomes a screen, and a missing `lead` or a forty-row list would
 * otherwise be the person's problem rather than ours.
 */
function toAnswer(input: Record<string, unknown>, used: string[], refs?: RefRegistry): AssistantAnswer {
  const all = Array.isArray(input.items)
    ? input.items.map((i) => toItem(i, refs)).filter((i): i is AssistantItem => i !== null)
    : [];
  const items = all.slice(0, MAX_ITEMS);

  // Trust the model's own count only as far as it goes past what we cut.
  // It reports what it left out; we also left some out, and the reader
  // needs the total of both.
  const claimed = Number(input.more);
  const dropped = all.length - items.length;
  const more = Math.max(0, dropped + (Number.isFinite(claimed) && claimed > 0 ? Math.floor(claimed) : 0));

  const lead = text(input.lead, 800) || 'I could not put that into words — ask me again?';
  // Falling back to the lead is right: an answer that is never spoken is
  // better than one that is spoken as an empty string.
  const speech = text(input.speech, 900) || lead;

  // Generous, because this is the work itself rather than a label for it:
  // a finish schedule for a whole house is legitimately thousands of words.
  const document = block(input.document, 40_000) || null;

  return {
    lead,
    items,
    more,
    caveat: maybe(input.caveat, 240),
    speech,
    document,
    documentTitle: document ? maybe(input.documentTitle, 120) : null,
    sources: sourcesOf(used),
    suggestions: cleanSuggestions(input.suggestions),
  };
}

/**
 * The produced work, carried into the answer when the model did not carry
 * it itself — or carried only a fragment of it.
 *
 * Longer wins, which is the honest rule here: the document IS the artefact,
 * and a shorter one in its place is the model having summarised away the
 * very thing that was asked for.
 */
function withProduced(answer: AssistantAnswer, produced: ProducedWork | null): AssistantAnswer {
  if (!produced) return answer;
  if ((answer.document ?? '').length >= produced.body.length) return answer;
  return {
    ...answer,
    document: produced.body,
    documentTitle: answer.documentTitle || produced.title,
  };
}

/** At most three distinct, short, plain questions. */
function cleanSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw) {
    const q = text(s, 80).replace(/^[-•*\d.)\s]+/, '');
    const key = q.toLowerCase();
    if (!q || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length === 3) break;
  }
  return out;
}

/** The distinct records consulted, in the order they were first read. */
function sourcesOf(used: string[]): string[] {
  const out: string[] = [];
  for (const name of used) {
    const label = TOOL_SOURCES[name];
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * An answer built from ordinary text, for when the model replies without
 * calling `answer`.
 *
 * It still happens — a one-word greeting, a clarifying question — and the
 * UI must never be handed a half-empty answer. Lines that were written as
 * a list become rows, so even the fallback is laid out rather than run
 * together as a paragraph.
 */
function answerFromText(reply: string, used: string[]): AssistantAnswer {
  const lines = reply.split('\n').map((l) => l.trim()).filter(Boolean);
  const bullet = /^[-*•]\s+/;

  const lead = lines.filter((l) => !bullet.test(l)).join(' ');
  const items = lines
    .filter((l) => bullet.test(l))
    .slice(0, MAX_ITEMS)
    .map((l) => {
      const body = l.replace(bullet, '');
      const url = body.match(/https?:\/\/\S+/)?.[0] ?? null;
      return toItem({
        kind: url ? 'link' : 'note',
        title: url ? body.replace(url, '').replace(/[—–-]\s*$/, '').trim() || url : body,
        url,
      });
    })
    .filter((i): i is AssistantItem => i !== null);

  // Three fallbacks deep, because an empty bubble is the one outcome the
  // screen cannot render: the prose without its list, then the whole
  // thing, then something rather than nothing.
  const headline = text(lead, 800) || text(reply, 800) || 'I do not have an answer for that one.';
  const spoken = lines.map((l) => l.replace(bullet, '')).join('. ');

  return {
    lead: headline,
    items,
    more: 0,
    caveat: null,
    speech: text(spoken, 900) || headline,
    sources: sourcesOf(used),
  };
}

/** The answer, flattened back to the one string the history stores. */
function answerToText(answer: AssistantAnswer): string {
  const rows = answer.items.map((i) => {
    const right = [i.detail, i.meta].filter(Boolean).join(' · ');
    return `- ${i.title}${right ? ` — ${right}` : ''}${i.url ? `\n  ${i.url}` : ''}`;
  });
  if (answer.more > 0) rows.push(`- …and ${answer.more} more`);

  // The document travels with the turn: without it, "make the palette
  // warmer" reaches a model that can no longer see the palette.
  const document = answer.document
    ? [answer.documentTitle ? `## ${answer.documentTitle}` : null, answer.document].filter(Boolean).join('\n\n')
    : null;

  return [answer.lead, rows.join('\n'), document, answer.caveat].filter(Boolean).join('\n\n');
}

// ── Rows, formatted once ────────────────────────────────────
// Each record type is laid out in exactly one place, so a project reads the
// same whether it came from "list our projects" or "what is on order", and
// a list of them lines up as a table because every row carries the same
// labels in the same order.

const usd = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? '—'
    : `$${Math.round(Number(n)).toLocaleString('en-US')}`;

/** "Sep 12", or "Sep 12, 2025" when it is not this year. */
function day(iso: string | null | undefined): string {
  if (!iso) return '—';
  // A bare date is a calendar day, not an instant: read at noon UTC so no
  // timezone can move it to the day before.
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

function bytes(n: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const daysSince = (isoDay: string) =>
  Math.floor((Date.now() - new Date(`${isoDay}T12:00:00Z`).getTime()) / 86400_000);

const field = (label: string, value: string | null | undefined): AssistantField => ({
  label,
  value: value && String(value).trim() ? String(value) : '—',
});

/** What a file is, in the words a person uses for it. */
function fileKind(name: string, mimeType: string): string {
  const native: Record<string, string> = {
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.drawing': 'Google Drawing',
    'application/vnd.google-apps.folder': 'Folder',
  };
  if (native[mimeType]) return native[mimeType];
  const ext = name.match(/\.([a-z0-9]{1,5})$/i)?.[1];
  if (ext) return ext.toUpperCase();
  return mimeType.split('/')[1]?.toUpperCase() ?? 'File';
}

function projectRow(p: {
  id: string; name: string; client_name: string | null; stage: string; status: string;
  target_install: string | null; on_order: number; open_pos: number; spec_gaps: number;
}): AssistantItem {
  return {
    kind: 'project',
    id: p.id,
    title: p.name,
    fields: [
      field('Client', p.client_name),
      field('Stage', STAGE_LABELS[p.stage as ProjectStage] ?? p.stage),
      field('Install', day(p.target_install)),
      field('On order', p.on_order ? usd(p.on_order) : '—'),
      // "Open orders", not "Open POs": column labels are set in capitals, and
      // "OPEN POS" reads as a word that is not there.
      field('Open orders', String(p.open_pos)),
    ],
    // Only when it says something: an active project is the normal case.
    meta: p.status === 'on_hold' ? 'On hold' : p.status === 'archived' ? 'Archived' : null,
    tone: p.spec_gaps > 0 ? 'warn' : 'neutral',
  };
}

export function taskRow(t: {
  id: string; title: string; status: string; due_date: string | null;
  owner: string; project: string | null;
}): AssistantItem {
  const today = new Date().toISOString().slice(0, 10);
  const late = Boolean(t.due_date && t.due_date < today && LIVE.includes(t.status));
  return {
    kind: 'task',
    id: t.id,
    title: t.title,
    fields: [
      field('Owner', t.owner),
      field('Project', t.project),
      field('Due', day(t.due_date)),
      field('Status', t.status.replace(/_/g, ' ')),
    ],
    meta: late && t.due_date ? `${daysSince(t.due_date)}d late` : null,
    tone: t.status === 'blocked' ? 'crit' : late ? 'warn' : 'neutral',
  };
}

export function purchaseOrderRow(p: {
  id: string; po: string | null; vendor: string; project: string; amount: number | null;
  expected: string | null; status: string; late: boolean;
}): AssistantItem {
  return {
    kind: 'purchase_order',
    id: p.id,
    title: p.po ?? 'PO without a number',
    fields: [
      field('Vendor', p.vendor),
      field('Project', p.project),
      field('Amount', usd(p.amount)),
      field('ETA', day(p.expected)),
      field('Status', p.status.replace(/_/g, ' ')),
    ],
    meta: p.late && p.expected ? `${daysSince(p.expected)}d late` : null,
    tone: p.late ? 'warn' : p.status === 'received' ? 'good' : 'neutral',
  };
}

function personRow(p: {
  id: string | null; name: string; email: string | null; role: UserRole | null;
  seat: Seat | null; live_tasks: number; has_account: boolean;
}): AssistantItem {
  return {
    kind: 'person',
    ...(p.id ? { id: p.id } : {}),
    title: p.name,
    ...(p.has_account ? {} : { meta: 'No account yet', tone: 'warn' as const }),
    fields: [
      field('Seat', p.seat ? SEATS[p.seat].label : null),
      field('Role', p.role ? ROLE_LABELS[p.role] : null),
      field('Email', p.email),
      field('Live tasks', p.has_account ? String(p.live_tasks) : null),
    ],
  };
}

function vendorRow(v: {
  id: string; name: string; category: string | null; contacts: unknown;
  open_orders: number; on_order: number;
}): AssistantItem {
  const first = Array.isArray(v.contacts) ? (v.contacts[0] as { email?: string; name?: string } | undefined) : undefined;
  return {
    kind: 'vendor',
    id: v.id,
    title: v.name,
    fields: [
      field('Category', v.category),
      field('Contact', first?.email ?? first?.name ?? null),
      field('Open orders', String(v.open_orders)),
      field('On order', v.on_order ? usd(v.on_order) : '—'),
    ],
  };
}

/**
 * A download grant, or null when one cannot be minted.
 *
 * Minting needs TOKEN_ENCRYPTION_KEY. Without it the row is still shown,
 * with its link to Gmail or Drive — a missing key is a setup gap, and it
 * should cost the button, not the answer.
 */
function grant(seal: () => string): string | null {
  try {
    return seal();
  } catch (err) {
    console.error('[assistant] could not mint a file grant:', (err as Error).message);
    return null;
  }
}

/** An email attachment, ready to hand over. */
function gmailFileRow(
  orgId: string,
  messageId: string,
  att: { filename: string; mimeType: string; attachmentId: string; size: number },
  context: { from?: string | null; subject?: string | null; receivedAt?: string | null },
): AssistantItem {
  const token = grant(() =>
    sealFileGrant({
      source: 'gmail',
      orgId,
      messageId,
      attachmentId: att.attachmentId,
      name: att.filename,
      mimeType: att.mimeType,
    }),
  );
  const webUrl = gmailMessageUrl(messageId);
  const sender = context.from ? addressOf(context.from) : null;
  return {
    kind: 'file',
    title: att.filename,
    detail: [sender && `From ${sender}`, context.subject].filter(Boolean).join(' · ') || null,
    fields: [
      field('Type', fileKind(att.filename, att.mimeType)),
      field('Size', bytes(att.size)),
      field('Received', day(context.receivedAt)),
    ],
    file: token
      ? {
          name: att.filename,
          mimeType: att.mimeType,
          size: att.size,
          source: 'gmail',
          token,
          downloadable: !att.size || att.size <= MAX_RELAY_BYTES,
          webUrl,
        }
      : null,
    url: token ? null : webUrl,
  };
}

/** A Drive file, ready to hand over — exported first if it is a Google Doc or Sheet. */
function driveFileRow(orgId: string, hit: DriveHit): AssistantItem {
  const shape = downloadShape(hit.name, hit.mimeType);
  const token = grant(() =>
    sealFileGrant({ source: 'drive', orgId, fileId: hit.id, mimeType: hit.mimeType, name: hit.name }),
  );
  return {
    kind: 'file',
    title: hit.name,
    fields: [
      field('Type', fileKind(hit.name, hit.mimeType)),
      field('Size', bytes(hit.size)),
      field('Modified', day(hit.modifiedTime)),
    ],
    file: token
      ? {
          name: shape.name,
          mimeType: shape.mimeType,
          size: hit.size,
          source: 'drive',
          token,
          // An export has no size until it is made; let it try, and the
          // endpoint says so if it turns out too large.
          downloadable: shape.exported || !hit.size || hit.size <= MAX_RELAY_BYTES,
          webUrl: hit.webViewLink,
        }
      : null,
    url: token ? null : hit.webViewLink,
  };
}

// ── Tool implementations ────────────────────────────────────

type ToolOutput = Record<string, unknown> | Record<string, unknown>[];

const ilike = (s: string) => `%${s.replace(/[%_]/g, '')}%`;

/**
 * The words of a search phrase, for matching them one at a time.
 *
 * A phrase matched whole found nothing the moment anyone typed a full name:
 * "Brianna Johnson" appears in no column of her own email, because the
 * sender is stored as `brianna@janelleinteriors.com` and the subject is
 * about the project. Requiring every word to appear SOMEWHERE — the address
 * carrying the first name, the body the surname — finds it, while still
 * excluding rows that merely share one common word.
 *
 * Capped at four words so one rambling question cannot build a query of
 * unbounded size.
 */
/**
 * Words a request for a document is wrapped in, which say nothing about
 * WHICH document. "Send me the PDF attachment of the quote from Ashcroft"
 * is about Ashcroft and a quote; the rest would fail every match.
 */
const DOCUMENT_FILLER = new Set([
  'the', 'a', 'an', 'of', 'for', 'from', 'to', 'on', 'by', 'me', 'my', 'our', 'us', 'please',
  'send', 'get', 'find', 'show', 'give', 'copy', 'latest', 'last', 'recent', 'new',
  'file', 'files', 'pdf', 'pdfs', 'document', 'documents', 'doc', 'docs',
  'attachment', 'attachments', 'attached', 'email', 'emailed',
]);

function searchWords(phrase: string): string[] {
  return phrase
    .split(/\s+/)
    .map((w) => w.replace(/[%_]/g, '').trim())
    .filter((w) => w.length >= 2)
    .slice(0, 4);
}

/**
 * Apply a phrase across several columns, one word at a time.
 *
 * Each `.or()` is ANDed with the last by PostgREST, so this reads as
 * "every word appears in at least one of these columns".
 */
function matchPhrase<T>(query: T, phrase: string, columns: string[]): T {
  let q = query as unknown as { or(filter: string): unknown };
  for (const word of searchWords(phrase)) {
    q = q.or(columns.map((c) => `${c}.ilike.${ilike(word)}`).join(',')) as typeof q;
  }
  return q as unknown as T;
}

/**
 * Unwrap a Supabase result, turning a database error into something the
 * model must report rather than silently read as "no records".
 *
 * This matters more than it looks: a missing table or a denied policy
 * returns no rows, and without this the assistant answers "there are no
 * open tasks" with total confidence. Saying "I could not read the tasks"
 * is the difference between a tool that can be trusted and one that
 * cannot.
 */
class ToolDataError extends Error {}

/**
 * A call to Google, with every failure made into one the model must report.
 *
 * Google fails in ways a database does not — a revoked grant, a message
 * deleted since it was listed, a shared drive someone lost access to — and
 * each of those, left to throw, reaches the model as "Error: …" that it is
 * free to read as "nothing found". Worded here as what happened and what
 * fixes it.
 */
async function googleCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ToolDataError) throw err;
    if (isGoogleAuthFailure(err)) {
      throw new ToolDataError(
        "Google needs reconnecting — the studio's grant was revoked or has expired, and the principal reconnects it in Settings → Integrations",
      );
    }
    const e = err as { code?: number | string; status?: number; message?: string };
    const status = Number(e.code ?? e.status);
    if (status === 404) throw new ToolDataError('That message or file no longer exists in Google');
    if (status === 403) throw new ToolDataError(`Google refused access (${e.message ?? 'permission denied'})`);
    throw new ToolDataError(`Could not reach Google (${e.message ?? 'unknown error'})`);
  }
}

async function rows<T = Record<string, unknown>>(
  q: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  what: string,
): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new ToolDataError(`Could not read ${what}: ${error.message}`);
  return data ?? [];
}

async function maybeRow<T = Record<string, unknown>>(
  q: PromiseLike<{ data: T | null; error: { message: string } | null }>,
  what: string,
): Promise<T | null> {
  const { data, error } = await q;
  if (error) throw new ToolDataError(`Could not read ${what}: ${error.message}`);
  return data;
}

/** The task each email raised, if any — by email id. */
async function tasksForEmails(
  db: SupabaseClient,
  ids: string[],
): Promise<Map<string, { task_id: string; title: string; owner: string; due: string | null; status: string }>> {
  const out = new Map<string, { task_id: string; title: string; owner: string; due: string | null; status: string }>();
  if (!ids.length) return out;
  const { data } = await db
    .from('tasks')
    .select('id, title, status, due_date, source_email_id, profiles(full_name)')
    .in('source_email_id', ids.slice(0, 100));
  for (const row of (data ?? []) as unknown as {
    id: string; title: string; status: string; due_date: string | null; source_email_id: string;
    profiles: { full_name: string | null } | null;
  }[]) {
    out.set(row.source_email_id, {
      task_id: row.id,
      title: row.title,
      owner: row.profiles?.full_name ?? 'nobody',
      due: row.due_date,
      status: row.status,
    });
  }
  return out;
}

/**
 * Documents already in the system — parsed quotes and order confirmations,
 * from Drive and from email attachments — each handed over as a file.
 *
 * Runs on the caller's own database client, so it is open to every role
 * that can see documents, and it needs no live Google search to FIND a file.
 * That is why find_attachments falls back to it: a Gmail grant that needs
 * reconnecting should cost the search of old mail, not the quote that is
 * already sitting here.
 */
async function findStoredDocuments(
  ctx: AssistantContext,
  refs: RefRegistry,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { db } = ctx;
    let q = db
      .from('documents')
      .select('id, type, parsed_json, confidence, created_at, drive_file_id, projects(name)')
      .order('created_at', { ascending: false })
      .limit(40);
    if (input.type) q = q.eq('type', String(input.type));

    let list = (await rows(q, 'documents')) as unknown as {
      id: string; type: string; confidence: number | null; created_at: string;
      drive_file_id: string | null;
      parsed_json: {
        vendor?: string | null; po_number?: string | null; total?: number | null;
        client?: string | null; eta?: string | null; order_date?: string | null;
        line_items?: { description: string; qty: number; unit_price: number | null }[];
      } | null;
      projects: { name: string } | null;
    }[];

    // Matched word by word, not as one phrase. The phrase had to appear
    // whole inside the vendor name or PO number, so "Ashcroft Mill quote"
    // — the way anyone actually asks — found nothing, because "quote" is
    // not part of the vendor's name. The assistant then said the vendor
    // did not exist. Every meaningful word must appear somewhere in what
    // the document is; the words people wrap a request in are ignored.
    // Filler goes BEFORE the cap: capped first, "send me the Ashcroft Mill
    // quote" kept send, me, the, ashcroft and threw the useful words away.
    const wordsOf = (v: unknown) =>
      String(v ?? '')
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/[,.?!;:"()]/g, ''))
        .filter((w) => w.length >= 2 && !DOCUMENT_FILLER.has(w))
        .slice(0, 6);

    // "quotes" should find a quote, and "Ashcroft Mills" the Ashcroft Mill.
    const hasWord = (hay: string, w: string) =>
      hay.includes(w) || (w.length > 3 && w.endsWith('s') && hay.includes(w.slice(0, -1)));

    const matchesAll = (hay: string, needle: unknown) => wordsOf(needle).every((w) => hasWord(hay, w));

    const haystack = (d: (typeof list)[number]) =>
      [
        d.parsed_json?.vendor,
        d.parsed_json?.po_number,
        d.parsed_json?.client,
        d.projects?.name,
        d.type.replace(/_/g, ' '),
        d.drive_file_id?.startsWith('gmail:') ? 'email attachment' : 'drive',
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    const everything = list;
    if (input.project) list = list.filter((d) => matchesAll((d.projects?.name ?? '').toLowerCase(), input.project));
    if (input.vendor) list = list.filter((d) => matchesAll((d.parsed_json?.vendor ?? '').toLowerCase(), input.vendor));
    if (input.search) list = list.filter((d) => matchesAll(haystack(d), input.search));

    // A name is often put in the wrong field — "Ashcroft Mill" asked for as
    // a project when it is the vendor. The field-exact filters then find
    // nothing and the assistant says the thing does not exist, which is
    // the worst answer it can give. So when they come up empty, the same
    // words are tried against everything the document is, and the result
    // says it was widened.
    let widened: string | null = null;
    if (!list.length && (input.project || input.vendor)) {
      const terms = [input.project, input.vendor, input.search].filter(Boolean).join(' ');
      const loose = everything.filter((d) => matchesAll(haystack(d), terms));
      if (loose.length) {
        list = loose;
        widened = `Nothing matched "${terms}" in the field you gave, but these match it elsewhere — as the vendor, client, PO number or project. Hand them over if they are what was asked for.`;
      }
    }

    return {
      note: [
        widened,
        'Amounts are US dollars. Each document has a ref: answer with it to hand the file itself over, with Download and Open buttons.',
      ]
        .filter(Boolean)
        .join(' '),
      total: list.length,
      documents: list.slice(0, 12).map((d) => {
        const source = d.drive_file_id ?? '';
        const p = d.parsed_json ?? {};

        // The original, as a file the person can take. Drive files carry a
        // bare file id; email attachments are stored as
        // "gmail:<messageId>:<attachmentId>". Only parsed PDFs are ever
        // stored here, and no filename was kept, so one is made from what
        // the document turned out to be.
        const filename = `${d.type.replace(/_/g, ' ')}${p.vendor ? ` - ${p.vendor}` : ''}${p.po_number ? ` ${p.po_number}` : ''}.pdf`;
        let fileRef: string | null = null;
        let link: string | null = null;
        if (source.startsWith('gmail:') && ctx.orgId) {
          const [messageId, ...rest] = source.slice('gmail:'.length).split(':');
          const attachmentId = rest.join(':');
          link = gmailMessageUrl(messageId);
          if (messageId && attachmentId) {
            const row = gmailFileRow(
              ctx.orgId,
              messageId,
              { filename, mimeType: 'application/pdf', attachmentId, size: 0 },
              { receivedAt: d.created_at },
            );
            row.detail = [d.projects?.name, p.total != null ? usd(p.total) : null].filter(Boolean).join(' · ') || null;
            fileRef = refs.add('F', row);
          }
        } else if (source && ctx.orgId) {
          link = `https://drive.google.com/file/d/${source}/view`;
          const row = driveFileRow(ctx.orgId, {
            id: source, name: filename, mimeType: 'application/pdf',
            modifiedTime: d.created_at, size: 0, webViewLink: link,
          });
          row.detail = [d.projects?.name, p.total != null ? usd(p.total) : null].filter(Boolean).join(' · ') || null;
          fileRef = refs.add('F', row);
        }

        return {
          ref: fileRef,
          type: d.type,
          vendor: p.vendor ?? null,
          po_number: p.po_number ?? null,
          total: p.total ?? null,
          eta: p.eta ?? null,
          project: d.projects?.name ?? null,
          source: source.startsWith('gmail:') ? 'email attachment' : 'drive',
          parsed_at: d.created_at,
          line_item_count: p.line_items?.length ?? 0,
          link,
        };
      }),
    };
}

async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: AssistantContext,
  session: ToolSession,
): Promise<ToolOutput> {
  const { db } = ctx;
  const { proposed, refs } = session;

  if (LIVE_GOOGLE_TOOLS.includes(name) && !canSupervise(ctx.role)) {
    return {
      refused: true,
      reason:
        "Searching the studio's live Gmail and Drive is limited to the principal and coordinator. Mail and documents already in the system are still available through search_email, read_email and search_documents — try those, and hand over any attachments they return.",
    };
  }

  const activeAgents = ctx.agents ?? [];
  if (!agentAllows(activeAgents, name)) {
    const owners = agentsFor(name).map((key) => AGENT_LABELS[key]);
    const active = activeAgents.map((key) => AGENT_LABELS[key]).join(' and ');
    return {
      refused: true,
      reason: owners.length
        ? `That needs ${owners.join(' or ')}, not what's switched on right now (${active} only). Turn ${
            owners.length > 1 ? 'one of them' : owners[0]
          } on as well, or switch the agent picker off for full access.`
        : `That is not available with ${active} only. Switch the agent picker off for full access.`,
    };
  }

  switch (name) {
    case 'list_projects': {
      let q = db
        .from('projects')
        .select('id, name, client_name, stage, status, budget, target_install, updated_at')
        // Ordered before the cap, or the 60 that survive it are whichever
        // 60 the database felt like returning.
        .order('updated_at', { ascending: false })
        .limit(60);
      if (input.search) q = q.or(`name.ilike.${ilike(String(input.search))},client_name.ilike.${ilike(String(input.search))}`);
      if (input.stage) q = q.eq('stage', String(input.stage));
      // An archived job is finished. It was being counted in "how many
      // projects do we have" and listed beside live work as though the
      // studio still owed someone a delivery.
      if (!input.include_archived) q = q.neq('status', 'archived');

      // Money lives on purchase_orders, not projects, so a question about
      // cost is unanswerable without joining them. Aggregated in one pass.
      const [projects, pos, gaps] = await Promise.all([
        rows(q, 'projects'),
        rows(db.from('purchase_orders').select('project_id, amount, status'), 'purchase orders'),
        rows(db.from('spec_gaps').select('project_id').eq('resolved', false), 'spec gaps'),
      ]);

      const CLOSED = ['received', 'cancelled'];
      const onOrder = new Map<string, number>();
      const openPos = new Map<string, number>();
      for (const o of pos as { project_id: string | null; amount: number | null; status: string }[]) {
        if (!o.project_id) continue;
        onOrder.set(o.project_id, (onOrder.get(o.project_id) ?? 0) + Number(o.amount ?? 0));
        if (!CLOSED.includes(o.status)) openPos.set(o.project_id, (openPos.get(o.project_id) ?? 0) + 1);
      }
      const gapCount = new Map<string, number>();
      for (const g of gaps as { project_id: string | null }[]) {
        if (g.project_id) gapCount.set(g.project_id, (gapCount.get(g.project_id) ?? 0) + 1);
      }

      let list = (projects as { id: string; budget: number | null; updated_at: string; target_install: string | null }[]).map(
        (p) => ({
          ...p,
          budget: p.budget,
          on_order: onOrder.get(p.id) ?? 0,
          open_pos: openPos.get(p.id) ?? 0,
          spec_gaps: gapCount.get(p.id) ?? 0,
        }),
      );

      const sort = String(input.sort_by ?? 'recent');
      if (sort === 'cost') list.sort((a, b) => b.on_order - a.on_order);
      else if (sort === 'install') {
        list.sort((a, b) => (a.target_install ?? '9999').localeCompare(b.target_install ?? '9999'));
      } else list.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));

      if (input.limit) list = list.slice(0, Math.max(1, Number(input.limit)));
      return {
        note:
          'All amounts are US dollars. on_order is the total value of the project\'s purchase orders; budget is the separately recorded budget figure and is often not set. To show projects, answer with their refs.' +
          (input.include_archived
            ? ' Archived projects are included here — say which are archived.'
            : ' Archived projects are excluded; this is the live pipeline.'),
        total: list.length,
        projects: list.map((p) => {
          const row = p as unknown as Parameters<typeof projectRow>[0];
          return { ref: refs.add('P', projectRow(row)), ...p };
        }),
      };
    }

    case 'list_tasks': {
      let q = db
        .from('tasks')
        .select('id, title, kind, status, due_date, created_at, projects(name), profiles(full_name)')
        .order('created_at', { ascending: false })
        .limit(60);
      const status = String(input.status ?? 'live');
      if (status === 'live') q = q.in('status', LIVE);
      else if (status !== 'all') q = q.eq('status', status);
      if (input.kind) q = q.eq('kind', String(input.kind));
      if (input.overdue_only) q = q.lt('due_date', new Date().toISOString().slice(0, 10));

      let list = (await rows(q, 'tasks')) as unknown as {
        id: string; title: string; kind: string; status: string; due_date: string | null;
        projects: { name: string } | null; profiles: { full_name: string | null } | null;
      }[];
      // Name filters are applied here rather than in SQL: the joins are
      // nested, and the row counts are small enough that it does not matter.
      if (input.assignee_name) {
        const needle = String(input.assignee_name).toLowerCase();
        list = list.filter((r) => (r.profiles?.full_name ?? '').toLowerCase().includes(needle));
      }
      if (input.project) {
        const needle = String(input.project).toLowerCase();
        list = list.filter((r) => (r.projects?.name ?? '').toLowerCase().includes(needle));
      }
      return list.map((r) => {
        const task = {
          id: r.id,
          title: r.title,
          status: r.status,
          due_date: r.due_date,
          owner: r.profiles?.full_name ?? 'Unassigned',
          project: r.projects?.name ?? null,
        };
        return { ref: refs.add('T', taskRow(task)), ...task, kind: r.kind };
      });
    }

    case 'get_project_status': {
      const needle = ilike(String(input.name ?? ''));
      // More than one, then pick: a bare "OVIS" matches OVIS GOLF, OVIS
      // Cabana and a closed job, and taking whichever row came back first
      // answered about the wrong one. Live work wins over archived.
      const matches = (await rows(
        db
          .from('projects')
          .select('id, name, client_name, stage, status, budget, target_install, notes')
          .or(`name.ilike.${needle},client_name.ilike.${needle}`)
          .order('updated_at', { ascending: false })
          .limit(5),
        'projects',
      )) as unknown as {
        id: string; name: string; client_name: string | null; stage: string; status: string;
        budget: number | null; target_install: string | null; notes: string | null;
      }[];
      const live = matches.filter((p) => p.status !== 'archived');
      const project = live[0] ?? matches[0];
      if (!project) return { found: false, note: 'No project matched that name.' };
      const alsoMatched = (live.length ? live : matches).slice(1).map((p) => p.name);

      const [pos, tasks, gaps, emails] = await Promise.all([
        rows(db.from('purchase_orders').select('po_number, status, amount, eta').eq('project_id', project.id), 'purchase orders'),
        rows(db.from('tasks').select('id, title, kind, status, due_date, profiles(full_name)').eq('project_id', project.id).in('status', LIVE), 'tasks'),
        rows(db.from('spec_gaps').select('item').eq('project_id', project.id).eq('resolved', false), 'spec gaps'),
        rows(db.from('emails').select('id, subject, from_addr, received_at, class').eq('project_id', project.id).order('received_at', { ascending: false }).limit(5), 'email'),
      ]);
      return {
        found: true,
        project: {
          ref: refs.add('P', {
            kind: 'project',
            id: project.id,
            title: project.name,
            detail: project.client_name,
            fields: [field('Stage', project.stage), field('Budget', usd(project.budget)), field('Target install', day(project.target_install))],
          }),
          ...project,
        },
        note: alsoMatched.length
          ? `That name also matches ${alsoMatched.join(', ')} — say which one this answer is about.`
          : undefined,
        purchase_orders: pos,
        open_tasks: tasks.map((t) => {
          const r = t as unknown as {
            id: string; title: string; kind: string; status: string; due_date: string | null;
            profiles: { full_name: string | null } | null;
          };
          const owner = r.profiles?.full_name ?? 'Unassigned';
          return {
            ref: refs.add('T', taskRow({ id: r.id, title: r.title, status: r.status, due_date: r.due_date, owner, project: project.name })),
            title: r.title, kind: r.kind, status: r.status, due_date: r.due_date, owner,
          };
        }),
        spec_gaps: gaps.map((g) => (g as { item: string }).item),
        recent_email: emails.map((e) => {
          const r = e as unknown as { id: string; subject: string | null; from_addr: string | null; received_at: string | null; class: string };
          return {
            ref: refs.add('E', {
              kind: 'email',
              id: r.id,
              title: r.subject || '(no subject)',
              detail: r.from_addr ? addressOf(r.from_addr) : null,
              fields: [field('Received', day(r.received_at))],
            }),
            subject: r.subject, from: r.from_addr, received_at: r.received_at, type: r.class,
          };
        }),
      };
    }

    case 'list_team': {
      const [people, tasks] = await Promise.all([
        rows(db.from('profiles').select(await profileColumns('id, full_name, email, role')), 'the team'),
        rows(db.from('tasks').select('assigned_to').in('status', LIVE), 'tasks'),
      ]);
      const load = new Map<string, number>();
      for (const t of tasks) {
        const id = (t as { assigned_to: string | null }).assigned_to;
        if (id) load.set(id, (load.get(id) ?? 0) + 1);
      }
      type Profile = { id: string; full_name: string | null; email: string | null; role: UserRole; seat?: Seat | null };
      const accounts = people as unknown as Profile[];

      // A shared inbox signs in, but it is the studio, not a colleague.
      const inboxes = accounts.filter((p) => isStudioMailbox(p.email));
      const members = accounts.filter((p) => !isStudioMailbox(p.email)).map((p) => {
        const known = studioPerson({ email: p.email, name: p.full_name });
        const seat = p.seat ?? known?.seat ?? null;
        const live = load.get(p.id) ?? 0;
        return {
          ref: refs.add('M', personRow({
            id: p.id, name: p.full_name ?? known?.name ?? p.email ?? 'Unnamed', email: p.email,
            role: p.role, seat, live_tasks: live, has_account: true,
          })),
          name: p.full_name ?? known?.name ?? 'Unnamed', email: p.email, role: p.role,
          seat: seat ? SEATS[seat].label : null, live_tasks: live,
        };
      });
      // Teammates the studio lists who have no account yet: still the team,
      // but nothing can be assigned to them until they do.
      const withoutAccount = STUDIO_TEAM.filter(
        (t) => !accounts.some((p) => p.email?.toLowerCase() === t.email || studioPerson({ name: p.full_name })?.email === t.email),
      ).map((t) => ({
        ref: refs.add('M', personRow({
          id: null, name: t.name, email: t.email, role: seatRole(t), seat: t.seat, live_tasks: 0, has_account: false,
        })),
        name: t.name, email: t.email, seat: t.seat ? SEATS[t.seat].label : null, has_account: false,
      }));
      return {
        note: 'Answer with the refs. People without an account cannot be given tasks until someone adds them on Team & roles.',
        members,
        ...(withoutAccount.length ? { without_account: withoutAccount } : {}),
        ...(inboxes.length ? { shared_inboxes: inboxes.map((p) => p.email) } : {}),
      };
    }

    case 'get_today': {
      const digest = await maybeRow(
        db
          .from('digests')
          .select('digest_date, narrative, figures, escalations')
          .order('digest_date', { ascending: false })
          .limit(1)
          .maybeSingle(),
        "today's digest",
      );

      // Whatever the cached narrative says, the tasks behind it still need
      // real, clickable rows — a digest written this morning has no idea
      // what ref a tool would give a task, so without this every task the
      // narrative names could be described but never opened.
      const live = (await rows(
        db
          .from('tasks')
          .select('id, title, kind, status, due_date, assigned_to, profiles(full_name), projects(name)')
          .in('status', LIVE),
        'tasks',
      )) as unknown as {
        id: string; title: string; kind: string; status: string; due_date: string | null;
        assigned_to: string | null; profiles: { full_name: string | null } | null;
        projects: { name: string } | null;
      }[];
      const today = new Date().toISOString().slice(0, 10);
      const owner = (t: (typeof live)[number]) => t.profiles?.full_name ?? 'Unassigned';
      const overdue = live
        .filter((t) => (t.due_date && t.due_date < today) || t.status === 'blocked')
        .map((t) => ({
          ref: refs.add('T', taskRow({ id: t.id, title: t.title, status: t.status, due_date: t.due_date, owner: owner(t), project: t.projects?.name ?? null })),
          title: t.title, owner: owner(t), status: t.status, due_date: t.due_date,
        }));
      const unassigned = live
        .filter((t) => !t.assigned_to)
        .map((t) => ({
          ref: refs.add('T', taskRow({ id: t.id, title: t.title, status: t.status, due_date: t.due_date, owner: 'Unassigned', project: t.projects?.name ?? null })),
          title: t.title, kind: t.kind,
        }));

      if (digest) return { ...(digest as unknown as Record<string, unknown>), overdue, unassigned } as ToolOutput;

      // No digest yet (it runs at 07:05). Rather than a dead end, compute
      // the same picture live so "give me the brief" still works.
      return { note: 'No digest has been generated yet; this is computed live from the same data.', open_tasks: live.length, overdue, unassigned };
    }

    case 'search_email': {
      // Columns once 0010 is applied; until then the same data sits inside
      // extracted_json, which readStoredText knows how to unpack.
      const hasLinks = await bodyColumnsReady();
      let q = db
        .from('emails')
        .select(
          `id, subject, from_addr, to_addr, snippet, received_at, class, extracted_json,
           ${hasLinks ? 'links,' : ''} projects(name), vendors(name)`,
        )
        .order('received_at', { ascending: false, nullsFirst: false })
        .limit(40);
      if (input.klass) q = q.eq('class', String(input.klass));
      if (input.days) {
        const since = new Date(Date.now() - Number(input.days) * 86400_000).toISOString();
        q = q.gte('received_at', since);
      }
      if (input.search) {
        const cols = ['subject', 'from_addr', 'to_addr', 'snippet'];
        // The body is searchable too, wherever 0010 has it living.
        cols.push(hasLinks ? 'body_text' : 'extracted_json->>_body');
        q = matchPhrase(q, String(input.search), cols);
      }

      let list = (await rows(q, 'email')) as unknown as {
        id: string;
        subject: string | null; from_addr: string | null; snippet: string | null;
        received_at: string | null; class: string;
        extracted_json: (Record<string, unknown> & { summary?: string }) | null;
        links?: { url: string; host: string }[] | null;
        projects: { name: string } | null; vendors: { name: string } | null;
      }[];
      if (input.project) {
        const needle = String(input.project).toLowerCase();
        list = list.filter((r) => (r.projects?.name ?? '').toLowerCase().includes(needle));
      }

      // Which of these already raised a task, so "create a task from that
      // email" can see when one exists and update it instead.
      const taskByEmail = await tasksForEmails(db, list.map((e) => e.id));
      if (input.without_task) list = list.filter((e) => !taskByEmail.has(e.id));

      const by_type: Record<string, number> = {};
      for (const e of list) by_type[e.class] = (by_type[e.class] ?? 0) + 1;

      return {
        total: list.length,
        by_type,
        messages: list.slice(0, 15).map((e) => ({
          ref: refs.add('E', {
            kind: 'email',
            id: e.id,
            title: e.subject || '(no subject)',
            detail: e.extracted_json?.summary ?? e.snippet ?? null,
            fields: [
              field('From', e.from_addr ? addressOf(e.from_addr) : null),
              field('Received', day(e.received_at)),
              field('Project', e.projects?.name),
            ],
          }),
          // So a follow-up question can ask for this exact message's body
          // instead of searching again.
          id: e.id,
          task: taskByEmail.get(e.id) ?? null,
          subject: e.subject,
          from: e.from_addr,
          // Links are short and are what people ask for by name. Carried
          // here so "send me the Canva link" is answered in one hop rather
          // than costing a second call to read the whole message.
          links: readStoredText(e).links.map((l) => l.url),
          received_at: e.received_at,
          type: e.class,
          project: e.projects?.name ?? null,
          vendor: e.vendors?.name ?? null,
          // The one-line summary Claude wrote at ingest time, if present.
          summary: e.extracted_json?.summary ?? e.snippet,
        })),
      };
    }

    case 'read_email': {
      const hasBody = await bodyColumnsReady();
      const fields = `id, subject, from_addr, to_addr, received_at, class, snippet, extracted_json,
                      ${hasBody ? 'body_text, links,' : ''} projects(name), vendors(name)`;

      let q = db.from('emails').select(fields).order('received_at', { ascending: false, nullsFirst: false }).limit(1);
      if (input.id) {
        q = db.from('emails').select(fields).eq('id', String(input.id)).limit(1);
      } else if (input.search) {
        const bodyCol = hasBody ? 'body_text' : 'extracted_json->>_body';
        // "What did Brianna say" means mail she SENT. Searching every column
        // at once answered it with a thread she was merely copied on, which
        // is a different message by a different person. Try the sender
        // first, and only widen when nobody by that name sent anything.
        const bySender = matchPhrase(
          db.from('emails').select(fields).order('received_at', { ascending: false, nullsFirst: false }).limit(1),
          String(input.search),
          ['from_addr'],
        );
        const { data: sent } = await bySender;
        if (sent?.length) {
          // Re-issue it: the builder above has already been awaited.
          q = matchPhrase(
            db.from('emails').select(fields).order('received_at', { ascending: false, nullsFirst: false }).limit(1),
            String(input.search),
            ['from_addr'],
          );
        } else {
          q = matchPhrase(q, String(input.search), ['subject', 'from_addr', 'to_addr', 'snippet', bodyCol]);
        }
      }

      const found = (await rows(q, 'email')) as unknown as {
        id: string; subject: string | null; from_addr: string | null; to_addr: string | null;
        received_at: string | null; class: string; snippet: string | null;
        body_text?: string | null; links?: { url: string; host: string }[] | null;
        extracted_json: (Record<string, unknown> & { summary?: string }) | null;
        projects: { name: string } | null; vendors: { name: string } | null;
      }[];

      const e = found[0];
      if (!e) return { found: false, note: 'No stored email matches that.' };

      // What arrived attached to it. Documents parsed from an attachment are
      // stored as "gmail:<messageId>:<attachmentId>", so the message's own
      // Gmail id is the join — the link was always there, nothing exposed it.
      const { data: gmailIdRow } = await db.from('emails').select('gmail_id').eq('id', e.id).maybeSingle();
      const gmailId = (gmailIdRow as { gmail_id?: string | null } | null)?.gmail_id ?? null;
      const attachments: Record<string, unknown>[] = [];
      let attachmentNote: string | null = null;
      if (gmailId) {
        // What was parsed, keyed by attachment id, so the file rows below can
        // carry the vendor and total the extraction already found.
        const { data: attached } = await db
          .from('documents')
          .select('id, type, parsed_json, drive_file_id')
          .like('drive_file_id', `gmail:${gmailId}:%`);
        const parsedByAttachment = new Map<string, { type: string; parsed_json: Record<string, unknown> | null }>();
        for (const row of attached ?? []) {
          const d = row as { type: string; parsed_json: Record<string, unknown> | null; drive_file_id: string };
          parsedByAttachment.set(d.drive_file_id.slice(`gmail:${gmailId}:`.length), d);
        }

        const parsedFacts = (attachmentId: string) => {
          const d = parsedByAttachment.get(attachmentId);
          if (!d) return {};
          const pj = (d.parsed_json ?? {}) as { vendor?: string; po_number?: string; total?: number };
          return { parsed_as: d.type, vendor: pj.vendor ?? null, po_number: pj.po_number ?? null, total: pj.total ?? null };
        };

        // The person can read this email, so they may have what came with
        // it. Listed from Gmail itself where possible: ingestion only kept
        // PDFs, and the drawing or the photo is as often what is wanted.
        let live: Awaited<ReturnType<typeof getMessageWithAttachments>> | null = null;
        try {
          live = ctx.orgId ? await getMessageWithAttachments(await session.google.gmail(), gmailId) : null;
        } catch (err) {
          attachmentNote = isGoogleAuthFailure(err)
            ? 'Google needs reconnecting, so only the attachments that were parsed at ingest are listed.'
            : err instanceof ToolDataError
              ? `${err.message}; only the attachments that were parsed at ingest are listed.`
              : 'Gmail could not be reached, so only the attachments that were parsed at ingest are listed.';
        }

        if (live && ctx.orgId) {
          for (const att of live.files) {
            const row = gmailFileRow(ctx.orgId, gmailId, att, {
              from: e.from_addr, subject: e.subject, receivedAt: e.received_at,
            });
            attachments.push({
              ref: refs.add('F', row),
              filename: att.filename,
              type: fileKind(att.filename, att.mimeType),
              size: bytes(att.size),
              ...parsedFacts(att.attachmentId),
            });
          }
        } else if (ctx.orgId) {
          for (const [attachmentId, d] of parsedByAttachment) {
            const pj = (d.parsed_json ?? {}) as { vendor?: string; po_number?: string };
            const filename = `${d.type.replace(/_/g, ' ')}${pj.vendor ? ` - ${pj.vendor}` : ''}.pdf`;
            const row = gmailFileRow(
              ctx.orgId,
              gmailId,
              { filename, mimeType: 'application/pdf', attachmentId, size: 0 },
              { from: e.from_addr, subject: e.subject, receivedAt: e.received_at },
            );
            attachments.push({ ref: refs.add('F', row), filename, type: 'PDF', ...parsedFacts(attachmentId) });
          }
        }
      }

      // Older mail was ingested before bodies were kept, so say which it is
      // rather than letting the answer imply the message was empty.
      const stored = readStoredText(e);
      const body = stored.body;
      return {
        found: true,
        id: e.id,
        subject: e.subject,
        from: e.from_addr,
        to: e.to_addr,
        received_at: e.received_at,
        type: e.class,
        project: e.projects?.name ?? null,
        vendor: e.vendors?.name ?? null,
        links: stored.links.map((l) => ({ url: l.url, host: l.host })),
        attachments,
        attachment_count: attachments.length,
        attachment_note: attachmentNote,
        task: (await tasksForEmails(db, [e.id])).get(e.id) ?? null,
        // Capped: the assistant needs what was said, not a whole thread.
        body: body ? body.slice(0, 4000) : null,
        body_available: Boolean(body),
        note: body
          ? null
          : "The TEXT of this message is not stored (it was read before bodies were kept), so you CANNOT tell whether it contains a link, a price, a measurement or any particular wording. Do NOT say a link or detail is absent — you have not seen the message. Say the text has not been captured yet and that re-reading the mail from the Dashboard will capture it. Subject, summary and the attachments listed above ARE reliable; answer from those where you can.",
      };
    }

    case 'search_documents':
      return findStoredDocuments(ctx, refs, input);

    case 'list_vendors': {
      const search = typeof input.search === 'string' ? input.search : null;
      let q = db.from('vendors').select('id, name, category, website, contacts, notes');
      if (search) q = q.or(`name.ilike.${ilike(search)},category.ilike.${ilike(search)}`);
      const vendors = (await rows(q, 'vendors')) as unknown as {
        id: string; name: string; category: string | null; website: string | null;
        contacts: unknown; notes: string | null;
      }[];

      const pos = (await rows(
        db.from('purchase_orders').select('vendor_id, status, amount'),
        'purchase orders',
      )) as unknown as { vendor_id: string | null; status: string; amount: number | null }[];

      return vendors.map((v) => {
        const mine = pos.filter((p) => p.vendor_id === v.id);
        const open = mine.filter((p) => !['received', 'cancelled'].includes(p.status));
        const vendor = {
          id: v.id,
          name: v.name,
          category: v.category,
          // Where to actually go and order — the question people ask most
          // about a vendor, and unanswerable until the directory held it.
          website: v.website,
          contacts: v.contacts,
          open_orders: open.length,
          on_order: open.reduce((sum, p) => sum + (p.amount ?? 0), 0),
        };
        return { ref: refs.add('V', vendorRow(vendor)), ...vendor, notes: v.notes };
      });
    }

    case 'list_purchase_orders': {
      const status = typeof input.status === 'string' ? input.status : 'open';
      const today = new Date().toISOString().slice(0, 10);

      let q = db
        .from('purchase_orders')
        .select('id, po_number, status, amount, eta, vendors(name), projects(name)')
        .order('eta', { ascending: true });

      if (status !== 'all' && status !== 'open') q = q.eq('status', status);
      if (status === 'open') q = q.not('status', 'in', '("received","cancelled")');

      const list = (await rows(q, 'purchase orders')) as unknown as {
        id: string; po_number: string | null; status: string; amount: number | null; eta: string | null;
        vendors: { name: string } | null; projects: { name: string } | null;
      }[];

      const vendor = typeof input.vendor === 'string' ? input.vendor.toLowerCase() : null;
      const project = typeof input.project === 'string' ? input.project.toLowerCase() : null;

      return list
        .filter((p) => !vendor || (p.vendors?.name ?? '').toLowerCase().includes(vendor))
        .filter((p) => !project || (p.projects?.name ?? '').toLowerCase().includes(project))
        .filter((p) => !input.late_only || (p.eta != null && p.eta < today))
        .map((p) => {
          const order = {
            id: p.id,
            po: p.po_number,
            vendor: p.vendors?.name ?? 'Unknown vendor',
            project: p.projects?.name ?? 'Unassigned',
            amount: p.amount,
            status: p.status,
            expected: p.eta,
            late: Boolean(p.eta && p.eta < today && !['received', 'cancelled'].includes(p.status)),
          };
          return { ref: refs.add('O', purchaseOrderRow(order)), ...order };
        });
    }

    case 'list_follow_ups': {
      const status = typeof input.status === 'string' ? input.status : 'pending';
      let q = db
        .from('follow_ups')
        .select('id, type, status, reason, target, due_date, created_at, projects(name), vendors(name)')
        .order('created_at', { ascending: true });

      if (status === 'pending') q = q.in('status', ['open', 'drafted']);
      else if (status !== 'all') q = q.eq('status', status);
      if (typeof input.type === 'string') q = q.eq('type', input.type);

      const list = (await rows(q, 'follow-ups')) as unknown as {
        id: string; type: string; status: string; reason: string | null; target: string | null;
        due_date: string | null; created_at: string;
        projects: { name: string } | null; vendors: { name: string } | null;
      }[];

      return list.map((f) => {
        const waitingDays = Math.floor((Date.now() - new Date(f.created_at).getTime()) / 86_400_000);
        return {
          ref: refs.add('U', {
            kind: 'follow_up',
            id: f.id,
            title: f.type.replace(/_/g, ' '),
            detail: [f.projects?.name, f.vendors?.name].filter(Boolean).join(' · ') || f.reason || null,
            meta: `${waitingDays}d waiting`,
            tone: f.status === 'sent' ? 'good' : waitingDays > 5 ? 'warn' : 'neutral',
          }),
          type: f.type,
          status: f.status,
          reason: f.reason,
          waiting_on: f.target,
          due_date: f.due_date,
          project: f.projects?.name ?? null,
          vendor: f.vendors?.name ?? null,
          waiting_days: waitingDays,
        };
      });
    }

    case 'list_drafts': {
      const search = typeof input.search === 'string' ? input.search : null;
      let q = db
        .from('drafts')
        .select('id, subject, body_preview, follow_up_id, created_at')
        .order('created_at', { ascending: false })
        .limit(25);
      if (search) q = q.ilike('subject', ilike(search));

      const list = (await rows(q, 'drafts')) as unknown as {
        id: string; subject: string | null; body_preview: string | null;
        follow_up_id: string | null; created_at: string;
      }[];

      return list.map((d) => {
        const to = (d.body_preview ?? '').match(/^To:\s*(.+)$/im)?.[1]?.trim() || null;
        return {
          // So the answer can hand this exact draft over rather than
          // pointing at the whole Drafts list — see assistantItemHref.
          ref: refs.add('D', { kind: 'draft', id: d.id, title: d.subject || '(no subject)', detail: to ? `To ${to}` : null }),
          subject: d.subject,
          // Enough to say what it is about without reading a whole email aloud.
          preview: (d.body_preview ?? '').slice(0, 200),
          raised_by_follow_up: Boolean(d.follow_up_id),
          written: d.created_at,
        };
      });
    }

    case 'list_spec_gaps': {
      let q = db
        .from('spec_gaps')
        .select('item, missing_fields, resolved, created_at, projects(name)')
        .order('created_at', { ascending: true });
      if (!input.include_resolved) q = q.eq('resolved', false);

      const list = (await rows(q, 'spec gaps')) as unknown as {
        item: string | null; missing_fields: unknown; resolved: boolean; created_at: string;
        projects: { name: string } | null;
      }[];

      const project = typeof input.project === 'string' ? input.project.toLowerCase() : null;
      return list
        .filter((g) => !project || (g.projects?.name ?? '').toLowerCase().includes(project))
        .map((g) => ({
          item: g.item,
          missing: g.missing_fields,
          project: g.projects?.name ?? 'Unassigned',
          resolved: g.resolved,
          open_days: Math.floor((Date.now() - new Date(g.created_at).getTime()) / 86_400_000),
        }));
    }

    case 'list_studio_prompts': {
      const search = typeof input.search === 'string' ? input.search : null;
      let q = db.from('prompts').select('id, title, category, description, variables').order('category');
      if (search) q = q.or(`title.ilike.${ilike(search)},description.ilike.${ilike(search)}`);
      const prompts = (await rows(q, 'prompts')) as unknown as {
        id: string; title: string; category: string; description: string | null;
        variables: { key: string; label: string; required?: boolean }[] | null;
      }[];

      return prompts.map((p) => ({
        title: p.title,
        category: p.category,
        description: p.description,
        // The labels, not the keys: the model fills these from what it was
        // told, and a label says what belongs in it.
        inputs: (p.variables ?? []).map((v) => `${v.key} (${v.label})${v.required ? ' — required' : ''}`),
      }));
    }

    case 'render_board': {
      if (!canWith(ctx.permissions, ctx.role, 'prompts', 'update')) {
        return { refused: true, reason: 'Rendering the studio boards is not something this role may do.' };
      }
      if (!ctx.orgId) return { refused: true, reason: 'No studio is attached to this account.' };
      if (!(await isImageReady(ctx.orgId))) {
        return {
          refused: true,
          reason:
            'Board rendering has no image key set up yet. If what they actually asked for was a rendering or a picture transformed from something they attached, that is make_image, not a board — try that instead of refusing. Otherwise say so, and offer to write the board out in words.',
        };
      }

      const wanted = String(input.prompt ?? '').trim();
      const library = (await rows(
        db.from('prompts').select('id, title, category, template, variables'),
        'prompts',
      )) as unknown as {
        id: string; title: string; template: string;
        variables: { key: string; label: string; required?: boolean }[] | null;
      }[];

      const brief = String(input.brief ?? '').trim();
      const prompt = wanted ? matchPrompt(library.filter((p) => isRenderable(p.title)), wanted) : null;

      // No library prompt, but a brief: draw it anyway. The library covers
      // the boards this studio makes weekly; it was never the limit of what
      // a designer can be asked for.
      if (!prompt && !brief) {
        return {
          not_found: wanted || '(nothing named)',
          renderable: library.filter((p) => isRenderable(p.title)).map((p) => p.title),
          note: 'Either name one of these, or pass `brief` describing the board in your own words — do not report that no prompt exists.',
        };
      }

      const raw = (input.variables ?? {}) as Record<string, unknown>;
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') values[k] = v;
        else if (v != null) values[k] = String(v);
      }

      if (prompt) {
        const missing = missingInputs(prompt.variables, values);
        if (missing.length) {
          return { prompt: prompt.title, missing_inputs: missing, note: 'Ask for these before drawing it.' };
        }
      }

      // Whatever they attached to this question becomes the reference
      // imagery — the approved template board, the plan, the materials.
      // Without it the board is drawn from nothing but words.
      const references: ImageReference[] = [];
      for (const { grant } of ctx.attached ?? []) {
        try {
          const file = await fetchGrantedFile(grant);
          references.push({ mimeType: file.mimeType, bytes: file.bytes, label: grant.name });
        } catch {
          // One unreadable attachment should not stop the board.
        }
      }

      const instruction = prompt
        ? boardPrompt(prompt.title, fillTemplate(prompt.template, values))
        : freeformBoard(brief);
      if (!instruction) return { refused: true, reason: 'That prompt cannot be rendered.' };
      const label = prompt ? BOARD_PROMPTS[prompt.title].label : 'Board';

      let render;
      try {
        render = await renderImage(instruction, references, {
          feature: 'image.render',
          orgId: ctx.orgId,
          actor: ctx.userId,
          entity: 'prompts',
          entityId: prompt?.id ?? null,
        });
      } catch (err) {
        return {
          prompt: prompt?.title ?? 'a board drawn from your brief',
          failed: (err as Error).message,
          note: 'Tell them what went wrong in plain words, and offer to write the board out instead.',
        };
      }

      const name = `${label} — ${new Date().toISOString().slice(0, 10)}.${
        render.mimeType.includes('svg') ? 'svg' : 'png'
      }`;
      const { path } = await storeUpload({
        orgId: ctx.orgId,
        userId: ctx.userId,
        name,
        mimeType: render.mimeType as UploadType,
        bytes: render.bytes,
      });
      const token = sealFileGrant(
        { source: 'upload', orgId: ctx.orgId, path, mimeType: render.mimeType, name, size: render.bytes.length },
        UPLOAD_GRANT_TTL_MS,
      );

      await db.from('prompt_runs').insert({
        org_id: ctx.orgId,
        prompt_id: prompt?.id ?? null,
        project_id: typeof input.project_id === 'string' ? input.project_id : null,
        user_id: ctx.userId,
        input: { ...values, ...(brief ? { brief } : {}), board_path: path, board_model: render.model },
        output: render.note ?? `Rendered ${name}`,
      });

      // Handed back as a file row with a preview, the same way an
      // attachment is: the board appears in the answer rather than being
      // described in it.
      const ref = refs.add('F', {
        kind: 'file',
        title: name,
        preview: 'image',
        file: {
          name,
          mimeType: render.mimeType,
          size: render.bytes.length,
          source: 'upload',
          token,
          downloadable: true,
          webUrl: null,
        },
      });

      return {
        ref,
        prompt: prompt?.title ?? 'drawn from your brief',
        drawn_from: references.length
          ? references.map((r) => r.label)
          : 'nothing attached — drawn from the written inputs alone',
        note: render.note,
        instruction: `Put { "ref": "${ref}" } in the answer's items so the board is shown. Keep the lead to one sentence.`,
      };
    }

    case 'make_image': {
      if (!ctx.orgId) return { refused: true, reason: 'No studio is attached to this account.' };

      // A picture on the question means transform THAT picture.
      const attachedImages: ImageReference[] = [];
      for (const { grant } of ctx.attached ?? []) {
        if (!grant.mimeType.startsWith('image/')) continue;
        try {
          const file = await fetchGrantedFile(grant);
          attachedImages.push({ mimeType: file.mimeType, bytes: file.bytes, label: grant.name });
        } catch {
          // An unreadable attachment falls through to drawing from words.
        }
      }

      const drawn = await makePicture({
        actor: { db, orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, permissions: ctx.permissions },
        brief: String(input.brief ?? '').trim(),
        sources: attachedImages,
        aspectRatio: String(input.aspect_ratio ?? '16:9'),
        resolution: input.resolution === '1K' ? '1K' : '2K',
        projectId: typeof input.project_id === 'string' ? input.project_id : null,
        // It was a flat 25s whatever the turn had already spent.
        timeoutMs: Math.max(10_000, RENDER_IN_TURN_CEILING_MS - (Date.now() - session.startedAt)),
      });

      // They asked for a picture. A paragraph restating their brief is not
      // one, and "offer to describe it instead" is how a timed-out render
      // came back as a page of prose that read as though it had worked.
      if (!drawn.ok) {
        return {
          failed: drawn.reason,
          note: drawn.timedOut
            ? 'The render ran out of time. Say so in one short sentence, then tell them to set the mode control beside the message box — the one reading "Ask" — to Image and send the same brief again; Image mode has nearly a minute to draw, where a render inside a conversation has only what is left of it. That control is in this box: name no other app or product, and never tell them to go somewhere else to draw it. Do NOT describe the picture in its place.'
            : 'Tell them what went wrong in one or two plain sentences. Do NOT describe the picture in its place unless they ask for a description.',
        };
      }
      const picture = drawn.value;

      const ref = refs.add('F', {
        kind: 'file',
        title: picture.name,
        preview: 'image',
        file: {
          name: picture.name,
          mimeType: picture.mimeType,
          size: picture.size,
          source: 'upload',
          token: picture.token,
          downloadable: true,
          webUrl: null,
        },
      });

      // A floor plan's rooms, each its own picture after the plan.
      const roomRefs = picture.rooms.map((r) =>
        refs.add('F', {
          kind: 'file',
          title: r.roomSize ? `${r.room} — ${r.roomSize}` : r.room,
          preview: 'image',
          file: {
            name: r.name,
            mimeType: r.mimeType,
            size: r.size,
            source: 'upload',
            token: r.token,
            downloadable: true,
            webUrl: null,
          },
        }),
      );
      const allRefs = [ref, ...roomRefs];

      return {
        ref,
        ...(roomRefs.length ? { room_refs: roomRefs, rooms_rendered: picture.rooms.map((r) => r.room) } : {}),
        made_by: picture.plan
          ? `rendering the attached floor plan furnished, top-down — the walls, room names and dimensions are the original drawing laid over the rendering; furniture and finishes are illustrative.${
              roomRefs.length
                ? ` Then ${roomRefs.length} key room(s) in perspective (${picture.rooms.map((r) => r.room).join(', ')}), drawn from each room's use and size on the plan, not its exact walls and windows.`
                : ''
            } Say exactly that; do not name a style the person did not ask for.`
          : picture.mode === 'edit'
            ? 'transforming the attached picture'
            : 'drawing from the brief alone',
        drawn_with: picture.model,
        ...(picture.ignored.length
          ? { not_used: picture.ignored, why: 'Only one picture can be transformed at a time.' }
          : {}),
        note: picture.note,
        instruction: `Put ${allRefs.map((r) => `{ "ref": "${r}" }`).join(', ')} in the answer's items, in that order, so ${allRefs.length > 1 ? 'every picture is' : 'the picture is'} shown. Keep the lead to one or two sentences, and say plainly that they are generated images, not photographs.`,
      };
    }

    case 'make_video': {
      if (!ctx.orgId) return { refused: true, reason: 'No studio is attached to this account.' };
      const brief = String(input.brief ?? '').trim();
      if (!brief) return { refused: true, reason: 'Nothing was described. Ask what should happen in the clip.' };

      const actor = { db, orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, permissions: ctx.permissions };

      // Nothing is spent until the person has heard what it costs. The
      // model is told to read the brief back and ask; only the second call
      // carries confirmed. The day cap inside startClip holds regardless.
      if (input.confirmed !== true) {
        const models = await grokModels(ctx.orgId);
        const seconds = clampSeconds(typeof input.seconds === 'number' ? input.seconds : undefined, models.video);
        return {
          quote: {
            brief,
            seconds,
            cost_usd: videoCostUsd(models.video, seconds).toFixed(2),
            model: models.video,
            with_audio: false,
          },
          instruction:
            'Nothing has been started. Read the brief back in one sentence, say it is ' +
            `${seconds} seconds and about $${videoCostUsd(models.video, seconds).toFixed(2)}, and ask them to confirm. ` +
            'If they say yes, call make_video again with the same brief and confirmed: true.',
        };
      }

      // Image-to-video: animate the still they attached.
      let still: { mimeType: string; bytes: Buffer } | null = null;
      if (input.from_attachment === true) {
        for (const { grant } of ctx.attached ?? []) {
          if (!grant.mimeType.startsWith('image/')) continue;
          try {
            const file = await fetchGrantedFile(grant);
            still = { mimeType: file.mimeType, bytes: file.bytes };
            break;
          } catch {
            // Fall through to drawing it from words.
          }
        }
        if (!still) {
          return {
            refused: true,
            reason:
              'There is no picture attached to this question to animate. Ask them to attach one, or offer to draw the clip from the brief instead.',
          };
        }
      }

      const started = await startClip({
        actor,
        brief,
        seconds: typeof input.seconds === 'number' ? input.seconds : undefined,
        aspectRatio: String(input.aspect_ratio ?? '16:9'),
        still,
        projectId: typeof input.project_id === 'string' ? input.project_id : null,
      });

      if (!started.ok) {
        return { failed: started.reason, note: 'Tell them in plain words. Nothing was charged.' };
      }

      session.startedJobs.push(started.value.jobId);

      return {
        job_id: started.value.jobId,
        status: 'rendering',
        seconds: started.value.seconds,
        cost_usd: started.value.costUsd.toFixed(2),
        instruction:
          'Say it is rendering and that it will appear here by itself in a minute or so. ' +
          "Do NOT put a file ref in the answer's items — there is no video yet, and claiming " +
          'one exists is the one mistake to avoid here. The screen shows it when it arrives.',
      };
    }

    case 'run_studio_prompt': {
      if (!canWith(ctx.permissions, ctx.role, 'prompts', 'update')) {
        return {
          refused: true,
          reason: 'Running the studio prompts is not something this role may do. Say so plainly rather than writing the work another way.',
        };
      }

      const wanted = String(input.prompt ?? '').trim();
      const library = (await rows(
        db.from('prompts').select('id, title, category, template, variables'),
        'prompts',
      )) as unknown as {
        id: string; title: string; category: string | null; template: string;
        variables: { key: string; label: string; required?: boolean }[] | null;
      }[];

      const prompt = matchPrompt(library, wanted);
      if (!prompt) {
        return {
          not_found: wanted,
          available: library.map((p) => p.title),
        };
      }

      const raw = (input.variables ?? {}) as Record<string, unknown>;
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') values[k] = v;
        else if (v != null) values[k] = String(v);
      }

      const missing = missingInputs(prompt.variables, values);
      if (missing.length) {
        return {
          prompt: prompt.title,
          missing_inputs: missing,
          note: 'Ask the person for these before running it again — do not invent them.',
        };
      }

      // Said again at the moment of the run, not only in the tool's
      // description. The description is read once with every other tool's;
      // this arrives attached to the purchase order actually being written,
      // which is where a fabricated price or PO number would do its damage.
      const ordersMoney = prompt.category === 'procurement' || prompt.category === 'client';

      let output: string;
      try {
        output = await runLibraryPrompt(db, prompt, values, {
          orgId: ctx.orgId,
          userId: ctx.userId,
          projectId: typeof input.project_id === 'string' ? input.project_id : null,
        });
      } catch (err) {
        // Reported rather than thrown: a timeout here should end with Jenny
        // saying what happened, not with the whole turn failing.
        if (isTimeoutError(err)) {
          return {
            prompt: prompt.title,
            failed: 'It took longer than the time limit to write.',
            note: 'Tell them plainly, and offer to run it again or to narrow it to one room.',
          };
        }
        throw err;
      }

      // Kept whether or not the model remembers to pass it on.
      session.produced = { title: prompt.title, body: output };

      return {
        prompt: prompt.title,
        filled_from: Object.keys(values),
        // Named so the model does not paraphrase it into `lead`.
        document: output,
        instruction:
          "This is the work. Put it in the answer's `document` unchanged, title it with the prompt's name, and keep `lead` to one sentence saying what you made." +
          (ordersMoney
            ? ' This one commits the studio to money: do not fill in, correct or tidy any TBD it contains, and do not add a figure, a number or a date of your own when you present it. Where it says something is missing, say so too.'
            : ''),
      };
    }

    case 'get_weekly_report': {
      const report = await maybeRow(
        db
          .from('reports')
          .select('id, week_of, narrative, generated_json, created_at')
          .order('week_of', { ascending: false })
          .limit(1)
          .maybeSingle(),
        'the weekly report',
      );
      if (!report) return { note: 'No weekly report has been generated yet. It runs on Monday.' };
      const r = report as unknown as { id: string; week_of: string };
      return {
        ...(report as unknown as Record<string, unknown>),
        ref: refs.add('R', { kind: 'report', id: r.id, title: `Weekly report — week of ${day(r.week_of)}` }),
      } as ToolOutput;
    }

    case 'get_studio_rules': {
      const org = await maybeRow(
        db.from('organizations').select('name, settings').limit(1).maybeSingle(),
        "the studio's settings",
      );
      const settings = ((org as { settings?: Record<string, unknown> } | null)?.settings ??
        {}) as Record<string, unknown>;

      // Never read the credentials back out through the assistant.
      const { anthropic_api_key_encrypted, ai_usage_token, ...safe } = settings;
      void anthropic_api_key_encrypted;
      void ai_usage_token;

      return {
        studio: (org as { name?: string } | null)?.name ?? 'The studio',
        rules: safe,
        defaults: DEFAULT_SLA,
      };
    }

    case 'get_recent_activity': {
      const limit = typeof input.limit === 'number' ? Math.min(input.limit, 50) : 20;
      const list = (await rows(
        db
          .from('activity_log')
          .select('action, entity, meta, created_at, profiles(full_name)')
          .neq('action', 'ai.usage')
          .order('created_at', { ascending: false })
          .limit(limit),
        'the activity log',
      )) as unknown as {
        action: string; entity: string | null; meta: Record<string, unknown> | null;
        created_at: string; profiles: { full_name: string | null } | null;
      }[];

      return list.map((a) => ({
        what: a.action,
        entity: a.entity,
        who: a.profiles?.full_name ?? 'The system',
        when: a.created_at,
        detail: a.meta,
      }));
    }

    case 'get_ai_spend': {
      const days = typeof input.days === 'number' ? input.days : 30;
      const since = new Date(Date.now() - Math.min(days, 365) * 86_400_000).toISOString();

      const list = (await rows(
        db
          .from('activity_log')
          .select('meta, created_at')
          .eq('action', 'ai.usage')
          .gte('created_at', since),
        'AI usage',
      )) as unknown as { meta: Record<string, unknown> | null }[];

      const byFeature = new Map<string, { calls: number; cost: number }>();
      let cost = 0;
      for (const row of list) {
        const m = (row.meta ?? {}) as { feature?: string; cost_usd?: number };
        const spend = Number(m.cost_usd ?? 0);
        cost += spend;
        const key = m.feature ?? 'unknown';
        const b = byFeature.get(key) ?? { calls: 0, cost: 0 };
        b.calls += 1;
        b.cost += spend;
        byFeature.set(key, b);
      }

      return {
        window_days: days,
        calls: list.length,
        total_usd: Number(cost.toFixed(4)),
        by_job: [...byFeature.entries()]
          .map(([feature, b]) => ({
            job: AI_FEATURE_LABELS[feature as keyof typeof AI_FEATURE_LABELS] ?? feature,
            calls: b.calls,
            usd: Number(b.cost.toFixed(4)),
          }))
          .sort((a, b) => b.usd - a.usd),
      };
    }

    case 'propose_task': {
      if (!canWith(ctx.permissions, ctx.role, 'tasks', 'create')) {
        return { refused: true, reason: 'Your role cannot create tasks.' };
      }
      const kind = (TASK_KINDS.includes(input.kind as TaskKind) ? input.kind : 'admin') as TaskKind;
      const title = text(input.title, 200);
      if (!title) return { refused: true, reason: 'A task needs a title.' };

      // From an email: the email has to exist, and has to have no task yet —
      // one task per email is enforced by the database, so when it already
      // has one, the answer is to change that task rather than raise another.
      const emailId = text(input.email_id, 64);
      type EmailForTask = {
        id: string; subject: string | null; from_addr: string | null; project_id: string | null;
        projects: { name: string } | null;
      };
      let fromEmail: EmailForTask | null = null;
      if (emailId) {
        const { data } = await db
          .from('emails')
          .select('id, subject, from_addr, project_id, projects(name)')
          .eq('id', emailId)
          .maybeSingle();
        fromEmail = (data as unknown as EmailForTask | null) ?? null;
        if (!fromEmail) return { proposed: false, needs: 'No stored email has that id. Find it with search_email first.' };

        const { data: existing } = await db
          .from('tasks')
          .select('id, title, status, due_date, profiles(full_name)')
          .eq('source_email_id', emailId)
          .limit(1);
        const has = existing?.[0] as unknown as
          | { id: string; title: string; status: string; due_date: string | null; profiles: { full_name: string | null } | null }
          | undefined;
        if (has) {
          return {
            proposed: false,
            exists: {
              task_id: has.id,
              title: has.title,
              owner: has.profiles?.full_name ?? 'nobody',
              due: has.due_date ? friendlyDay(has.due_date) : 'no date',
              status: has.status,
            },
            note: 'That email already has a task. To give it the owner or date they asked for, call propose_task_update with this task_id. Do not raise a second task.',
          };
        }
      }

      // Who and where are matched NOW, while the person is still here to be
      // asked — not at confirmation, when a misheard "Danish" for "Denish"
      // used to match nobody and save the task with no owner at all.
      const said = text(input.assignee_name, 80);
      let assignee: { id: string; full_name: string } | null = null;
      if (said) {
        const team = await teamOf(db);
        const found = matchPerson(said, team);
        if (found.status === 'none') {
          return { proposed: false, needs: `No one called "${said}" is on the team. The team is: ${peopleOf(team).map((p) => p.full_name).join(', ')}. Ask which of them — do not guess.` };
        }
        if (found.status === 'ambiguous') {
          return { proposed: false, needs: `"${said}" could be ${found.rows.map((p) => p.full_name).join(' or ')}. Ask which.` };
        }
        assignee = found.row;
        if (assignee.id !== ctx.userId && !canManageTasks(ctx.role, ctx.seat ?? null)) {
          return { refused: true, reason: 'Only someone who runs the task board can assign work to other people. Offer to add it for them instead.' };
        }
      }

      const projectSaid = text(input.project, 120);
      let project: { id: string; name: string } | null = null;
      if (projectSaid) {
        const found = matchProject(projectSaid, await projectsOf(db));
        if (found.status === 'ambiguous') {
          return { proposed: false, needs: `"${projectSaid}" could be ${found.rows.map((p) => p.name).join(' or ')}. Ask which.` };
        }
        // No project is not worth stopping for: the task still stands, and
        // saying which project it went on shows the gap.
        if (found.status === 'found') project = found.row;
      }
      // Nothing said about the project: the email's own filing stands.
      if (!project && !projectSaid && fromEmail?.project_id && fromEmail.projects?.name) {
        project = { id: fromEmail.project_id, name: fromEmail.projects.name };
      }

      const due = typeof input.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.due_date) ? input.due_date : null;
      const summary = [
        `New task: “${title}”`,
        assignee ? `for ${assignee.full_name}` : `routed to ${TASK_KIND_ROLE[kind]}`,
        due ? `due ${friendlyDay(due)}` : null,
        project ? `on ${project.name}` : null,
        fromEmail ? `from the email “${(fromEmail.subject ?? 'no subject').slice(0, 60)}”` : null,
      ]
        .filter(Boolean)
        .join(' · ');

      proposed.push({
        tool: 'propose_task',
        summary,
        input: {
          title,
          detail: input.detail ?? null,
          kind,
          assignee_id: assignee?.id ?? null,
          assignee_name: assignee?.full_name ?? null,
          project_id: project?.id ?? null,
          project: project?.name ?? null,
          due_date: due,
          email_id: fromEmail?.id ?? null,
          next_step: text(input.next_step, 300) || null,
        },
      });
      return {
        proposed: true,
        summary,
        ...(projectSaid && !project ? { warning: `No project matched "${projectSaid}", so it will be saved without one.` } : {}),
        note: "Prepared, NOT saved. Tell them what it is and that they can say yes or press Confirm. It does not exist until respond_to_proposal saves it — never say it was created or added. Do not put it in items: it is shown beneath your answer with its Confirm button, and a row would look like a task that already exists.",
      };
    }

    case 'read_document': {
      if (!ctx.orgId) return { read: false, note: 'No studio is attached to this account.' };
      const item = refs.get(text(input.file, 16));
      if (!item?.file?.token) {
        return {
          read: false,
          note: 'That is not a file ref. Find the file first — find_attachments, search_documents, read_email or drive_search — and pass the ref (F1, F2…) it gives.',
        };
      }
      const opened = openFileGrant(item.file.token, ctx.orgId);
      if (!opened.ok) {
        return { read: false, note: 'The link to that file has expired. Find the file again, then read it.' };
      }
      const question = text(input.question, 600) || 'Summarise what this document contains.';

      let fetched: Awaited<ReturnType<typeof fetchGrantedFile>>;
      try {
        fetched = await fetchGrantedFile({ ...opened.grant, pages: undefined });
      } catch (err) {
        if (err instanceof FileFetchError) throw new ToolDataError(err.message);
        throw new ToolDataError(`Could not fetch the file (${(err as Error).message})`);
      }

      const reading = await readDocument(fetched, question, {
        feature: 'document.read',
        orgId: ctx.orgId,
        actor: ctx.userId,
        entity: 'files',
      });
      if (!reading.read) return reading;
      const { pages } = reading;

      // The pages themselves, as their own grant: only these pages travel to
      // the browser, which is what lets a big deck be shown at all.
      let previewRef: string | null = null;
      if (reading.kind === 'pdf' && pages.length) {
        const token = sealFileGrant({ ...opened.grant, pages });
        const label = pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(', ')}`;
        previewRef = refs.add('F', {
          kind: 'file',
          title: `${fetched.name.replace(/\.pdf$/i, '')} — ${label}`,
          detail: question,
          file: {
            name: `${fetched.name.replace(/\.pdf$/i, '')} (${label}).pdf`,
            mimeType: 'application/pdf',
            size: 0,
            source: opened.grant.source,
            token,
            downloadable: true,
            webUrl: fetched.webUrl,
          },
          preview: 'pdf',
          pages,
        });
      } else if (reading.kind === 'image') {
        previewRef = refs.add('F', { ...item, preview: 'image' });
      }

      return {
        read: true,
        answer: reading.answer,
        findings: reading.findings,
        pages,
        preview_ref: previewRef,
        ...(reading.scope ? { scope: reading.scope } : {}),
        note: previewRef
          ? 'Answer from this: the lead gives the answer; the findings can be note rows naming their page. Put preview_ref in items so they see the pages themselves.'
          : 'Answer from this. Nothing in the document shows it as a page, so say so if that is what they wanted.',
      };
    }

    case 'propose_task_update': {
      if (!canWith(ctx.permissions, ctx.role, 'tasks', 'update')) {
        return { refused: true, reason: 'Your role cannot change tasks.' };
      }
      const taskId = text(input.task_id, 64);
      const { data: row } = await db
        .from('tasks')
        .select('id, title, status, due_date, assigned_to, profiles(full_name)')
        .eq('id', taskId)
        .maybeSingle();
      const task = row as unknown as
        | { id: string; title: string; status: string; due_date: string | null; assigned_to: string | null; profiles: { full_name: string | null } | null }
        | null;
      if (!task) return { proposed: false, needs: 'No task has that id. Find it with list_tasks, search_email or read_email first.' };

      // The board's own rule: your own queue is yours; anyone else's is for
      // whoever runs the board.
      const runsBoard = canManageTasks(ctx.role, ctx.seat ?? null);
      if (!runsBoard && task.assigned_to && task.assigned_to !== ctx.userId) {
        return { refused: true, reason: `"${task.title}" belongs to ${task.profiles?.full_name ?? 'someone else'}; only someone who runs the task board can change it.` };
      }

      const changes: string[] = [];
      const change: Record<string, unknown> = { task_id: task.id };

      const said = text(input.assignee_name, 80);
      if (said) {
        const team = await teamOf(db);
        const found = matchPerson(said, team);
        if (found.status === 'none') {
          return { proposed: false, needs: `No one called "${said}" is on the team. The team is: ${peopleOf(team).map((p) => p.full_name).join(', ')}. Ask which — do not guess.` };
        }
        if (found.status === 'ambiguous') {
          return { proposed: false, needs: `"${said}" could be ${found.rows.map((p) => p.full_name).join(' or ')}. Ask which.` };
        }
        if (found.row.id !== ctx.userId && !runsBoard) {
          return { refused: true, reason: 'Only someone who runs the task board can give work to other people.' };
        }
        change.assignee_id = found.row.id;
        change.assignee_name = found.row.full_name;
        changes.push(`owner → ${found.row.full_name}`);
      }
      if (typeof input.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.due_date)) {
        change.due_date = input.due_date;
        changes.push(`due → ${friendlyDay(input.due_date)}`);
      }
      const statuses = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];
      if (typeof input.status === 'string' && statuses.includes(input.status)) {
        change.status = input.status;
        changes.push(`status → ${input.status.replace(/_/g, ' ')}`);
      }
      const nextStep = text(input.next_step, 300);
      if (nextStep) {
        change.next_step = nextStep;
        changes.push(`next step → “${nextStep}”`);
      }
      if (!changes.length) {
        return { proposed: false, needs: 'Nothing to change was given — an owner, a due date, a status or a next step.' };
      }

      const summary = `Update “${task.title}” · ${changes.join(' · ')}`;
      proposed.push({ tool: 'propose_task_update', summary, input: change });
      return {
        proposed: true,
        summary,
        note: "Prepared, NOT saved. Tell them what will change and that they can say yes or press Confirm. Never say it was changed until respond_to_proposal saves it. Do not put the task in items; it is shown beneath your answer with its Confirm button.",
      };
    }

    case 'respond_to_proposal': {
      const pending = ctx.pending ?? [];
      const n = Number(String(input.proposal ?? '').replace(/\D/g, ''));
      const target = Number.isInteger(n) && n >= 1 ? pending[n - 1] : undefined;
      if (!target) {
        return {
          done: false,
          note: pending.length
            ? `There is no proposal ${input.proposal}. The waiting ones are ${pending.map((_, i) => `#${i + 1}`).join(', ')}.`
            : 'Nothing is waiting for an answer. If they want something done, prepare it with propose_task or propose_draft.',
        };
      }
      if (session.settled.some((s) => s.key === target.key)) {
        return { done: true, note: 'That one is already settled in this conversation.' };
      }

      if (input.decision === 'cancel') {
        session.settled.push({ key: target.key, decision: 'cancelled' });
        return { cancelled: true, what: target.summary, note: 'Dropped — nothing was saved. Say so in a few words.' };
      }
      if (input.decision !== 'confirm') {
        return { done: false, note: 'decision must be "confirm" or "cancel".' };
      }

      try {
        const saved = await commitProposal(ctx, target.tool, target.input, 'conversation');
        session.settled.push({ key: target.key, decision: 'confirmed', id: saved.id, kind: saved.kind });
        if (saved.kind === 'task') {
          const ref = refs.add('T', {
            ...taskRow({
              id: saved.id,
              title: saved.title,
              status: 'open',
              due_date: saved.due_date,
              owner: saved.assignee ?? 'Unassigned',
              project: saved.project,
            }),
            tone: 'good',
          });
          return {
            saved: true,
            ref,
            ...(saved.duplicate ? { note_duplicate: 'It had already been saved a moment ago; that task is the one shown.' } : {}),
            note: 'It is now on the Tasks board. Say it is done, and give the task as a row with this ref so they can open it.',
          };
        }
        if (saved.kind === 'task_update') {
          const ref = refs.add('T', {
            ...taskRow({
              id: saved.id,
              title: saved.title,
              status: saved.status,
              due_date: saved.due_date,
              owner: saved.assignee ?? 'Unassigned',
              project: null,
            }),
            tone: 'good',
          });
          return { saved: true, ref, note: 'The task is updated on the board. Say what changed, with the row for this ref.' };
        }
        const ref = refs.add('D', { kind: 'draft', id: saved.id, title: saved.subject, detail: saved.to ? `To ${saved.to}` : null, tone: 'good' });
        return { saved: true, ref, note: 'It is saved in Drafts, NOT sent. Say so, with the row for this ref.' };
      } catch (err) {
        if (err instanceof ProposalError) return { saved: false, reason: err.message, note: 'Nothing was saved. Say why, in their words.' };
        throw err;
      }
    }

    // ── Live Gmail ────────────────────────────────────────────

    case 'find_attachments': {
      if (!ctx.orgId) return { found: 0, note: 'No studio is attached to this account.' };

      // Built from the parts rather than trusted as one string, so "the
      // drawings from Brianna" becomes a query Gmail can actually match.
      const terms = ['has:attachment'];
      if (input.from) terms.push(`from:(${String(input.from)})`);
      if (input.filename) terms.push(`filename:${String(input.filename).replace(/\s+/g, '-')}`);
      if (input.days) terms.push(`newer_than:${Math.max(1, Math.floor(Number(input.days)))}d`);
      if (input.search) terms.push(String(input.search));
      const query = terms.join(' ');

      let gmail: gmail_v1.Gmail;
      let messages: Awaited<ReturnType<typeof getMessageWithAttachments>>[];
      try {
        gmail = await session.google.gmail();
        const ids = (await googleCall(() => searchMessages(gmail, query, 8))).map((m) => m.gmailId);
        messages = await googleCall(() => Promise.all(ids.map((id) => getMessageWithAttachments(gmail, id))));
      } catch (err) {
        if (!(err instanceof ToolDataError)) throw err;
        // Live Gmail is out of reach — not connected, or the grant needs
        // renewing. Left to the model, whether it then thought to look in
        // the stored documents varied from one run to the next, and when it
        // did not, the person was told the file could not be got while it
        // sat in the system. So the fallback happens here, every time.
        const stored = await findStoredDocuments(ctx, refs, {
          search: [input.search, input.from, input.filename].filter(Boolean).join(' '),
        });
        const count = Number(stored.total ?? 0);
        return {
          ...stored,
          live_gmail: `unavailable: ${err.message}`,
          note: count
            ? `Live Gmail could not be searched (${err.message}), but these attachments are already stored in the system. Hand them over with their refs; mention in the caveat that older mail could not be searched.`
            : `Live Gmail could not be searched (${err.message}), and no stored attachment matches either. Say both plainly, and name the fix.`,
        };
      }

      const wantedName = input.filename ? String(input.filename).toLowerCase() : null;
      const files: Record<string, unknown>[] = [];
      for (const m of messages) {
        for (const att of m.files) {
          // Gmail matched the message; the name filter picks the file on it,
          // so a thread with a PDF and six photos returns the PDF.
          if (wantedName && !att.filename.toLowerCase().includes(wantedName.replace(/^\./, ''))) continue;
          const row = gmailFileRow(ctx.orgId, m.gmailId, att, {
            from: m.from, subject: m.subject, receivedAt: m.receivedAt,
          });
          files.push({
            ref: refs.add('F', row),
            filename: att.filename,
            type: fileKind(att.filename, att.mimeType),
            size: bytes(att.size),
            from: m.from,
            subject: m.subject,
            received: m.receivedAt,
          });
          if (files.length >= 25) break;
        }
      }

      return {
        query,
        found: files.length,
        files,
        note: files.length
          ? 'Answer with these refs to hand the files over — each gets Download and Open buttons.'
          : 'No attachment in the mailbox matched. Say so plainly, and say what was searched for.',
      };
    }

    case 'gmail_search': {
      const gmail = await session.google.gmail();
      const max = Math.min(Math.max(Number(input.max) || 10, 1), 20);
      const found = await googleCall(() => searchMessages(gmail, String(input.query ?? ''), max));

      // Open the message in the BUILT-IN inbox whenever the system has it.
      //
      // A Gmail web permalink (mail.google.com/.../#all/<id>) leaves the app,
      // and on a phone or an iPad it does not even reach the thread: mobile
      // Gmail ignores the #all hash and shows the inbox, and the hard-coded
      // u/0 opens whichever Google account is signed in first — the wrong one,
      // or a personal mailbox, which is the "random home page" people land on.
      // A message the system has ingested has a row here, and /inbox?open=<id>
      // opens it in place on every device. Only mail that was never ingested
      // falls back to Gmail, where nothing else can open it. Scoped by the
      // caller's own client, so an id is only used for mail they may see.
      const stored = new Map<string, string>();
      if (found.length && ctx.orgId) {
        const { data } = await db
          .from('emails')
          .select('id, gmail_id')
          .in('gmail_id', found.map((m) => m.gmailId));
        for (const r of (data ?? []) as { id: string; gmail_id: string | null }[]) {
          if (r.gmail_id) stored.set(r.gmail_id, r.id);
        }
      }

      return {
        total: found.length,
        messages: found.map((m) => {
          const inApp = stored.get(m.gmailId) ?? null;
          return {
            ref: refs.add('E', {
              kind: 'email',
              title: m.subject || '(no subject)',
              detail: m.snippet || null,
              // In-app when we have it; the Gmail link only when we do not.
              ...(inApp ? { id: inApp } : { url: gmailMessageUrl(m.gmailId) }),
              fields: [field('From', addressOf(m.from)), field('Received', day(m.receivedAt))],
            }),
            message_id: m.gmailId,
            from: m.from,
            to: m.to,
            subject: m.subject,
            snippet: m.snippet,
            received_at: m.receivedAt,
          };
        }),
      };
    }

    case 'gmail_read': {
      if (!ctx.orgId) return { found: false, note: 'No studio is attached to this account.' };
      const gmail = await session.google.gmail();
      const id = String(input.message_id ?? '').trim();
      if (!id) return { found: false, note: 'A message_id from gmail_search is needed.' };

      const m = await googleCall(() => getMessageWithAttachments(gmail, id));
      const orgId = ctx.orgId;
      return {
        found: true,
        message_id: m.gmailId,
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        received_at: m.receivedAt,
        body: m.body.slice(0, 4000),
        links: linksIn(m.body).map((l) => l.url),
        attachments: m.files.map((att) => ({
          ref: refs.add('F', gmailFileRow(orgId, m.gmailId, att, {
            from: m.from, subject: m.subject, receivedAt: m.receivedAt,
          })),
          filename: att.filename,
          type: fileKind(att.filename, att.mimeType),
          size: bytes(att.size),
        })),
      };
    }

    // ── Live Drive ────────────────────────────────────────────

    case 'drive_search': {
      if (!ctx.orgId) return { found: 0, note: 'No studio is attached to this account.' };
      const drive = await session.google.drive();
      const orgId = ctx.orgId;

      let folderId: string | undefined;
      if (input.folder) {
        folderId = (await googleCall(() => findFolderId(drive, String(input.folder)))) ?? undefined;
        if (!folderId) return { found: 0, note: `No folder named like "${input.folder}" was found in Drive.` };
      }
      const kinds: DriveKind[] = ['pdf', 'image', 'document', 'spreadsheet', 'presentation', 'folder'];
      const kind = kinds.includes(input.kind as DriveKind) ? (input.kind as DriveKind) : undefined;

      const hits = await googleCall(() =>
        searchDriveFiles(drive, {
          search: typeof input.search === 'string' ? input.search : undefined,
          kind,
          folderId,
          max: Number(input.max) || 10,
        }),
      );

      return {
        found: hits.length,
        files: hits.map((h) => ({
          // A folder cannot be downloaded; it is shown as a link to open.
          ref:
            h.mimeType === 'application/vnd.google-apps.folder'
              ? refs.add('L', { kind: 'link', title: h.name, url: h.webViewLink, fields: [field('Type', 'Folder')] })
              : refs.add('F', driveFileRow(orgId, h)),
          file_id: h.id,
          name: h.name,
          type: fileKind(h.name, h.mimeType),
          size: bytes(h.size),
          modified: h.modifiedTime,
        })),
        note: hits.length
          ? 'Answer with these refs to hand the files over. Use drive_read with a file_id to read what a Doc or Sheet says.'
          : 'Nothing in Drive matched. Say so plainly, and say what was searched for.',
      };
    }

    case 'drive_read': {
      if (!ctx.orgId) return { found: false, note: 'No studio is attached to this account.' };
      const drive = await session.google.drive();
      const fileId = String(input.file_id ?? '').trim();
      if (!fileId) return { found: false, note: 'A file_id from drive_search is needed.' };

      const file = await googleCall(() => getDriveFile(drive, fileId));
      const content = await googleCall(() => readDriveText(drive, file));
      return {
        found: true,
        ref: refs.add('F', driveFileRow(ctx.orgId, file)),
        name: file.name,
        type: fileKind(file.name, file.mimeType),
        text: content,
        note: content === null
          ? 'This kind of file cannot be read as text. Hand it over with its ref instead of describing it.'
          : content.length >= 6000
            ? 'Only the first part of the file is shown.'
            : null,
      };
    }

    case 'propose_draft': {
      if (!canWith(ctx.permissions, ctx.role, 'drafts', 'create')) {
        return { refused: true, reason: 'Your role cannot create drafts.' };
      }
      const subject = text(input.subject, 200);
      const body = typeof input.body === 'string' ? input.body.trim().slice(0, 10_000) : '';
      if (!subject || !body) return { refused: true, reason: 'A draft needs a subject and a body.' };

      // Addresses only — a display name or stray words here would end up in
      // a To: line that Gmail then refuses.
      const addresses = (v: unknown) =>
        String(v ?? '')
          .split(/[,;]/)
          .map((a) => addressOf(a))
          .filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a))
          .join(', ');
      const to = addresses(input.to);
      const cc = addresses(input.cc);
      const replyToEmailId = typeof input.reply_to_email_id === 'string' ? input.reply_to_email_id : undefined;

      const summary = `Draft "${subject}"${to ? ` to ${to}` : ''}`;
      proposed.push({ tool: 'propose_draft', summary, input: { to, cc, subject, body, reply_to_email_id: replyToEmailId } });
      return {
        proposed: true,
        summary,
        note: "Awaiting the user's confirmation; once confirmed it is saved to Drafts, NOT sent. Say you have prepared it — never that it was sent or saved.",
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── The loop ────────────────────────────────────────────────

/**
 * A few headline numbers, read before the conversation starts.
 *
 * Without it the assistant knows only that tools exist, so "how many
 * projects do we have?" costs a tool round-trip — two Claude calls where
 * one would do. That is slow, and on a function with a hard time limit it
 * is the difference between an answer and a dropped connection. Anything
 * past these headlines still comes from the tools.
 *
 * Read with the caller's own client, so it shows only what that person is
 * allowed to see. Never throws: a snapshot that cannot be read leaves the
 * assistant asking, which is what it did before.
 */
async function studioSnapshot(ctx: AssistantContext): Promise<string> {
  const { db } = ctx;
  const today = new Date().toISOString().slice(0, 10);

  /** One `count` query, reported as null rather than thrown when it fails. */
  const count = async (build: () => PromiseLike<{ count: number | null; error: unknown }>) => {
    try {
      const { count: n, error } = await build();
      return error ? null : (n ?? 0);
    } catch {
      return null;
    }
  };
  const head = (table: string) => db.from(table).select('*', { count: 'exact', head: true });

  const [projects, activeProjects, openTasks, overdueTasks, unassignedTasks, vendors, openPos, followUps, drafts, specGaps] =
    await Promise.all([
      count(() => head('projects')),
      count(() => head('projects').eq('status', 'active')),
      count(() => head('tasks').in('status', LIVE)),
      count(() => head('tasks').in('status', LIVE).lt('due_date', today)),
      count(() => head('tasks').in('status', LIVE).is('assigned_to', null)),
      count(() => head('vendors')),
      count(() => head('purchase_orders').not('status', 'in', '(received,cancelled)')),
      count(() => head('follow_ups').eq('status', 'open')),
      count(() => head('drafts')),
      count(() => head('spec_gaps').eq('resolved', false)),
    ]);

  // When the mail was last read, so "is this up to date?" needs no tool.
  let lastRead = 'no record of a run yet';
  try {
    const { data } = await db
      .from('activity_log')
      .select('created_at')
      .eq('action', 'ingest.run')
      .order('created_at', { ascending: false })
      .limit(1);
    const at = (data?.[0] as { created_at?: string } | undefined)?.created_at;
    if (at) lastRead = `${at.slice(0, 16).replace('T', ' ')} UTC`;
  } catch {
    // Leave the wording as it is rather than failing the whole answer.
  }

  const say = (n: number | null) => (n === null ? 'unknown' : String(n));

  return `Where the studio stands right now, counted before you were asked:
- Projects: ${say(projects)} in total, ${say(activeProjects)} active.
- Tasks: ${say(openTasks)} open, ${say(overdueTasks)} of them overdue and ${say(unassignedTasks)} with nobody on them.
- Vendors: ${say(vendors)}. Purchase orders still open: ${say(openPos)}.
- Follow-ups waiting: ${say(followUps)}. Reply drafts waiting to be sent: ${say(drafts)}.
- Unresolved spec gaps: ${say(specGaps)}.
- Gmail and Drive last read: ${lastRead}.

Answer "how many" and "how are we doing overall" questions straight from these numbers —
do not call a tool to count them again. Use the tools when the question needs names,
dates, amounts, or anything not listed here. A number shown as "unknown" could not be
read: say you could not check it rather than guessing.`;
}

/** The screens a person can ask from, as they would name them. */
const SCREENS: Record<string, string> = {
  '/': 'the Dashboard',
  '/projects': 'the Projects list',
  '/vendors': 'the Vendors & purchase orders screen',
  '/inbox': 'the Inbox',
  '/documents': 'the Documents screen',
  '/prompts': 'Prompt Studio',
  '/tasks': 'the task board',
  '/follow-ups': 'the Follow-ups screen',
  '/drafts': 'the Drafts screen',
  '/reports': 'the Reports screen',
  '/activity': 'the Audit Log',
  '/team': 'Team & Roles',
  '/permissions': 'the Permissions screen',
  '/settings': 'Settings',
};

/** One line of the studio's own data, safe to set inside the prompt. */
const inline = (s: string | null | undefined) => (s ?? '').replace(/[\r\n"]+/g, ' ').trim().slice(0, 120);

/**
 * What the person is looking at, in a sentence for the prompt — or null.
 *
 * A personal assistant beside you can see your screen; "is this one late?"
 * needs no project name. The browser sends only the path, and a project it
 * names is read with the caller's own client, so the answer is never a
 * record they could not have opened themselves.
 */
async function describePage(ctx: AssistantContext): Promise<string | null> {
  const path = ctx.page?.path;
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 300) return null;
  const clean = path.split(/[?#]/)[0];

  const project = clean.match(/^\/projects\/([0-9a-f-]{36})$/i);
  if (project) {
    try {
      const { data } = await ctx.db
        .from('projects')
        .select('id, name, client_name, stage')
        .eq('id', project[1])
        .maybeSingle();
      const p = data as { id: string; name: string; client_name: string | null; stage: string } | null;
      if (p) {
        return `They are looking at the project "${inline(p.name)}"${p.client_name ? ` for ${inline(p.client_name)}` : ''} (project id ${p.id}). When they say "this project", "this one", "here" or "it" without naming anything, they mean this project — do not ask which.`;
      }
    } catch {
      // Unreadable context is no context; the question still gets answered.
    }
    return null;
  }

  const screen = SCREENS[`/${clean.split('/')[1]}`];
  return screen ? `They are on ${screen}, so "these" or "here" most likely means what that screen shows.` : null;
}

/**
 * What is waiting on the person, stated as fact at the top of the prompt.
 *
 * The conversation reaches the model as text, and text cannot say whether a
 * Confirm button was pressed. So the model read its own "I've prepared a
 * task" as the task existing, told the person it had been created, and —
 * when they typed "yes confirmed" — had no way to act on it. Now it is told
 * exactly what is unsaved, and holds the one tool that saves it.
 */
function pendingSection(ctx: AssistantContext): string {
  const pending = ctx.pending ?? [];
  if (!pending.length) return '';
  const lines = pending.map((p, i) => `  #${i + 1}  ${p.summary}`).join('\n');
  return `
Prepared earlier and NOT saved — waiting for ${ctx.name.split(/[\s@]/)[0]} to answer:
${lines}
If their message agrees to one of these, call respond_to_proposal with decision "confirm" before anything
else, then answer. If it declines one, "cancel". If it changes one, prepare it again and cancel the old.
None of these exists yet: never say any of them was created, added or saved until respond_to_proposal
says it was.
`;
}

/**
 * A spoken question, flagged as one.
 *
 * The browser's recogniser hears "Danish" for Denish and "Casa Lair" for
 * Casa Elar, and a model that takes the transcript at its word goes looking
 * for people and projects that do not exist. Told the question was spoken,
 * and given the other ways it was heard, it reads for what was meant.
 */
function spokenSection(ctx: AssistantContext): string {
  const heard = ctx.spoken?.alternatives ?? [];
  if (!heard.length) return '';
  const others = heard.slice(1);
  const otherLine = others.length ? `The other ways it was heard: ${others.map((a) => `"${a}"`).join('; ')}.` : '';
  return [
    '',
    'This message was SPOKEN and turned into text by the browser, which mishears — names above all.',
    otherLine,
    'Read it for what they most likely meant. Match any name against the team, the projects, the clients and',
    'the vendors before deciding someone or something does not exist, and never repeat a misheard word back as',
    'though it were right — use the real name.',
    '',
  ]
    .filter((line, i, all) => line || i === 0 || i === all.length - 1)
    .join('\n');
}

/**
 * The active agent(s), as an identity fact rather than a restriction bolted
 * on after the rest of the prompt. Empty selection returns '' so this is a
 * no-op — literally zero added text — for anyone who has not touched the
 * picker, which is what keeps that the unchanged default.
 */
function agentPersona(ctx: AssistantContext): string {
  const agents = ctx.agents ?? [];
  if (!agents.length) return '';
  if (agents.length === 1) {
    const key = agents[0];
    return `
Right now you are working as the studio's ${AGENT_LABELS[key]} ONLY: ${AGENT_BLURBS[key]} Nothing outside
that. If asked for something outside it, say plainly that you are set to ${AGENT_LABELS[key]} only and name
which agent covers it instead of trying the tool — never pretend the rest of the system does not exist, you
are just deliberately narrowed to this one job right now.
`;
  }
  const names = agents.map((key) => AGENT_LABELS[key]);
  const labels =
    names.length === 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  return `
Right now you are wearing more than one hat at once — ${labels}, together. Answer across all of them without
saying you are restricted, and mention which hat answered when it is useful to say so.
`;
}

/**
 * The half of the system prompt that does not move.
 *
 * Split from the rest so it can be cached. What stays here changes at most
 * once a day and usually never: who she is, who she is speaking to, and the
 * rules. What changes per question — the screen they are on, the live
 * figures, what is waiting to be confirmed — lives in `situation()` and is
 * appended after the cache breakpoint, where editing it costs nothing.
 *
 * Measured: caching the tool block alone took a turn from $0.0096 to
 * $0.0050, with about a quarter of the input still arriving fresh. This is
 * that quarter.
 */
function systemPrompt(ctx: AssistantContext): string {
  const first = ctx.name.split(/[\s@]/)[0] || ctx.name;
  const seat = ctx.seat ? SEATS[ctx.seat] : null;
  return `You are ${ASSISTANT_NAME}, the personal assistant to everyone at Janelle Interiors, a small
interior design studio. When someone greets you or asks who you are, say you are ${ASSISTANT_NAME}.
You are speaking with ${ctx.name} (role: ${ctx.role ?? 'unknown'}${seat ? `; seat: ${seat.label}, which owns ${seat.owns}` : ''}).
Call them ${first}. Today is ${new Date().toISOString().slice(0, 10)}.

Being their assistant, not a search box:
- "My", "me" and "I" mean ${ctx.name}. "My tasks" are the ones assigned to ${ctx.name} — filter by
  that name rather than asking whose.
- Think one step ahead. If the answer shows a problem, the useful thing is usually the next action
  — a chase drafted, a task prepared. Offer those as suggestions; do the reading yourself.
- Warm and brief, like someone who works with them every day. Use their first name only
  occasionally, never in every reply.
- Remember the conversation: "the first one", "that vendor", "send it to her" refer to what was
  just discussed. Resolve them from the conversation before searching again.
- Every answer carries up to three suggestions: the next things ${first} would plausibly ask, specific
  to what you just said, each something your tools can actually do.

${studioRules(ctx)}`;
}

/**
 * The half that changes with every question, appended after the cached
 * block so it never invalidates it.
 */
function situation(
  ctx: AssistantContext,
  snapshot: string,
  page: string | null,
  filesNote: string,
): string {
  return [
    page ? `Where they are right now: ${page}` : '',
    pendingSection(ctx),
    spokenSection(ctx),
    snapshot,
    filesNote,
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** What the studio is, what can be seen, and how every answer is shaped. */
function studioRules(ctx: AssistantContext): string {
  return `

You exist because the founder is the bottleneck: she is in client meetings all day and needs to know
where things stand without digging through the system, and to delegate by simply saying what she needs.
${agentPersona(ctx)}
Language:
- ALWAYS reply in English, whatever language the question was asked in. The studio works in English
  and the records are in English; a reply in another language cannot be pasted into an email or read
  by the rest of the team.
- You may still understand a question asked in another language — just answer it in English.

What you can see — the whole system, through the tools:
- Projects, their stages, budgets and install dates; the spec gaps blocking them.
- Tasks: who owns what, what is overdue, what has no owner.
- Vendors and purchase orders: what is on order, from whom, for how much, and what is late.
- Follow-ups: everywhere the system has noticed silence and wants someone chased.
- Email that has been read: who sent it, what it said in full, and every link in it.
- Reply drafts waiting for a person to send.
- The team and their roles, the morning digest, the weekly report.
- The studio’s own rules (how long before chasing) and the audit trail of what has happened.
- What the studio is spending on you.
- The studio's LIVE Gmail and Google Drive${canSupervise(ctx.role) ? '' : ' — but NOT for this person: their role cannot search the live mailbox or Drive, so use the stored-mail and document tools, which still hand over attachments'}:
  every message however old, every attachment of any type, every file in Drive, and what a Doc or
  Sheet says. find_attachments is the fastest way to a file someone emailed; drive_search finds
  anything kept in Drive.
If a question touches any of that, there is a tool for it. Use it before saying you do not know.

Making things, not only finding them:
- You can WRITE the studio's design work: a moodboard, a design direction, a material selection
  package, a finish or FF&E schedule, an elevation brief, a design review, a completeness audit.
  Janelle wrote the prompts for these herself. list_studio_prompts shows them; run_studio_prompt
  produces the work.
- Always work from her prompt rather than a version of your own. The prompt is the studio's
  standard, and it is what makes two designers' boards read as one house.
- THE PROMPT LIBRARY IS A SHORTCUT, NOT A LICENCE. It holds the deliverables this studio makes every
  week. Asked for something it does not cover — a flooring-plan board, a lighting plan, a window
  schedule — do the work anyway, to the same standard, from your own knowledge as a senior designer:
  write it into the answer's document field, or pass a brief to render_board to have it drawn. NEVER answer that the
  studio has no prompt for it. That is a fact about a database table, not about what you can do.
- A PICTURE THEY ATTACHED IS A PICTURE YOU CAN CHANGE. A pencil sketch to be built as a photoreal
  visualisation, a plan to be rendered, a room to be restyled, an empty room to be furnished, a snapshot
  to be tidied up: that is make_image, which transforms the attachment itself and keeps its proportions.
  Never describe what the rendering WOULD show in place of making it, and never turn it down as "not a
  board" — it never was one. render_board is only for the studio's own template pages. Pass their prompt
  as they wrote it: someone who has written a careful brief has already said what they want.
- DO NOT OFFER TO MAKE A PICTURE. MAKE IT. Someone who attached a room and asked for it designed has
  already asked; "would you like me to generate a visualisation?" spends their turn and gives them
  nothing. Write the scheme AND call make_image in the same turn, then show both — the words in the
  document, the render in the items. Ask only when you genuinely cannot proceed, and never as a way of
  checking they meant it.
- THE BRIEF IS NOT YOUR ANSWER. What you pass to make_image describes the frame — the room, the pieces,
  the materials, the light, the camera. Your sentences to the person go in the answer, not into the
  brief: a brief beginning "Here's a complete interior design for your empty room" is narration, and the
  model draws the words instead of the room.
- DESIGN WORK DOES NOT NEED A RECORD. "Design a kitchen", "make a moodboard", "draw the board for a
  new project" ask for your professional judgement, not for a lookup. If they name no project, or name
  one the system has never heard of, DO THE WORK ANYWAY — from what they told you plus what a senior
  designer would assume of a room like that. Never require a project to exist first, never ask them to
  create one, and never send them away to fetch a brief. A project record is only where a run gets
  filed; it is not permission to design.
- State your assumptions instead of asking for them. A room and a direction are enough to start: assume
  a typical size, ceiling and layout, say plainly what you assumed, and let them correct it. One
  question is the most you may ask, and only when the answer changes the design rather than decorating
  it — "which room" is worth asking, "what is the budget level" is not.
- Fill the prompt's inputs from what they told you and from what you can read — the project, the
  room, the approved direction, the selections already on file. Never invent a dimension, product or
  SKU and present it as chosen: an assumption is written as one.
- What comes back IS the work. Put it in the answer's document, whole and unedited, with a title;
  keep the lead to one sentence saying what you made. Never retype it into the lead or into rows,
  and never summarise it away.

Handing things over:
- When someone asks for a file — an attachment, a drawing, a quote, a photo, a spreadsheet — GIVE THEM
  THE FILE. Find it, then put its ref in items; the row becomes Download and Open buttons. Never
  describe a file you could hand over, and never send someone to Gmail or Drive to fetch it
  themselves.
- Stored mail first when it is recent and about a project (read_email lists its attachments as
  files); find_attachments or gmail_search when it is older, or not found there.
- If several files match, hand over all of them rather than asking which one.
- To answer from what a PDF, an image or a SPREADSHEET says or shows — "from this PDF give me the living
  room furniture and decor", "what finishes are in the proposal", "what flooring is scheduled", "show me
  the dining room board" — call read_document with the file's ref. Give the answer in the lead, the pieces
  as rows, and ALWAYS include the preview ref it returns, so they see the pages themselves. Never say you
  cannot open or see a PDF, an image or a workbook.
- FINDING A FILE IS NOT ANSWERING. If what they asked for is INSIDE something you found — the finishes
  in a schedule, the flooring in a workbook, the specification in a plan set — OPEN IT and answer from
  its contents, then hand the file over as well. "The selections are listed in the Finish Schedule" is
  not an answer when you are holding the Finish Schedule: read it, and say WF-01 is white oak, T-01 is
  the 12x24 porcelain, and so on. A schedule as .xlsx opens like any other document.
- THE STUDIO'S OWN DRAWING BEATS ONE YOU MAKE. Before drawing or writing a NAMED deliverable — "the
  whole house flooring plan", "the door and window schedule", "the lighting plan", "the finish
  schedule" — LOOK FOR IT FIRST. It is usually ONE PAGE INSIDE A PLAN SET, not a file of its own: a
  65-page Plans.pdf holds the flooring plan, the door schedule and the elevations as separate pages.
  So find the plan set (search_documents, drive_search, find_attachments), call read_document asking
  which page shows the thing they named, and hand back the page preview ref it returns — that shows
  them the issued drawing itself. Only draw your own when there is genuinely none, and then SAY SO in
  as many words: "the studio has not issued one, so this is mine to check". Never present something
  you drew as though it were the studio's issued document. A board you invented that contradicts the
  approved one — wood specified in the living room, tile in your version — is worse than no board.
- A HOUSE-WIDE ANSWER IS ASSEMBLED, NOT LOOKED UP. Asked for "the whole house flooring plan" when no
  single file carries that name, do not report that none is labelled that way. Read the plan set and the
  flooring schedule you DID find, and give the whole picture: every room, the material scheduled for it,
  and the tile and grout by code. Hand over the files you read, and say which rooms are still TBD. One
  document per room is not a reason to answer with two filenames.
- You cannot send email, and you cannot change anything in Drive. To get an email written, use
  propose_draft: the person confirms, it goes to Drafts AND into the studio's real Gmail Drafts, and
  they send it themselves from there. Say it is prepared — never that it was sent. When the draft
  answers a specific message you looked up with search_email or read_email, pass that email's id as
  reply_to_email_id — that is what lands the draft inside the actual Gmail thread instead of as a
  disconnected new message, and it is the difference between "I found it in Gmail" and "I couldn't".

How to behave:
- You CAN look things up. When asked for anything held in the studio’s records — a project,
  a task, an order, a vendor, an email, who owns what, what is overdue — call the tools and
  answer with what they return. Never say you are unable to access the system.
- You CAN read whole emails. read_email returns the full text of a message, every link in it, and
  every attachment parsed from it. Never say you "can only see subjects, senders and snippets", or
  that you cannot extract or share a link — that was true of an earlier version of you and is false
  now. If you said anything like it earlier in THIS conversation it was wrong: ignore it, call
  read_email, and answer from the message itself.
- ALWAYS answer from the tools. Never guess a status, a date, an owner or a number. If a tool returns
  nothing, say plainly that there is no record of it.
- A tool error is NOT an empty result. If a tool reports it could not read something, say that you
  could not check and why. Never turn a failure to read into "there are none" — that is the one
  mistake that would make you untrustworthy.
- Never say something "was not parsed", "was not captured" or "is not in the system" until you have
  called read_email on the actual message. search_email returns summaries; the summary leaving
  something out does NOT mean the email did. A link, a measurement, a price, a name, a date — all of
  that lives in the body, and read_email is what reads it. Sending someone to Gmail for a detail you
  had not looked for yet is the same failure as inventing one.
- When asked for a link, give the URL itself. read_email returns every link in a message, already
  extracted — quote it exactly, never reconstruct or shorten it.
- "I could not find X" and "X is not stored" are different answers and must never be swapped. If
  read_email says a body is not stored, you have not looked at that message: say the text has not
  been captured yet and how to capture it. Claiming a link is absent from an email you could not
  read is exactly the mistake that makes you untrustworthy.
- When something is missing, name the one action that fixes it. Never ask the person to narrow the
  question down instead.
- Lead with the answer, then the reason. Name people and projects plainly.
- Never pad. No preamble, no "I checked the system and".
- End on the answer. Do NOT close with an offer or a question — no "would you like me to…",
  no "let me know if…", no "shall I…". If a further lookup would obviously help, just do it in
  the same turn instead of asking permission; reading is never something to ask about.
- If part of an answer is unavailable, give the part that IS available first and keep the caveat
  to one clause. Never lead with what you could not do.
- Flag anything a client is waiting on: that is the studio's sorest point.
- When asked to get something done, call propose_task. A proposal is NOT a completed action — say it
  is ready and that they can say yes or press Confirm. Something exists only once respond_to_proposal
  or the Confirm button has saved it; until then never say it was created, added or saved.
- The studio's task list — "the task list", "the tasks", "the board", "the task module", "my to-do
  list" — is the Tasks board in THIS system. list_tasks reads it and propose_task adds to it. It is
  never a document in Drive, and you never need to ask whether they mean one.
- To raise a task from an email — "make a task from Brianna's email for Denish, due Friday": find the
  email (search_email; without_task: true lists mail that has no task yet), then call propose_task with
  its email_id and the owner and date they asked for. Write the title from what the email actually asks,
  naming the job by the project it is filed under — never "X's project".
  · This is not only for that exact phrasing. ANY task whose title or detail comes from something a
    specific stored email said — including one you decided needed doing yourself while answering "check
    my email" or a digest, not just one asked for by name — gets that email's id in email_id. Skipping
    it because nobody said the word "email" is how a task that is plainly about one message ends up
    shown as "added by hand", with no way back to what actually asked for it.
- If that email already has a task, never raise a second one: call propose_task_update on the task it
  has, with the owner and date they asked for.
- Before EVERY propose_task, not only one tied to a specific email: check list_tasks (or what you
  already have from this turn) for one already covering the same work on the same project or vendor —
  "chase X for a quote" and "review X's quote" on the same job are the same piece of work under two
  names. Found one → propose_task_update on it instead, never a second task. This matters most exactly
  when there is no single email to check against — deciding on your own that something needs doing
  while reading a digest or a mailbox, rather than being asked for it by name, is how a task ends up
  duplicating one the automated reading pass already raised and is quietly tracking.
- To change a task already on the board — who owns it, when it is due, its status, its next step —
  call propose_task_update. Relative dates ("Friday", "end of next week") are worked out from today.
- When asked whether something was done — "has it been added?", "did that save?", "check the task
  list" — look: list_tasks for a task, list_drafts for a draft. Answer from what is there, never from
  what the conversation says should have happened.
- When a message could mean this system or something outside it, it means this system. Do not ask.
- Ask the person a question only when you truly cannot go on — a name that matches nobody, two
  equally likely records. Choices you could offer belong in suggestions; the lead never ends with
  "Would you like me to…".
- If a tool refuses on permissions, say so plainly and name who can do it instead.
- All money is US dollars. Never use another currency symbol.
- If you genuinely cannot tell, say so. Do not fill the gap with something plausible.

How to answer — the shape, not the words:
- EVERY answer is delivered by calling the answer tool. Never reply with ordinary text; text is not
  shown to the person. Call it once, on its own, after the last lookup.
- lead is the answer in one or two sentences. It is read first and on its own, so it must stand up
  without the rows: "Three orders are late, the worst by twelve days" — not "Here is what I found".
- items are the records the answer is ABOUT, one row each, and they are what makes an answer useful:
  each row opens straight through to that project, task, order or email, and a file row is the file
  itself. So whenever an answer names records — the projects, the overdue tasks, the late orders, the
  attachments — put them in items rather than listing them in the lead. This applies to a digest just
  as much as a list: "three problems need your decision" naming the Lemon fabric, the furniture
  approval and the finish schedule by name in the LEAD, with no rows, is the exact mistake to avoid —
  each of those is a task with a ref, so it is a row.
  · Every row a tool returns has a ref ("P3", "T1", "F2"). Answer with { "ref": "P3" } — that is a
    complete row: the server lays out its name, every figure as a formatted column, and for a file
    the download. Do NOT copy titles, amounts or dates out of the tool result into a row.
  · An email with a reply already drafted is two rows, not one: the email row (kind "email", from
    search_email or read_email) AND the draft row (kind "draft", from list_drafts), so the person can
    open the source thread and the drafted reply as two separate clicks — never make them re-search
    for the draft after reading about the email, or the other way around.
  · Add meta or tone to a ref only when you have judgement to add: "worst", "client waiting". A row
    already shows its client, stage, dates, amounts and counts as columns — meta must never repeat
    any of them. When in doubt, leave meta out.
  · Only for something no tool gave a ref, write the row out: kind, title, detail, meta.
  · tone: crit for a client left waiting or a real breach, warn for slipping, good for settled.
  · Up to 25 rows. Asked for a list — "our projects", "all open orders" — give the WHOLE list up to
    25, in a sensible order, and put the count of the rest in more. Never truncate silently.
- Do NOT repeat the rows inside the lead. Say how many and how bad; the rows say which. For a list
  someone asked for, the lead is the count plus at most ONE thing worth noticing — "Four projects,
  one of them on hold." — and never a walk through the rows, however few there are.
- A URL belongs in a row's url, never typed into the prose. A document, a Canva board, a tracking
  page: give it a row of its own with what it is as the title.
- speech is the same answer for someone who is driving: one or two sentences, no lists, no ids, no
  URLs. Name the worst one or two and say how many others there are.
- caveat is for something that genuinely failed to load, in one clause. It is not for hedging.`;
}

/**
 * Answer one question about the studio, consulting real data. Runs a
 * bounded tool loop; writes come back as proposals rather than actions.
 */
export async function ask(
  message: string,
  history: AssistantTurn[],
  ctx: AssistantContext,
  opts: AskOptions = {},
): Promise<AssistantResult> {
  if (!(await isAiReady(ctx.orgId))) {
    throw new Error('Claude is not set up yet — add an API key in Settings.');
  }

  // Progress is a courtesy: a listener that throws must never cost the answer.
  const status = (text: string) => {
    try {
      opts.onStatus?.(text);
    } catch {
      /* the answer matters more than the progress line */
    }
  };

  const proposed: ProposedAction[] = [];
  const used: string[] = [];
  const session: ToolSession = {
    proposed,
    refs: new RefRegistry(),
    google: new GoogleAccess(ctx.orgId),
    settled: [],
    produced: null,
    startedJobs: [],
    startedAt: Date.now(),
  };
  const settled = session.settled;

  const fileRef = (token: string, grant: FileGrant) => {
    const pages = grant.pages?.length ? grant.pages : null;
    const image = grant.mimeType.startsWith('image/');
    return session.refs.add('F', {
      kind: 'file',
      title: grant.name,
      file: {
        name: grant.name,
        mimeType: grant.mimeType,
        size: grant.source === 'upload' ? grant.size : 0,
        source: grant.source,
        token,
        downloadable: true,
        webUrl: grantWebUrl(grant),
      },
      ...(pages ? { preview: 'pdf' as const, pages } : image && grant.source === 'upload' ? { preview: 'image' as const } : {}),
    });
  };

  // Files attached to this question. They come first: "this", with a file
  // just attached, means the file.
  const attached = (ctx.attached ?? []).map(({ token, grant }) => {
    const ref = fileRef(token, grant);
    const kind = grant.mimeType === 'application/pdf' ? 'PDF' : 'image';
    const size = grant.source === 'upload' ? sizeLabel(grant.size) : '';
    return `  ${ref}  “${grant.name}” (${kind}${size ? `, ${size}` : ''})`;
  });

  // Files handed over earlier in the conversation, under refs this question
  // can use — "from this PDF" means one of these.
  const attachedTokens = new Set((ctx.attached ?? []).map((f) => f.token));
  const earlierFiles = (ctx.recentFiles ?? [])
    .filter(({ token }) => !attachedTokens.has(token))
    .map(({ token, grant }) => {
      const ref = fileRef(token, grant);
      const pages = grant.pages?.length ? grant.pages : null;
      const who = grant.source === 'upload' ? ' (attached by the person earlier)' : '';
      return `  ${ref}  “${grant.name}”${who}${pages ? ` (pages ${pages.join(', ')} shown)` : ''}`;
    });

  const messages: Anthropic.MessageParam[] = [
    // Four turns rather than eight. The tail of a conversation is what
    // "that vendor" and "the first one" refer to; the head of it is paid
    // for on every question and almost never read.
    ...history.slice(-4).map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: message },
  ];

  status('Thinking');
  const [snapshot, page] = await Promise.all([studioSnapshot(ctx), describePage(ctx)]);
  const filesNote = [
    ...(attached.length
      ? [
          '',
          '',
          'The person ATTACHED these files to this question. "This", "it", "the file" and "the plan" mean them. Read them with read_document, passing the ref and what they asked, before answering anything about them — never search email or Drive for them, they are right here. When they ask only to look at a file, read it and say what it is and what matters in it.',
          ...attached,
        ]
      : []),
    ...(earlierFiles.length
      ? [
          '',
          '',
          'Files already handed over in this conversation — "this PDF", "that file", "the proposal" most likely means the latest of these:',
          ...earlierFiles,
        ]
      : []),
  ].join('\n');
  // Two blocks, not one string: everything up to the breakpoint is cached
  // and re-read at a tenth of the price, and what follows is free to differ
  // on every question.
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: systemPrompt(ctx), cache_control: { type: 'ephemeral' } },
  ];
  const now = situation(ctx, snapshot, page, filesNote);
  if (now) system.push({ type: 'text', text: now });

  // Six turns of tool use is minutes of work, and the function is killed
  // long before that — the caller then gets no response at all, not even an
  // error, which reads in the browser as "could not reach the server". So
  // the loop watches the clock as well as the turn count, keeping back the
  // time the slowest turn took so far, since a turn cannot be interrupted
  // Every way this turn can end goes out through here, so nothing the
  // session made is lost on the way.
  const done = (answer: AssistantAnswer): AssistantResult => {
    const full = withProduced(answer, session.produced);
    return { reply: answerToText(full), answer: full, proposed, used, settled, startedJobs: session.startedJobs };
  };

  // once it has started.
  const deadline = Date.now() + ASSISTANT_BUDGET_MS;
  const timeLeft = () => deadline - Date.now();
  let slowestTurn = 0;

  for (let turn = 0; turn < 6; turn++) {
    // Out of time with tool results in hand: spend what is left on an
    // answer rather than another lookup. Dropping every tool but `answer`
    // is what forces one, and it is a cheaper call than a tool turn.
    if (turn > 0 && timeLeft() <= slowestTurn) {
      const answer = await finalAnswer(ctx, system, messages, used, session.refs);
      return done(answer);
    }

    // After the first turn the model has results in hand; what it does next
    // is usually the answer, and saying so beats repeating "Thinking".
    if (turn > 0) status('Putting it together');
    const startedTurn = Date.now();
    const res = await createMessage(
      { feature: 'assistant.answer', orgId: ctx.orgId, actor: ctx.userId },
      {
        // Room for a drafted email in propose_draft, which is the one tool
        // whose input is long prose rather than a few words.
        max_tokens: 4096,
        system,
        tools: CACHED_TOOLS,
        // Every turn is a tool call, and the last is always `answer`. Left
        // free to reply in plain text, the model sometimes did — and a plain
        // reply has no rows, no suggestions, and is where "would you like me
        // to…" questions crept back in.
        tool_choice: { type: 'any' },
        messages,
      },
    );
    slowestTurn = Math.max(slowestTurn, Date.now() - startedTurn);

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    // The intended exit: `answer` called on its own, with every lookup done.
    // Nothing goes back to Claude — this IS the turn ending, and a further
    // round-trip would only be a chance to change its mind.
    const answered = toolUses.find((t) => t.name === 'answer');
    if (answered && toolUses.length === 1) {
      const answer = toAnswer((answered.input ?? {}) as Record<string, unknown>, used, session.refs);
      return done(answer);
    }

    if (toolUses.length === 0 || res.stop_reason !== 'tool_use') {
      // Answered as plain text instead. Take it — the words are what matter
      // — and lay them out as best they can be.
      const reply = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return done(answerFromText(reply, used));
    }

    messages.push({ role: 'assistant', content: res.content });

    // Said once per turn, naming everything under way: "Searching Gmail ·
    // Searching Google Drive" reads as one step, which it is.
    const doing = [...new Set(toolUses.map((t) => TOOL_STATUS[t.name]).filter(Boolean))];
    if (doing.length) status(doing.join(' · '));

    // Run side by side. A question that searches Gmail and Drive at once is
    // two slow network round-trips, and waiting for one before starting the
    // other spends the time budget on nothing. Promise.all keeps the
    // results in the order the calls were made.
    const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu): Promise<Anthropic.ToolResultBlockParam> => {
        // `answer` alongside a lookup means it was written before the data
        // came back. Sending it back as an error costs one turn and saves an
        // answer composed out of nothing — and every tool_use must carry a
        // result anyway, or the next call is rejected outright.
        if (tu.name === 'answer') {
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            content:
              'You called answer in the same turn as a lookup, so it was written before the results arrived. Read the results below, then call answer on its own.',
            is_error: true,
          };
        }

        used.push(tu.name);
        try {
          const out = await runTool(tu.name, (tu.input ?? {}) as Record<string, unknown>, ctx, session);
          return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) };
        } catch (err) {
          const msg =
            err instanceof ToolDataError
              ? `${err.message}. Tell the user you could not check this — do NOT say there are none.`
              : `Error: ${(err as Error).message}`;
          return { type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true };
        }
      }),
    );
    // All results go back in ONE user message, or Claude learns to stop
    // making parallel tool calls.
    messages.push({ role: 'user', content: results });
  }

  // Six turns and still no answer. Everything looked up is already in
  // `messages`, so ask for the answer itself rather than giving up on it.
  const answer = await finalAnswer(ctx, system, messages, used, session.refs);
  return done(answer);
}

/**
 * One last call to turn whatever was looked up into an answer.
 *
 * Reached when the clock ran out mid-loop, or when six turns went by
 * without one. Everything the tools returned is already in `messages`, so
 * this usually answers the question properly; it only falls back to an
 * apology if even this cannot be afforded.
 *
 * `answer` is the only tool offered and the model is made to call it, so
 * the shape is guaranteed — the path taken when things are going worst is
 * not the one that should also have to guess at a format.
 */
async function finalAnswer(
  ctx: AssistantContext,
  system: Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
  used: string[],
  refs: RefRegistry,
): Promise<AssistantAnswer> {
  try {
    const res = await createMessage(
      { feature: 'assistant.answer', orgId: ctx.orgId, actor: ctx.userId },
      {
        max_tokens: 1536,
        // The same blocks the turns above used, so the cache they paid to
        // write is read rather than rewritten, with the extra sentence
        // appended after it.
        system: [
          ...system,
          {
            type: 'text' as const,
            text: `You are out of time to look anything else up. Answer now, with the answer tool, from what you
already have. If what you have is not enough, say in the caveat which part you could not check.`,
          },
        ],
        // The whole tool list, with `answer` forced. The history is full of
        // calls to the other tools, and they stay defined so it reads as the
        // conversation it was; tool_choice is what rules out another lookup.
        tools: CACHED_TOOLS,
        tool_choice: { type: 'tool', name: 'answer' },
        messages,
      },
    );

    const call = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'answer',
    );
    if (call) return toAnswer((call.input ?? {}) as Record<string, unknown>, used, refs);

    // Forced tool use should make this unreachable, but an answer in plain
    // text is still an answer and must not be thrown away.
    const reply = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (reply) return answerFromText(reply, used);
  } catch (err) {
    console.error('[assistant] final answer failed:', (err as Error).message);
  }

  return answerFromText(
    used.length
      ? 'That took longer than I have — I checked part of it but could not finish. Ask me again, or ask for one thing at a time.'
      : 'That took longer than I have. Could you ask me again, or narrow it down a little?',
    used,
  );
}
