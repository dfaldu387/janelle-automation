import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Context,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CHECKIN_PROMPT, DIGEST_PROMPT } from '@janelle/shared';
import {
  AGENT_KEYS,
  ASSISTANT_NAME,
  type AgentKey,
  type AssistantAnswer,
  type AssistantItem,
  type MediaJobView,
} from '@janelle/shared';
import { useAuth } from './AuthContext';
import { api, apiStream, apiUpload, NetworkError } from '../lib/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useProject,
  type AssistantReply,
  type CheckinOutcome,
  type CheckinTask,
  type CheckinView,
  type ProposedAction,
  type SavedProposal,
} from '../lib/queries';
import {
  bestHearing,
  isUnheard,
  listen,
  soundsLikeEcho,
  speak,
  speechInputSupported,
  speechOutputSupported,
  stopSpeaking,
  type MicLevel,
  type StopListening,
} from '../lib/speech';

/**
 * Jenny, as one presence across the whole app.
 *
 * She used to live on a page of her own, and the conversation lived in that
 * page's state: step away to look at the project she had just named and the
 * whole exchange was gone. A personal assistant is the opposite — at hand
 * wherever you are, still holding the thread when you come back, and
 * speaking first when there is something you should know.
 *
 * So the conversation, the briefing, the voice loop and whether the panel is
 * open all live here, above the router's pages, and every surface that shows
 * Jenny — the side panel, the full page — renders the same state.
 */

/** A file the person attached to a question, as the server granted it. */
export interface AttachedFile {
  name: string;
  mimeType: string;
  size: number;
  /** Opaque grant: opens the file, and lets Jenny read it. */
  token: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Plain text: what the history sends back, and what Copy copies. */
  content: string;
  /** Files attached to a question. */
  files?: AttachedFile[];
  /**
   * For a question: made directly in Image or Video mode rather than asked of
   * Jenny — so editing it makes it again the same way.
   */
  made?: 'image' | 'video';
  /** When it was said, epoch ms. */
  at: number;
  answer?: AssistantAnswer;
  proposed?: ProposedAction[];
  /** Proposals already committed, so the button does not offer twice. */
  done?: string[];
  /** Proposals the person turned down. */
  dismissed?: string[];
  /**
   * A briefing is her speaking first; an error is a failure with a retry; a
   * check-in is the end-of-day list with a button per task.
   */
  kind?: 'briefing' | 'error' | 'checkin';
  /** For a check-in: the tasks, and what the person has answered about each so far. */
  checkin?: CheckinTask[];
  /**
   * The day's opening briefing, as opposed to the one every new conversation
   * starts with. Only this one names the conversation after itself — without
   * the distinction the list became a column of identical "Briefing · Sep 18"
   * rows, one for every chat anybody started.
   */
  daily?: boolean;
  /** For an error: the question to ask again. */
  retry?: string;
  /** For an error: the files that question carried. */
  retryFiles?: AttachedFile[];
  /**
   * For an error from Image or Video: make it again the same way. Without
   * it the retry went to Jenny as a question — Claude tokens on a request
   * that had said "no tokens spent", a render squeezed into what was left of
   * her turn, and, when that timed out too, a paragraph instead of a picture.
   */
  retryKind?: 'image' | 'video';
  /**
   * Clips still being drawn for this answer.
   *
   * A video does not exist when the answer that asked for it is sent, so
   * the job ids ride along and the screen waits on them. Each one that
   * finishes is added to `answer.items` and dropped from here; anything
   * left is still rendering, or failed and said why.
   */
  jobs?: string[];
}

/** One conversation in the list of past ones. */
export interface ConversationSummary {
  id: string;
  title: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** Questions asked in it. */
  questions: number;
  /** The last thing said, for the list. */
  preview: string;
}

/** Where the hands-free conversation is, for the voice bar to show. */
export type VoiceState = 'off' | 'listening' | 'thinking' | 'speaking';

interface AssistantCtx {
  messages: ChatMessage[];
  pending: boolean;
  /** What she is doing right now — "Searching Gmail" — while pending. */
  status: string | null;
  /**
   * Ask. `alternatives` are the other ways a spoken question was heard;
   * `files` are uploads attached to it.
   */
  send: (text: string, opts?: { alternatives?: string[]; files?: AttachedFile[]; replaceFrom?: string }) => void;
  /**
   * Make a picture or a clip directly, skipping the model turn entirely.
   * Used by the Create buttons, where there is nothing left to decide.
   */
  imagine: (text: string, kind: 'image' | 'video', opts?: { files?: AttachedFile[]; seconds?: number; replaceFrom?: string }) => void;
  /**
   * Change a question already asked and ask it again. Everything after it in
   * the conversation is replaced by the new answer, and it goes the way it
   * went the first time — to Jenny, or straight to Image or Video.
   */
  editMessage: (messageId: string, text: string) => void;
  /** Upload a file to attach to the next question. */
  uploadFile: (file: File, signal?: AbortSignal) => Promise<AttachedFile>;
  /** The studio's names, for choosing between hearings of a spoken question. */
  vocabulary: string[];
  /** Words heard so far in a hands-free turn, while the person is still talking. */
  interim: string;
  /** Stop waiting for the answer in progress. */
  stop: () => void;
  newConversation: () => void;

  /** Past conversations, pinned first, then the most recent. */
  conversations: ConversationSummary[];
  activeConversationId: string;
  openConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  pinConversation: (id: string, pinned: boolean) => void;
  /** Deletes it here, and the files attached in it from storage. */
  deleteConversation: (id: string) => void;
  /** Save a conversation as a text file. */
  downloadConversation: (id: string) => void;
  /** Put words in the box without sending — "Create a task for …". */
  prefill: { text: string; at: number } | null;
  setPrefill: (text: string) => void;
  /** Bumped to ask the composer to open its file picker. */
  attachRequest: number;
  requestAttach: () => void;
  markDone: (messageId: string, key: string) => void;
  markDismissed: (messageId: string, key: string) => void;
  /** Say, in the conversation, that something the person confirmed is saved. */
  acknowledge: (saved: SavedProposal) => void;

  /** Put the end-of-day check-in in the conversation now, whatever the hour. */
  startCheckin: () => void;
  checkinLoading: boolean;
  /** Remember what the person answered about one task in a check-in message. */
  setCheckinOutcome: (messageId: string, taskId: string, outcome: CheckinOutcome, note?: string | null) => void;

  briefingLoading: boolean;
  /** Things in a briefing nobody has opened yet — the launcher's badge. */
  unseen: number;

  open: boolean;
  setOpen: (open: boolean) => void;
  /** Bumped to ask whichever composer is showing to take focus. */
  focusRequest: number;
  requestFocus: () => void;

  /** The project on screen, by name, when there is one. */
  lookingAt: string | null;

  /** Named agent(s) switched on. Empty means every tool is reachable. */
  agents: AgentKey[];
  setAgents: (next: AgentKey[]) => void;

  handsFree: boolean;
  setHandsFree: (on: boolean) => void;
  voice: VoiceState;
  /** Skip the rest of what she is saying and listen straight away. */
  skipSpeaking: () => void;
  /** Take what has been heard as finished now, without waiting for the pause. */
  doneTalking: () => void;
  speakReplies: boolean;
  setSpeakReplies: (on: boolean) => void;
  micError: string | null;
  setMicError: (message: string | null) => void;
  /** What the microphone is hearing while listening; null when it is not. */
  micLevel: MicLevel | null;
  /**
   * The microphone is actually recording, not merely about to.
   *
   * `voice === 'listening'` is set the instant the turn passes to the
   * person; the recogniser starts some time after that, and on a Bluetooth
   * headset "some time" is seconds. The orb said "go ahead" through all of
   * it, so an answer given straight away was lost.
   */
  micLive: boolean;
  canListen: boolean;
  canSpeak: boolean;
}

/**
 * One context object for the life of the page, surviving hot reloads.
 *
 * When this file is edited in development, Vite re-runs it — and a plain
 * `createContext()` here would then make a SECOND context. The provider
 * renders the new one while any page still holding the previous copy of
 * this module reads the old one, finds nothing, and throws "useAssistant
 * must be used inside AssistantProvider" with the provider plainly in the
 * tree. Kept on `import.meta.hot.data`, the object is created once and
 * reused by every later version of the module. In a production build
 * `import.meta.hot` is undefined and this is an ordinary createContext.
 */
const Ctx: Context<AssistantCtx | null> =
  (import.meta.hot?.data.assistantCtx as Context<AssistantCtx | null> | undefined) ??
  createContext<AssistantCtx | null>(null);
if (import.meta.hot) import.meta.hot.data.assistantCtx = Ctx;

// ── Remembering the conversation ────────────────────────────

/** One conversation, as kept in this browser. */
interface Conversation {
  id: string;
  /** Set when the person renamed it; otherwise it is named by its first question. */
  title: string | null;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

interface Stored {
  /** 2 → 3 when the agent default became "all five on"; see `load`. */
  v: 2 | 3;
  conversations: Conversation[];
  activeId: string;
  /**
   * The local day this store belongs to. On a new day the conversations are
   * cleared on load (see `forToday`) so Jenny always opens on a clean slate —
   * yesterday's chat is not carried over.
   */
  activeDay?: string | null;
  /** The local day the last briefing was made, so there is one a day. */
  briefedOn: string | null;
  /** The local day the end-of-day check-in was last offered, so there is one a day. */
  checkedInOn?: string | null;
  unseen: number;
  /** Named agent(s) switched on, narrowing Jenny to their tools. Empty = unrestricted. */
  agents: AgentKey[];
}

/** An unvalidated value from storage or the wire, kept only if it is a known agent key. */
function agentsOf(raw: unknown): AgentKey[] {
  return Array.isArray(raw) ? raw.filter((a): a is AgentKey => (AGENT_KEYS as readonly string[]).includes(a)) : [];
}

/** The version-1 shape: one conversation, forever. */
interface StoredV1 {
  v: 1;
  messages: ChatMessage[];
  briefedOn: string | null;
  unseen: number;
}

/** Enough to scroll back through a day or two of one conversation. */
const KEEP = 60;
/** Conversations kept; past this the oldest unpinned ones go. */
const KEEP_CONVERSATIONS = 40;

const storageKey = (userId: string) => `janelle.assistant.v1.${userId}`;

/** The person's own calendar day — a briefing is "today's" where they are. */
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const blankConversation = (): Conversation => {
  const now = Date.now();
  return { id: newId(), title: null, createdAt: now, updatedAt: now, messages: [] };
};

/**
 * Every agent on, for somebody who has never chosen.
 *
 * The five between them reach every tool Jenny has, plus the always-on
 * handful, so this is not a narrowing — it is the same assistant, with the
 * five jobs she does named on the Agents tab instead of left to be guessed
 * at. Starting at none meant the tab opened on five switches all off, which
 * reads as a feature nobody turned on rather than as how Jenny already works.
 */
const allAgents = (): AgentKey[] => [...AGENT_KEYS];

const emptyStore = (): Stored => {
  const first = blankConversation();
  return { v: 3, conversations: [first], activeId: first.id, activeDay: localDay(), briefedOn: null, checkedInOn: null, unseen: 0, agents: allAgents() };
};

/**
 * A store brought up to today.
 *
 * Jenny starts every day clean — yesterday's chat is not kept. When the stored
 * day is not today's, the conversations, active tab, briefing and check-in all
 * reset; only the per-person agent choice is carried over, since it is a
 * setting, not a conversation. Same-day stores are returned untouched.
 */
function forToday(s: Stored): Stored {
  if (s.activeDay === localDay()) return s;
  return { ...emptyStore(), agents: s.agents };
}

/** The conversation on screen; there is always one. */
const activeOf = (s: Stored): Conversation =>
  s.conversations.find((c) => c.id === s.activeId) ?? s.conversations[0] ?? blankConversation();

/**
 * Read a person's saved conversations.
 *
 * Per person, not per browser: two people sharing a studio laptop must not
 * see each other's questions. The single conversation an older version kept
 * becomes the first in the list. Anything unreadable — a private window, a
 * shape from an older version — starts fresh rather than breaking the panel.
 */
function load(userId: string): Stored {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Stored | StoredV1;
    if (parsed?.v === 1 && Array.isArray(parsed.messages)) {
      const messages = parsed.messages;
      const conversation: Conversation = {
        id: newId(),
        title: null,
        createdAt: messages[0]?.at ?? Date.now(),
        updatedAt: messages[messages.length - 1]?.at ?? Date.now(),
        messages,
      };
      return forToday({ v: 3, conversations: [conversation], activeId: conversation.id, activeDay: localDay(), briefedOn: parsed.briefedOn ?? null, unseen: parsed.unseen ?? 0, agents: allAgents() });
    }
    if ((parsed?.v !== 2 && parsed?.v !== 3) || !Array.isArray(parsed.conversations) || !parsed.conversations.length) return emptyStore();
    const conversations = parsed.conversations.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages));
    if (!conversations.length) return emptyStore();
    const activeId = conversations.some((c) => c.id === parsed.activeId) ? parsed.activeId : conversations[0].id;
    /*
     * A v2 store that has never had an agent on is one that was written
     * before the default changed, not a decision to run with none — the
     * switches were off because that is where they started. Upgrading it
     * once turns them on; a deliberate "Turn all off" afterwards is saved
     * as v3 and left alone.
     */
    const agents = parsed.v === 2 && !agentsOf(parsed.agents).length ? allAgents() : agentsOf(parsed.agents);
    return forToday({ ...parsed, v: 3, conversations, activeId, agents });
  } catch {
    return emptyStore();
  }
}

/** Oldest first to go: never the one on screen, never a pinned one. */
function trimmed(s: Stored, keep: number, perConversation: number): Stored {
  const ranked = [...s.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = ranked.filter((c, i) => c.id === s.activeId || c.pinned || i < keep);
  return {
    ...s,
    conversations: s.conversations
      .filter((c) => kept.includes(c) && (c.messages.length || c.id === s.activeId))
      .map((c) => ({ ...c, messages: c.messages.slice(-perConversation) })),
  };
}

function save(userId: string, stored: Stored): void {
  const write = (s: Stored) => localStorage.setItem(storageKey(userId), JSON.stringify(s));
  // Storage full — answers with long tables add up. Let the oldest
  // conversations go first, then the start of long ones, rather than
  // losing everything.
  for (const [keep, per] of [[KEEP_CONVERSATIONS, KEEP], [20, KEEP], [8, 30], [1, 15]] as const) {
    try {
      write(trimmed(stored, keep, per));
      return;
    } catch {
      /* try smaller */
    }
  }
  /* storage is unavailable; the conversations last as long as the tab */
}

/** What a conversation is called in the list. */
function titleOf(c: Conversation): string {
  if (c.title) return c.title;
  const first = c.messages.find((m) => m.role === 'user');
  const said = first?.content.replace(/\s+/g, ' ').trim();
  if (said) return said.length > 64 ? `${said.slice(0, 61).trimEnd()}…` : said;
  if (first?.files?.length) return first.files.map((f) => f.name).join(', ');
  const at = new Date(c.messages[0]?.at ?? c.createdAt);
  return c.messages.some((m) => m.kind === 'briefing' && m.daily)
    ? `Briefing · ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    : 'New conversation';
}

/** A conversation as plain text, for keeping outside the app. */
function transcriptOf(c: Conversation, you: string): string {
  const lines = [`# ${titleOf(c)}`, ''];
  for (const m of c.messages) {
    const when = new Date(m.at).toLocaleString();
    const who = m.role === 'user' ? you : ASSISTANT_NAME;
    lines.push(`## ${who} — ${when}`, '');
    if (m.kind === 'error') lines.push(`(That did not work: ${m.content})`);
    else if (m.content) lines.push(m.answer?.lead && m.role === 'assistant' ? m.answer.lead : m.content);
    for (const f of m.files ?? []) lines.push(`- Attached: ${f.name}`);
    for (const item of m.answer?.items ?? []) {
      const facts = (item.fields ?? []).map((f) => `${f.label}: ${f.value}`).join('; ');
      lines.push(`- ${item.title}${item.detail ? ` — ${item.detail}` : ''}${facts ? ` (${facts})` : ''}`);
    }
    if (m.answer?.more) lines.push(`- …and ${m.answer.more} more`);
    for (const p of m.proposed ?? []) lines.push(`- Prepared: ${p.summary}`);
    lines.push('');
  }
  return lines.join('\n');
}

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** A briefing's count, as a person would count it. */
const thingsIn = (answer: AssistantAnswer) => answer.items.length + answer.more;

/** The browser's own name for one proposal on one message. */
const proposalKey = (messageId: string, index: number) => `${messageId}-${index}`;

/**
 * The conversation as the model will read it — with the truth about proposals.
 *
 * History is plain text, and plain text cannot say whether Confirm was
 * pressed. So the model read its own "I've prepared a task" as the task
 * existing and told the person it had been created when it had not. Each
 * proposal now carries its real state into the history: saved, turned down,
 * or still waiting.
 */
function historyOf(messages: ChatMessage[]) {
  return messages
    .filter((m) => m.kind !== 'error')
    .slice(-8)
    .map((m) => {
      const files = m.files?.length ? `\n[Attached: ${m.files.map((f) => f.name).join(', ')}]` : '';
      if (!m.proposed?.length) return { role: m.role, content: `${m.content}${files}`.trim() || '[Attached a file]' };
      const states = m.proposed.map((p, i) => {
        const key = proposalKey(m.id, i);
        if (m.done?.includes(key)) return `[Saved — the person confirmed it: ${p.summary}]`;
        if (m.dismissed?.includes(key)) return `[Not saved — the person turned it down: ${p.summary}]`;
        return `[NOT saved yet — waiting for the person to confirm: ${p.summary}]`;
      });
      return { role: m.role, content: `${m.content}\n\n${states.join('\n')}` };
    });
}

/**
 * Files Jenny handed over recently, newest last — so a question about "this
 * PDF" can reach the one she just gave. Only the grant tokens travel; the
 * server opens each one, and drops any it did not seal for this studio.
 */
function recentFilesOf(messages: ChatMessage[]) {
  const tokens: string[] = [];
  for (const m of messages.slice(-12)) {
    const handed = [...(m.files ?? []).map((f) => f.token), ...(m.answer?.items ?? []).map((item) => item.file?.token)];
    for (const token of handed) {
      if (!token) continue;
      const at = tokens.indexOf(token);
      if (at >= 0) tokens.splice(at, 1);
      tokens.push(token);
    }
  }
  return tokens.slice(-8).map((token) => ({ token }));
}

/** Everything shown to the person that they have not yet answered, oldest first. */
function pendingOf(messages: ChatMessage[]) {
  return messages.flatMap((m) =>
    (m.proposed ?? [])
      .map((p, i) => ({ key: proposalKey(m.id, i), tool: p.tool, summary: p.summary, input: p.input }))
      .filter((p) => !m.done?.includes(p.key) && !m.dismissed?.includes(p.key)),
  ).slice(-5);
}

/** A short line in her voice confirming what was saved, with the row to open it. */
function acknowledgement(saved: SavedProposal): AssistantAnswer {
  if (saved.kind === 'draft') {
    const lead = `Saved to Drafts${saved.to ? ` — ready to send to ${saved.to}` : ''}.`;
    return {
      lead,
      items: [{ kind: 'draft', id: saved.id, title: saved.subject, detail: saved.to ? `To ${saved.to}` : null, tone: 'good' }],
      more: 0,
      speech: 'Saved to your drafts.',
      sources: [],
      suggestions: [],
    };
  }
  const due = saved.due_date
    ? new Date(`${saved.due_date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    : null;
  if (saved.kind === 'task_update') {
    const lead = `Updated${saved.assignee ? ` — it's with ${saved.assignee}` : ''}${due ? `, due ${due}` : ''}.`;
    return {
      lead,
      items: [
        {
          kind: 'task',
          id: saved.id,
          title: saved.title,
          tone: 'good',
          fields: [
            { label: 'Owner', value: saved.assignee ?? 'Unassigned' },
            { label: 'Due', value: due ?? '—' },
            { label: 'Status', value: saved.status.replace(/_/g, ' ') },
          ],
        },
      ],
      more: 0,
      speech: lead,
      sources: [],
      suggestions: [],
    };
  }
  const lead = `Done — it's on the task board${saved.assignee ? ` for ${saved.assignee}` : ''}${due ? `, due ${due}` : ''}.`;
  return {
    lead,
    items: [
      {
        kind: 'task',
        id: saved.id,
        title: saved.title,
        tone: 'good',
        fields: [
          { label: 'Owner', value: saved.assignee ?? 'Unassigned' },
          { label: 'Project', value: saved.project ?? '—' },
          { label: 'Due', value: due ?? '—' },
        ],
      },
    ],
    more: 0,
    speech: `Done. It's on the task board${saved.assignee ? ` for ${saved.assignee}` : ''}.`,
    sources: [],
    suggestions: [],
  };
}

// ── Provider ────────────────────────────────────────────────

/** One conversation's messages with the day's briefing state — what most changes touch. */
interface View {
  messages: ChatMessage[];
  briefedOn: string | null;
  unseen: number;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;

  const [store, setStore] = useState<Stored>(() => (userId ? load(userId) : emptyStore()));
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [open, setOpenState] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);

  const [handsFree, setHandsFreeState] = useState(false);
  const [voice, setVoice] = useState<VoiceState>('off');
  const [speakReplies, setSpeakReplies] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [interim, setInterim] = useState('');
  // What the microphone is picking up right now, so the orb moves with the
  // voice rather than with a state flag — and a voice too quiet to be
  // transcribed is visible as it happens.
  const [micLevel, setMicLevel] = useState<MicLevel | null>(null);
  const [micLive, setMicLive] = useState(false);

  // Names a recogniser has never heard of — Denish, Casa Elar, Nordhaus —
  // used to pick the hearing that contains them. Rarely changes.
  const { data: vocabularyData } = useQuery({
    queryKey: ['assistant-vocabulary', userId],
    queryFn: () =>
      api<{ people: string[]; projects: string[]; clients: string[]; vendors: string[] }>('/assistant/vocabulary'),
    enabled: Boolean(userId),
    staleTime: 10 * 60_000,
  });
  const vocabulary = useMemo(
    () => (vocabularyData ? [...vocabularyData.people, ...vocabularyData.projects, ...vocabularyData.clients, ...vocabularyData.vendors] : []),
    [vocabularyData],
  );
  const vocabularyRef = useRef<string[]>([]);
  vocabularyRef.current = vocabulary;

  const canListen = speechInputSupported();
  const canSpeak = speechOutputSupported();

  // Refs for the voice loop, whose callbacks outlive the render that made them.
  const handsFreeRef = useRef(false);
  const speakRepliesRef = useRef(false);
  const stopListeningRef = useRef<StopListening | null>(null);
  const silencesRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const briefingInFlight = useRef(false);
  /** The last briefing built, reused across new conversations while it is fresh. */
  const briefingCache = useRef<{ day: string; hour: number; at: number; answer: AssistantAnswer } | null>(null);
  const storeRef = useRef(store);
  storeRef.current = store;
  speakRepliesRef.current = speakReplies;

  // A different person signed in: their conversation, not the last one's.
  const loadedFor = useRef<string | null>(userId);
  useEffect(() => {
    if (loadedFor.current === userId) return;
    loadedFor.current = userId;
    setStore(userId ? load(userId) : emptyStore());
  }, [userId]);

  useEffect(() => {
    if (userId) save(userId, store);
  }, [userId, store]);

  const active = activeOf(store);

  /**
   * Change one conversation — the one on screen unless another is named —
   * together with the day's briefing state. An answer lands in the
   * conversation it was asked in, whatever is on screen by then.
   */
  const update = useCallback(
    (fn: (s: View) => View, conversationId?: string) =>
      setStore((s) => {
        const id = conversationId ?? s.activeId;
        const target = s.conversations.find((c) => c.id === id);
        if (!target) return s; // deleted while the answer was on its way
        const before: View = { messages: target.messages, briefedOn: s.briefedOn, unseen: s.unseen };
        const after = fn(before);
        if (after === before) return s;
        return {
          ...s,
          briefedOn: after.briefedOn,
          unseen: after.unseen,
          conversations:
            after.messages === target.messages
              ? s.conversations
              : s.conversations.map((c) =>
                  c.id === id
                    ? {
                        ...c,
                        messages: after.messages,
                        updatedAt: after.messages.length > c.messages.length ? Date.now() : c.updatedAt,
                      }
                    : c,
                ),
        };
      }),
    [],
  );

  const append = useCallback(
    (message: Omit<ChatMessage, 'id' | 'at'>, conversationId?: string) =>
      update((s) => ({ ...s, messages: [...s.messages, { ...message, id: newId(), at: Date.now() }] }), conversationId),
    [update],
  );

  /**
   * Put a question in the conversation — at the end, or in place of an
   * earlier one being edited, dropping everything after it. One update, so
   * the old answers are never on screen beside the new question.
   */
  const ask = useCallback(
    (message: Omit<ChatMessage, 'id' | 'at'>, conversationId: string, replaceFrom?: string) =>
      update((s) => {
        const at = replaceFrom ? s.messages.findIndex((m) => m.id === replaceFrom) : -1;
        const kept = at < 0 ? s.messages : s.messages.slice(0, at);
        return { ...s, messages: [...kept, { ...message, id: newId(), at: Date.now() }] };
      }, conversationId),
    [update],
  );

  // ── Clips that are still rendering ────────────────────────

  /**
   * Wait for video the answer could not carry.
   *
   * A clip takes a minute or two, and the answer that asked for it was sent
   * long before — so the conversation holds the job ids and this waits on
   * them. Each poll asks the server, which asks the provider once and, the
   * first time it hears "done", fetches the mp4 into the studio's own
   * storage before the provider's temporary link goes stale.
   *
   * Only the conversation on screen is polled. Nothing is lost by that: the
   * cron sweep finishes every job server-side regardless, so a clip whose
   * tab was closed is waiting, finished, when that conversation is reopened
   * and this picks it up again.
   */
  const activeId = active.id;
  const pendingJobs = useMemo(
    () => [...new Set(active.messages.flatMap((m) => m.jobs ?? []))],
    [active.messages],
  );
  const pendingKey = pendingJobs.join(',');

  useEffect(() => {
    if (!pendingKey) return;
    const ids = pendingKey.split(',');
    let stopped = false;

    /** Drop the job from the message it belongs to, and show what came of it. */
    const settleJob = (jobId: string, item: AssistantItem | null, failure: string | null) =>
      update(
        (s) => ({
          ...s,
          messages: s.messages.map((m) => {
            if (!m.jobs?.includes(jobId)) return m;
            const left = m.jobs.filter((j) => j !== jobId);
            return {
              ...m,
              jobs: left.length ? left : undefined,
              answer: m.answer
                ? {
                    ...m.answer,
                    items: item ? [...m.answer.items, item] : m.answer.items,
                    caveat: failure ?? m.answer.caveat ?? null,
                  }
                : m.answer,
            };
          }),
        }),
        activeId,
      );

    const tick = async () => {
      for (const jobId of ids) {
        if (stopped) return;
        try {
          const job = await api<MediaJobView>(`/assistant/media/${jobId}`);
          if (job.status === 'done') settleJob(jobId, job.item, null);
          else if (job.status !== 'pending') {
            settleJob(jobId, null, job.error || 'The clip could not be made.');
          }
        } catch {
          // A blip is not a failure: the job is still on the server, and
          // the next tick asks again.
        }
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), 5_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pendingKey, activeId, update]);

  // ── What is on screen ─────────────────────────────────────

  const path = `${location.pathname}${location.search}`;
  const projectId = location.pathname.match(/^\/projects\/([0-9a-f-]{36})$/i)?.[1];
  // Usually already cached — the person is on that project's page.
  const { data: project } = useProject(projectId);
  const lookingAt = projectId ? (project?.project.name ?? null) : null;

  // ── The briefing ──────────────────────────────────────────

  const openRef = useRef(open);
  openRef.current = open;

  /** Put a briefing into a conversation — the same way whether built now or reused. */
  const placeBriefing = useCallback(
    (answer: AssistantAnswer, conversationId?: string, daily = false) => {
      const onPage = window.location.pathname.startsWith('/assistant');
      update((s) => ({
        ...s,
        briefedOn: localDay(),
        // Unseen only when nobody is looking: open panel, or the page.
        unseen: openRef.current || onPage ? 0 : thingsIn(answer),
        messages: [
          ...s.messages,
          { id: newId(), at: Date.now(), role: 'assistant', kind: 'briefing', daily, content: answer.lead, answer },
        ],
      }), conversationId);
    },
    [update],
  );

  /** How long a briefing may be replayed before it is rebuilt. */
  const BRIEFING_TTL_MS = 15 * 60_000;

  const fetchBriefing = useCallback(async (conversationId?: string, daily = false) => {
    if (briefingInFlight.current) return;

    // Reuse a briefing built moments ago rather than rebuilding it on the
    // server for every new conversation. The counts and the greeting are still
    // right inside the window; past it, on a new hour (when the greeting turns
    // over) or a new day, it is fetched afresh. It is a database read either
    // way — never a model call — but opening several chats in a row, or
    // reopening the panel, no longer repeats the work.
    const now = new Date();
    const cached = briefingCache.current;
    if (cached && cached.day === localDay() && cached.hour === now.getHours() && Date.now() - cached.at < BRIEFING_TTL_MS) {
      placeBriefing(cached.answer, conversationId, daily);
      return;
    }

    briefingInFlight.current = true;
    setBriefingLoading(true);
    try {
      const answer = await api<AssistantAnswer>(`/assistant/briefing?hour=${now.getHours()}`);
      briefingCache.current = { day: localDay(), hour: now.getHours(), at: Date.now(), answer };
      placeBriefing(answer, conversationId, daily);
    } catch {
      // No briefing is a quiet absence, not an error to show: the backend
      // may simply not be configured yet. The next load tries again.
    } finally {
      briefingInFlight.current = false;
      setBriefingLoading(false);
    }
  }, [placeBriefing]);

  // Once a day, as soon as the app is open — not when the panel is. That is
  // what lets the launcher show a count before anyone thinks to ask.
  useEffect(() => {
    if (!userId || store.briefedOn === localDay()) return;
    void fetchBriefing(undefined, true);
  }, [userId, store.briefedOn, fetchBriefing]);

  // ── The end-of-day check-in ───────────────────────────────

  const [checkinLoading, setCheckinLoading] = useState(false);
  const checkinInFlight = useRef(false);
  const navigate = useNavigate();

  /**
   * The day's check-in, into the conversation: the 5pm email's list with a
   * button per task. `force` is a person asking for it — the chip, the link
   * in the evening email — and gets an answer even when there is nothing
   * to check in about; the automatic one after four stays quiet instead.
   */
  const fetchCheckin = useCallback(
    async (opts: { force?: boolean } = {}) => {
      if (checkinInFlight.current) return;
      checkinInFlight.current = true;
      setCheckinLoading(true);
      try {
        const view = await api<CheckinView | null>(`/assistant/checkin?hour=${new Date().getHours()}`);
        setStore((s) => ({ ...s, checkedInOn: localDay() }));
        if (!view) {
          if (opts.force) {
            const lead = 'Nothing to check in about today — nothing of yours was due, and nothing is blocked. Have a good evening.';
            append({ role: 'assistant', content: lead, answer: { lead, items: [], more: 0, speech: lead, sources: [], suggestions: [] } });
          }
          return;
        }
        const onPage = window.location.pathname.startsWith('/assistant');
        update((s) => ({
          ...s,
          // Counted on the launcher like a briefing, when nobody is looking.
          unseen: openRef.current || onPage ? s.unseen : s.unseen + 1,
          messages: [
            ...s.messages,
            { id: newId(), at: Date.now(), role: 'assistant', kind: 'checkin', content: view.answer.lead, answer: view.answer, checkin: view.tasks },
          ],
        }));
        if (opts.force && !onPage) setOpenState(true);
      } catch (err) {
        if (opts.force) append({ role: 'assistant', kind: 'error', content: (err as Error).message, retry: CHECKIN_PROMPT });
      } finally {
        checkinInFlight.current = false;
        setCheckinLoading(false);
      }
    },
    [append, update],
  );

  const startCheckin = useCallback(() => {
    void fetchCheckin({ force: true });
  }, [fetchCheckin]);

  // ── The morning digest, read back without the model ──────────
  //
  // "Read me the digest" is answered here, like the check-in: it was already
  // written at 7am and stored, so reciting it costs a database read, not a
  // whole Claude turn with the system prompt and tool block behind it.
  const digestInFlight = useRef(false);
  const fetchDigest = useCallback(async () => {
    if (digestInFlight.current) return;
    digestInFlight.current = true;
    setBriefingLoading(true);
    try {
      const answer = await api<AssistantAnswer | null>('/assistant/digest');
      if (answer) append({ role: 'assistant', kind: 'briefing', content: answer.lead, answer });
    } catch (err) {
      append({ role: 'assistant', kind: 'error', content: (err as Error).message, retry: DIGEST_PROMPT });
    } finally {
      digestInFlight.current = false;
      setBriefingLoading(false);
    }
  }, [append]);

  // Once a day from four in the afternoon, as soon as the app is open — and
  // checked again every few minutes, for an app left open since the morning.
  useEffect(() => {
    if (!userId) return;
    const tick = () => {
      if (new Date().getHours() < 16 || store.checkedInOn === localDay()) return;
      void fetchCheckin();
    };
    tick();
    const timer = window.setInterval(tick, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [userId, store.checkedInOn, fetchCheckin]);

  // The evening email and Slack message link here: /assistant?checkin=1.
  useEffect(() => {
    if (!userId) return;
    const params = new URLSearchParams(location.search);
    if (params.get('checkin') !== '1') return;
    params.delete('checkin');
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params}` : '' }, { replace: true });
    void fetchCheckin({ force: true });
  }, [userId, location.search, location.pathname, navigate, fetchCheckin]);

  const setCheckinOutcome = useCallback(
    (messageId: string, taskId: string, outcome: CheckinOutcome, note?: string | null) =>
      update((s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.id !== messageId || !m.checkin
            ? m
            : { ...m, checkin: m.checkin.map((t) => (t.id === taskId ? { ...t, outcome, outcomeNote: note ?? null } : t)) },
        ),
      })),
    [update],
  );

  // ── Asking ────────────────────────────────────────────────

  const listenRef = useRef<() => void>(() => {});

  const deliver = useCallback((spokenText: string) => {
    if (handsFreeRef.current) {
      setVoice('speaking');
      speak(spokenText, () => {
        if (handsFreeRef.current) listenRef.current();
      });
    } else if (speakRepliesRef.current) {
      speak(spokenText);
    }
  }, []);

  /**
   * Make a picture or a clip straight away, with no model turn at all.
   *
   * `send` puts a question to Jenny, and she decides what to do with it —
   * which costs the system prompt, the studio snapshot and the whole tool
   * block on every attempt. When someone has pressed Image or Video there
   * is nothing left to decide, so this goes directly to the provider and
   * spends no tokens. The answer comes back in the same shape either way,
   * so the conversation cannot tell the difference.
   */
  const imagine = useCallback(
    (text: string, kind: 'image' | 'video', opts: { files?: AttachedFile[]; seconds?: number; replaceFrom?: string } = {}) => {
      const brief = text.trim();
      if (!brief || abortRef.current) return;
      const files = (opts.files ?? []).slice(0, 4);
      const conversationId = activeOf(storeRef.current).id;

      ask({ role: 'user', content: brief, made: kind, ...(files.length ? { files } : {}) }, conversationId, opts.replaceFrom);
      setPending(true);
      setStatus(kind === 'video' ? 'Starting the clip' : 'Drawing it');

      const controller = new AbortController();
      abortRef.current = controller;

      api<{ answer: AssistantAnswer; startedJobs: string[] }>('/assistant/imagine', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          prompt: brief,
          ...(opts.seconds ? { seconds: opts.seconds } : {}),
          attachments: files.map((f) => ({ token: f.token })),
        }),
        signal: controller.signal,
      })
        .then((data) => {
          append(
            {
              role: 'assistant',
              content: data.answer.lead,
              answer: data.answer,
              done: [],
              ...(data.startedJobs?.length ? { jobs: data.startedJobs } : {}),
            },
            conversationId,
          );
          deliver(data.answer.speech || data.answer.lead);
        })
        .catch((err: Error) => {
          if (err.name === 'AbortError') return;
          append(
            {
              role: 'assistant',
              kind: 'error',
              content: err.message || 'That could not be made.',
              retry: brief,
              retryKind: kind,
              ...(files.length ? { retryFiles: files } : {}),
            },
            conversationId,
          );
        })
        .finally(() => {
          abortRef.current = null;
          setPending(false);
          setStatus(null);
        });
    },
    [append, ask, deliver],
  );

  const send = useCallback(
    (text: string, opts: { alternatives?: string[]; files?: AttachedFile[]; replaceFrom?: string } = {}) => {
      const typed = text.trim();
      const files = (opts.files ?? []).slice(0, 4);
      if ((!typed && !files.length) || abortRef.current) return;

      // The two questions answered here rather than by the model: the check-in
      // and the morning digest. Both are already built and stored, so the chip
      // under the briefing — or the same words typed — reads them back without
      // spending a Claude turn.
      if (!files.length) {
        const asked = typed.replace(/[.!?]+$/, '').toLowerCase();
        if (asked === CHECKIN_PROMPT.toLowerCase()) {
          append({ role: 'user', content: typed });
          void fetchCheckin({ force: true });
          return;
        }
        if (asked === DIGEST_PROMPT.toLowerCase()) {
          append({ role: 'user', content: typed });
          void fetchDigest();
          return;
        }
      }
      // A file on its own still asks something: look at it.
      const message =
        typed || (files.length === 1 ? `Take a look at ${files[0].name}.` : `Take a look at these ${files.length} files.`);

      const conversation = activeOf(storeRef.current);
      const conversationId = conversation.id;

      // An edited question is asked as if what followed it never happened:
      // the old answers are not history, and a proposal made after it is
      // not still waiting on a yes.
      const cut = opts.replaceFrom ? conversation.messages.findIndex((m) => m.id === opts.replaceFrom) : -1;
      const before = cut < 0 ? conversation.messages : conversation.messages.slice(0, cut);

      // What was said before, as plain text. Failed exchanges are left out:
      // an error message in the history reads to the model as something it
      // said, and it starts apologising for it.
      const history = historyOf(before);
      const waiting = pendingOf(before);
      const earlier = recentFilesOf(before);

      ask({ role: 'user', content: typed, ...(files.length ? { files } : {}) }, conversationId, opts.replaceFrom);
      setPending(true);
      setStatus('Thinking');
      if (handsFreeRef.current) setVoice('thinking');

      const controller = new AbortController();
      abortRef.current = controller;

      let reply: AssistantReply | null = null;
      let failure: string | null = null;
      let answered = false;

      const body = {
        message,
        history,
        page: { path },
        pending: waiting,
        files: earlier,
        attachments: files.map((f) => ({ token: f.token })),
        ...(opts.alternatives?.length ? { spoken: { alternatives: opts.alternatives } } : {}),
        ...(storeRef.current.agents.length ? { agents: storeRef.current.agents } : {}),
      };
      const onEvent = (event: Record<string, unknown>) => {
        answered = true;
        if (event.type === 'status') setStatus(String(event.text ?? ''));
        else if (event.type === 'result') reply = event.data as AssistantReply;
        else if (event.type === 'error') failure = String(event.error ?? 'Something went wrong');
      };
      // A question that never reached the server is asked again before it is
      // reported: the connection blinked, or the API was restarting. Only when
      // nothing at all came back — once the server has started answering, a
      // second ask could do the work twice.
      const attempt = async (tries: number): Promise<void> => {
        try {
          await apiStream('/assistant/ask?stream=1', body, onEvent, controller.signal);
        } catch (err) {
          if (!(err instanceof NetworkError) || answered || tries >= 3 || controller.signal.aborted) throw err;
          setStatus('Reconnecting');
          await new Promise((resolve) => setTimeout(resolve, 1_500 * tries));
          if (controller.signal.aborted) throw err;
          return attempt(tries + 1);
        }
      };

      void attempt(1)
        .catch((err: Error) => {
          if (err.name === 'AbortError') return;
          failure = err instanceof NetworkError ? err.message : err.message || 'Something went wrong';
        })
        .finally(() => {
          abortRef.current = null;
          setPending(false);
          setStatus(null);

          if (controller.signal.aborted) {
            if (handsFreeRef.current) listenRef.current();
            else setVoice('off');
            return;
          }

          const r = reply as AssistantReply | null;
          if (r) {
            // "Yes" said in words settles the buttons on the earlier message
            // too, so nothing offers to confirm what is already saved.
            if (r.settled?.length) {
              update(
                (st) => ({
                ...st,
                messages: st.messages.map((m) => {
                  const mine = r.settled!.filter((x) => x.key.startsWith(`${m.id}-`));
                  if (!mine.length) return m;
                  return {
                    ...m,
                    done: [...(m.done ?? []), ...mine.filter((x) => x.decision === 'confirmed').map((x) => x.key)],
                    dismissed: [...(m.dismissed ?? []), ...mine.filter((x) => x.decision === 'cancelled').map((x) => x.key)],
                  };
                }),
                }),
                conversationId,
              );
              if (r.settled.some((x) => x.decision === 'confirmed')) {
                void queryClient.invalidateQueries({ queryKey: ['tasks'] });
                void queryClient.invalidateQueries({ queryKey: ['drafts'] });
                void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
              }
            }
            append(
              {
                role: 'assistant',
                content: r.reply,
                answer: r.answer,
                proposed: r.proposed,
                done: [],
                ...(r.startedJobs?.length ? { jobs: r.startedJobs } : {}),
              },
              conversationId,
            );
            deliver(r.answer?.speech || r.reply);
            return;
          }

          const why = failure ?? 'No answer came back.';
          append(
            { role: 'assistant', kind: 'error', content: why, retry: typed, ...(files.length ? { retryFiles: files } : {}) },
            conversationId,
          );
          deliver('Sorry, that did not work. Try asking again.');
        });
    },
    [append, ask, deliver, path, update, queryClient, fetchCheckin, fetchDigest],
  );

  const editMessage = useCallback(
    (messageId: string, text: string) => {
      if (abortRef.current) return;
      const original = activeOf(storeRef.current).messages.find((m) => m.id === messageId);
      if (!original || original.role !== 'user') return;
      // The files it carried go again: the edit is to the words.
      const files = original.files ?? [];
      if (original.made) imagine(text, original.made, { files, replaceFrom: messageId });
      else send(text, { files, replaceFrom: messageId });
    },
    [imagine, send],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const newConversation = useCallback(() => {
    abortRef.current?.abort();
    stopSpeaking();

    // Every conversation opens with where the studio stands.
    //
    // This used to start blank on the reasoning that the briefing comes once
    // a day and repeating it would be noise. But opening a new chat is exactly
    // the moment someone wants the current picture. So it is shown again —
    // reused from the last one built when that is still fresh (see
    // fetchBriefing), and rebuilt only when it has gone stale. Either way it is
    // a database read with no model call behind it.
    //
    // The target conversation is worked out here, from the ref, rather than
    // inside the updater — a state updater does not run until the next
    // render, so anything read back from it straight afterwards is still the
    // old value, and the briefing would land in the conversation we just
    // left.
    const current = activeOf(storeRef.current);
    // One with nothing in it yet is reused, not piled up.
    const fresh = current.messages.length ? blankConversation() : null;
    setStore((s) =>
      fresh
        ? { ...s, conversations: [fresh, ...s.conversations], activeId: fresh.id, unseen: 0 }
        : { ...s, unseen: 0 },
    );
    void fetchBriefing(fresh ? fresh.id : current.id);
  }, [fetchBriefing]);

  const openConversation = useCallback((id: string) => {
    if (id === storeRef.current.activeId) return;
    // An answer still on its way belongs to the conversation it was asked in.
    abortRef.current?.abort();
    stopSpeaking();
    setStore((s) => {
      if (!s.conversations.some((c) => c.id === id)) return s;
      // An empty conversation left behind is not worth a line in the list.
      const leaving = activeOf(s);
      const conversations = leaving.messages.length ? s.conversations : s.conversations.filter((c) => c.id !== leaving.id);
      return { ...s, conversations, activeId: id };
    });
  }, []);

  const renameConversation = useCallback((id: string, title: string) => {
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 80);
    setStore((s) => ({ ...s, conversations: s.conversations.map((c) => (c.id === id ? { ...c, title: clean || null } : c)) }));
  }, []);

  const pinConversation = useCallback((id: string, pinned: boolean) => {
    setStore((s) => ({ ...s, conversations: s.conversations.map((c) => (c.id === id ? { ...c, pinned } : c)) }));
  }, []);

  /** A per-person preference, not tied to any one conversation. */
  const setAgents = useCallback((next: AgentKey[]) => {
    setStore((s) => ({ ...s, agents: next }));
  }, []);

  const deleteConversation = useCallback((id: string) => {
    const doomed = storeRef.current.conversations.find((c) => c.id === id);
    if (!doomed) return;
    if (id === storeRef.current.activeId) {
      abortRef.current?.abort();
      stopSpeaking();
    }
    // The files attached in it go too — they were only kept for it.
    const tokens = doomed.messages.flatMap((m) => (m.files ?? []).map((f) => f.token));
    if (tokens.length) {
      void api('/assistant/uploads/forget', { method: 'POST', body: JSON.stringify({ tokens }) }).catch(() => {
        /* the files expire on their own; the conversation is gone either way */
      });
    }
    setStore((s) => {
      const rest = s.conversations.filter((c) => c.id !== id);
      if (s.activeId !== id) return { ...s, conversations: rest };
      const next = [...rest].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (next) return { ...s, conversations: rest, activeId: next.id };
      const fresh = blankConversation();
      return { ...s, conversations: [fresh], activeId: fresh.id };
    });
  }, []);

  const downloadConversation = useCallback(
    (id: string) => {
      const c = storeRef.current.conversations.find((x) => x.id === id);
      if (!c) return;
      const text = transcriptOf(c, user?.name ?? 'You');
      const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${titleOf(c).replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'conversation'}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
    [user?.name],
  );

  const uploadFile = useCallback(
    (file: File, signal?: AbortSignal) =>
      apiUpload<AttachedFile>(`/assistant/upload?name=${encodeURIComponent(file.name)}`, file, signal),
    [],
  );

  const [prefill, setPrefillState] = useState<{ text: string; at: number } | null>(null);
  const setPrefill = useCallback((text: string) => setPrefillState({ text, at: Date.now() }), []);
  const [attachRequest, setAttachRequest] = useState(0);
  const requestAttach = useCallback(() => setAttachRequest((n) => n + 1), []);

  const conversations = useMemo<ConversationSummary[]>(
    () =>
      store.conversations
        .filter((c) => c.messages.length > 0)
        .map((c) => {
          const last = [...c.messages].reverse().find((m) => m.kind !== 'error');
          return {
            id: c.id,
            title: titleOf(c),
            pinned: Boolean(c.pinned),
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            questions: c.messages.filter((m) => m.role === 'user').length,
            preview: (last?.answer?.lead ?? last?.content ?? '').replace(/\s+/g, ' ').slice(0, 120),
          };
        })
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt),
    [store.conversations],
  );

  const markDone = useCallback(
    (messageId: string, key: string) =>
      update((s) => ({
        ...s,
        messages: s.messages.map((m) => (m.id === messageId ? { ...m, done: [...(m.done ?? []), key] } : m)),
      })),
    [update],
  );

  const markDismissed = useCallback(
    (messageId: string, key: string) =>
      update((st) => ({
        ...st,
        messages: st.messages.map((m) =>
          m.id === messageId ? { ...m, dismissed: [...(m.dismissed ?? []), key] } : m,
        ),
      })),
    [update],
  );

  // A confirmation from the button is said back in the conversation, as one
  // said aloud would be — so the thread records it, and so does the history
  // the next question is asked with.
  const acknowledge = useCallback(
    (saved: SavedProposal) => {
      const answer = acknowledgement(saved);
      append({ role: 'assistant', content: answer.lead, answer });
      deliver(answer.speech);
    },
    [append, deliver],
  );

  // ── Hands-free ────────────────────────────────────────────

  const endHandsFree = useCallback((message?: string) => {
    handsFreeRef.current = false;
    setHandsFreeState(false);
    // Leaving the conversation is not the end of a sentence: nothing is sent.
    stopListeningRef.current?.({ discard: true });
    stopListeningRef.current = null;
    stopSpeaking();
    setVoice('off');
    if (message) setMicError(message);
  }, []);

  /**
   * Listen for one thing said, then hand it to `send`.
   *
   * Silence is allowed once — people pause — and ends the conversation the
   * second time, so a microphone is never left open in an empty room.
   */
  listenRef.current = () => {
    if (!handsFreeRef.current) return;
    setVoice('listening');
    setInterim('');
    setMicLive(false);
    let heard = false;
    let echo = false;
    stopListeningRef.current = listen({
      /*
       * More patient than the microphone button, not less.
       *
       * Press-to-talk waits 2.6s and then puts the words in the box, where
       * they sit until Enter — a sentence cut in half is visible, and gets
       * fixed before anyone sees it but the person who said it. Hands-free
       * was on the 2.0s default and SENDS, with nothing in between. So the
       * path with no safety net was the quicker of the two to decide
       * somebody had stopped talking, and "can you check the…" went to
       * Jenny as a question while its second half was still being said.
       * She answered the fragment, which is what "she catches the wrong
       * words" looks like from the other side of the microphone.
       *
       * pauseFor() still adds 1.8s on top when the last word leaves the
       * sentence hanging, and 1s more while the browser has not settled, so
       * trailing off mid-phrase buys well over four seconds.
       */
      pauseMs: 2_800,
      onLevel: setMicLevel,
      onStart: () => setMicLive(true),
      onInterim: (words) => setInterim(words),
      onResult: (hearings) => {
        const ranked = bestHearing(hearings, vocabularyRef.current);
        // Her own last sentence, picked up by the microphone, is not a reply.
        if (soundsLikeEcho(ranked[0].transcript)) {
          echo = true;
          return;
        }
        heard = true;
        silencesRef.current = 0;
        setInterim('');
        send(ranked[0].transcript, { alternatives: ranked.map((h) => h.transcript) });
      },
      onError: (error) => {
        // Not being heard is not a fault to stop for — the end handler
        // counts it and listens again. But it is still worth saying, because
        // "you are coming through very faintly" is the difference between
        // someone moving closer and someone deciding voice does not work.
        if (isUnheard(error)) setMicError(error);
        else endHandsFree(error);
      },
      onEnd: () => {
        stopListeningRef.current = null;
        setInterim('');
        setMicLevel(null);
        setMicLive(false);
        if (!handsFreeRef.current || heard) return;
        // An echo is not silence: listen again without counting it.
        if (!echo) silencesRef.current += 1;
        if (silencesRef.current >= 2) {
          endHandsFree('Stopped listening — nothing was said. Turn on Talk to carry on.');
          return;
        }
        listenRef.current();
      },
    });
  };

  const setHandsFree = useCallback(
    (on: boolean) => {
      if (!on) {
        endHandsFree();
        return;
      }
      if (!canListen) {
        setMicError('This browser cannot listen. Chrome, Edge and Safari can.');
        return;
      }
      setMicError(null);
      silencesRef.current = 0;
      handsFreeRef.current = true;
      setHandsFreeState(true);
      stopSpeaking();
      // Already waiting on an answer: it will speak, then listen.
      if (!abortRef.current) listenRef.current();
      else setVoice('thinking');
    },
    [canListen, endHandsFree],
  );

  const skipSpeaking = useCallback(() => {
    stopSpeaking();
    if (handsFreeRef.current) listenRef.current();
  }, []);

  const doneTalking = useCallback(() => stopListeningRef.current?.(), []);

  // ── The panel ─────────────────────────────────────────────

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (next) {
        update((s) => (s.unseen ? { ...s, unseen: 0 } : s));
        setFocusRequest((n) => n + 1);
      } else if (!window.location.pathname.startsWith('/assistant')) {
        // Closing the panel ends a spoken conversation: talking to a panel
        // you cannot see is how a microphone gets left on.
        endHandsFree();
      }
    },
    [update, endHandsFree],
  );

  // Routes where Jenny IS the page, rather than a panel over one.
  //
  // This was a `startsWith('/assistant')` test written when the full page
  // was the only one. The standalone page does not start with `/assistant`
  // — it starts with `/jenny-` — so it failed the test, and the effect
  // below shut a spoken conversation down the instant it began there:
  // hands-free off, voice off, and no message, because that is the one path
  // that ends it without saying why.
  const onJennyPage = ['/assistant', '/jenny-assistant'].some(
    (r) => location.pathname === r || location.pathname.startsWith(`${r}/`),
  );

  // The full page is Jenny too: arriving there counts as having seen her.
  useEffect(() => {
    if (onJennyPage) {
      setOpenState(false);
      update((s) => (s.unseen ? { ...s, unseen: 0 } : s));
    }
  }, [onJennyPage, update]);

  // A spoken conversation needs somewhere it can be seen. Leaving the full
  // page with the panel shut would leave the microphone listening with
  // nothing on screen to say so, or to turn it off.
  useEffect(() => {
    if (handsFree && !open && !onJennyPage) endHandsFree();
  }, [handsFree, open, onJennyPage, endHandsFree]);

  const requestFocus = useCallback(() => setFocusRequest((n) => n + 1), []);

  // Nothing keeps listening or talking after the app goes away.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      stopListeningRef.current?.({ discard: true });
      stopSpeaking();
    },
    [],
  );

  const value = useMemo<AssistantCtx>(
    () => ({
      messages: active.messages,
      pending,
      status,
      send,
      imagine,
      editMessage,
      uploadFile,
      vocabulary,
      interim,
      stop,
      newConversation,
      conversations,
      activeConversationId: active.id,
      openConversation,
      renameConversation,
      pinConversation,
      deleteConversation,
      downloadConversation,
      prefill,
      setPrefill,
      attachRequest,
      requestAttach,
      markDone,
      markDismissed,
      acknowledge,
      startCheckin,
      checkinLoading,
      setCheckinOutcome,
      briefingLoading,
      unseen: store.unseen,
      open,
      setOpen,
      focusRequest,
      requestFocus,
      lookingAt,
      agents: store.agents,
      setAgents,
      handsFree,
      setHandsFree,
      voice,
      skipSpeaking,
      doneTalking,
      speakReplies,
      setSpeakReplies,
      micError,
      micLevel,
      micLive,
      setMicError,
      canListen,
      canSpeak,
    }),
    [
      active.messages, active.id, store.unseen, pending, status, send, imagine, editMessage, uploadFile, vocabulary, interim, stop, newConversation,
      conversations, openConversation, renameConversation, pinConversation, deleteConversation, downloadConversation,
      prefill, setPrefill, attachRequest, requestAttach, markDone, markDismissed, acknowledge,
      startCheckin, checkinLoading, setCheckinOutcome,
      briefingLoading, open, setOpen, focusRequest, requestFocus, lookingAt, store.agents, setAgents, handsFree,
      setHandsFree, voice, skipSpeaking, doneTalking, speakReplies, micError, micLevel, micLive, canListen, canSpeak,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistant(): AssistantCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAssistant must be used inside AssistantProvider');
  return ctx;
}
