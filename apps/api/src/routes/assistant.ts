import express, { Router, type Request, type Response } from 'express';
import { FLOORING_PLAN } from '../services/flooringPlan.js';
import { AGENT_KEYS, type AgentKey } from '@janelle/shared';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { ask, type AssistantContext, type AssistantTurn, type PendingProposal } from '../services/assistant.js';
import { ProposalError, commitProposal } from '../services/proposals.js';
import { buildBriefing, emptyBriefing } from '../services/briefing.js';
import { CheckinError, buildCheckin, recordCheckin, type CheckinOutcome } from '../services/checkin.js';
import { canManageTasks, canWith } from '@janelle/shared';
import { MAX_RELAY_BYTES, UPLOAD_GRANT_TTL_MS, openFileGrant, sealFileGrant } from '../lib/fileTokens.js';
import { MAX_UPLOAD_BYTES, removeUploads, sniffType, storeUpload } from '../lib/uploads.js';
import { FileFetchError, fetchGrantedContent, fetchGrantedFile } from '../services/files.js';
import { finishJob, recentJobs, viewOf } from '../services/mediaJobs.js';
import { imagineOptions, makePicture, mayImagine, startClip } from '../services/imagine.js';
import { STUDIO_TEAM, isStudioMailbox } from '../lib/studioTeam.js';

export const assistantRouter = Router();
assistantRouter.use(requireAuth);

/** Files one question may carry. */
const MAX_ATTACHMENTS = 4;

/**
 * Who is asking, as the assistant should know them.
 *
 * The session carries an email, and the assistant used to be told that was
 * the person's name — so it greeted people by their address, and "my
 * tasks" matched nobody, because tasks are assigned to full names. The
 * profile's own name is read here, once per question.
 */
async function assistantContext(req: Request, page?: unknown, pending?: unknown): Promise<AssistantContext> {
  const { db, userId, orgId, role, seat, email, permissions } = req.auth!;
  let name = email ?? 'a teammate';
  try {
    const { data } = await db.from('profiles').select('full_name').eq('id', userId).maybeSingle();
    const full = (data as { full_name?: string | null } | null)?.full_name?.trim();
    if (full) name = full;
  } catch {
    // The email still identifies them; an unreadable profile is not worth failing over.
  }
  const path = (page as { path?: unknown } | undefined)?.path;
  return {
    db,
    userId,
    orgId,
    role,
    seat,
    name,
    permissions,
    page: typeof path === 'string' ? { path: path.slice(0, 300) } : null,
    pending: pendingFrom(pending),
  };
}

/**
 * What the person has been shown and not yet answered, as the browser holds it.
 *
 * Taken on trust only as far as trust costs nothing: anything saved from here
 * goes through commitProposal, the same checks as the Confirm button, which
 * the browser could already call with any input it liked.
 */
function pendingFrom(raw: unknown): PendingProposal[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .filter((p) => typeof p.key === 'string' && ['propose_task', 'propose_task_update', 'propose_draft'].includes(String(p.tool)))
    .filter((p) => !!p.input && typeof p.input === 'object')
    .slice(0, 10)
    .map((p) => ({
      key: String(p.key).slice(0, 120),
      tool: String(p.tool),
      summary: String(p.summary ?? '').slice(0, 300),
      input: p.input as Record<string, unknown>,
    }));
}

/** Which named agent(s) the person switched on, if any — an allow-listed set. */
function agentsFrom(raw: unknown): AgentKey[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<AgentKey>();
  for (const v of raw) {
    if (typeof v === 'string' && (AGENT_KEYS as readonly string[]).includes(v)) allowed.add(v as AgentKey);
  }
  return [...allowed];
}

// Ask the assistant a question. Read-only: any write it decides on comes
// back as a proposal for the person to confirm.
assistantRouter.post(
  '/ask',
  asyncHandler(async (req, res) => {
    const message = String(req.body?.message ?? '').trim();
    if (!message) return res.status(400).json({ error: 'Message is required' });
    if (message.length > 2000) return res.status(400).json({ error: 'Message is too long' });

    const raw = Array.isArray(req.body?.history) ? req.body.history : [];
    const history: AssistantTurn[] = raw
      .filter((t: unknown) => {
        const x = t as { role?: string; content?: string };
        return (x?.role === 'user' || x?.role === 'assistant') && typeof x.content === 'string';
      })
      // Matches what the assistant actually sends; anything earlier is
      // paid for and discarded.
      .slice(-4);

    const ctx = await assistantContext(req, req.body?.page, req.body?.pending);
    ctx.agents = agentsFrom(req.body?.agents);
    // Spoken: every way the browser heard it, best first.
    const heard = (req.body?.spoken as { alternatives?: unknown } | undefined)?.alternatives;
    if (Array.isArray(heard)) {
      const alternatives = heard
        .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
        .map((a) => a.trim().slice(0, 300))
        .slice(0, 5);
      if (alternatives.length) ctx.spoken = { alternatives };
    }
    // Files handed over earlier. Only tokens this server sealed for this
    // studio are kept; anything else in the list is dropped, silently.
    const granted = (list: unknown, max: number) =>
      (Array.isArray(list) ? (list as unknown[]) : [])
        .map((f) => (f as { token?: unknown })?.token)
        .filter((t): t is string => typeof t === 'string' && t.length < 6000)
        .slice(-max)
        .flatMap((token) => {
          const opened = openFileGrant(token, ctx.orgId);
          return opened.ok ? [{ token, grant: opened.grant }] : [];
        });
    ctx.recentFiles = granted(req.body?.files, 8);
    // Attached to this question by the person asking it.
    ctx.attached = granted(req.body?.attachments, MAX_ATTACHMENTS);

    if (req.query.stream !== '1') {
      res.json({ data: await ask(message, history, ctx) });
      return;
    }

    // Streamed as newline-delimited JSON: progress lines while she works,
    // then the result. A host that buffers the response still delivers
    // every line, just all at once at the end — the answer is the same, only
    // the progress is lost — so nothing depends on streaming actually working.
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const line = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };

    // Headers are already sent, so a failure can no longer become an HTTP
    // status. It is reported in the stream instead, where the client reads it.
    try {
      const result = await ask(message, history, ctx, { onStatus: (text) => line({ type: 'status', text }) });
      line({ type: 'result', data: result });
    } catch (err) {
      console.error('[assistant] ask failed:', (err as Error).message);
      line({ type: 'error', error: (err as Error).message || 'Something went wrong' });
    }
    res.end();
  }),
);

/**
 * The words the studio uses that a speech recogniser does not know.
 *
 * "Denish", "Casa Elar", "Nordhaus" are not in any dictionary, so they are
 * heard as the nearest words that are. The browser uses this list to prefer
 * the hearing that contains a real name, and — where it supports phrase
 * hints — to listen for these names in the first place. Read with the
 * caller's own client: only names they could already see.
 */
assistantRouter.get(
  '/vocabulary',
  asyncHandler(async (req, res) => {
    const { db } = req.auth!;
    const [people, projects, vendors] = await Promise.all([
      db.from('profiles').select('full_name, email'),
      db.from('projects').select('name, client_name, status'),
      db.from('vendors').select('name'),
    ]);
    const tidy = (values: (string | null | undefined)[]) =>
      [...new Set(values.map((v) => (v ?? '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim()).filter((v) => v.length >= 2))].slice(0, 200);
    const projectRows = ((projects.data ?? []) as { name: string | null; client_name: string | null; status: string }[])
      .filter((p) => p.status !== 'archived');
    res.json({
      data: {
        // Every teammate the studio lists, account or not, by every spelling;
        // never the shared inbox's account name.
        people: tidy([
          ...((people.data ?? []) as { full_name: string | null; email: string | null }[])
            .filter((p) => !isStudioMailbox(p.email))
            .map((p) => p.full_name),
          ...STUDIO_TEAM.flatMap((p) => [p.name, ...(p.aliases ?? [])]),
        ]),
        projects: tidy(projectRows.map((p) => p.name)),
        clients: tidy(projectRows.map((p) => p.client_name)),
        vendors: tidy(((vendors.data ?? []) as { name: string | null }[]).map((v) => v.name)),
      },
    });
  }),
);

/**
 * What needs this person today, before they ask anything.
 *
 * `hour` is the person's local hour, because the server cannot know their
 * timezone and "Good evening" at breakfast is the kind of detail that makes
 * an assistant feel like a script.
 */
assistantRouter.get(
  '/briefing',
  asyncHandler(async (req, res) => {
    const ctx = await assistantContext(req);
    const hourRaw = Number(req.query.hour);
    const hour = Number.isInteger(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? hourRaw : null;
    if (!ctx.orgId) return res.json({ data: emptyBriefing(ctx.name, hour) });
    res.json({ data: await buildBriefing(ctx, { hour }) });
  }),
);

/**
 * The end-of-day check-in: this person's day as the 5pm email tells it,
 * with each task ready to be answered. Null when there is nothing to say.
 * Built straight from the database, like the briefing — no model call.
 */
assistantRouter.get(
  '/checkin',
  asyncHandler(async (req, res) => {
    const ctx = await assistantContext(req);
    const hourRaw = Number(req.query.hour);
    const hour = Number.isInteger(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? hourRaw : null;
    if (!ctx.orgId) return res.json({ data: null });
    res.json({ data: await buildCheckin({ db: ctx.db, userId: ctx.userId, orgId: ctx.orgId, name: ctx.name }, { hour }) });
  }),
);

/**
 * One answer in the check-in: Done, Blocked (and why), or Tomorrow. The
 * same rules as the Tasks board — your own queue is yours; anyone else's is
 * for whoever runs the board.
 */
assistantRouter.post(
  '/checkin',
  asyncHandler(async (req, res) => {
    const { db, orgId, userId, role, seat, permissions } = req.auth!;
    if (!orgId) return res.status(400).json({ error: 'No studio is attached to this account.' });
    if (!canWith(permissions, role, 'tasks', 'update')) return res.status(403).json({ error: 'Your role cannot change tasks.' });

    const b = req.body ?? {};
    const taskId = typeof b.task_id === 'string' ? b.task_id.slice(0, 64) : '';
    const outcome = ['done', 'blocked', 'tomorrow'].includes(b.outcome) ? (b.outcome as CheckinOutcome) : null;
    if (!taskId || !outcome) return res.status(400).json({ error: 'A task and an answer (done, blocked or tomorrow) are needed.' });
    const note = typeof b.note === 'string' ? b.note.slice(0, 500) : null;

    try {
      const saved = await recordCheckin(
        { db, orgId, userId, manages: canManageTasks(role, seat ?? null) },
        { taskId, outcome, note },
        'jenny',
      );
      res.json({ data: saved });
    } catch (err) {
      if (err instanceof CheckinError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }),
);

/**
 * Hand over a file the assistant found.
 *
 * The token is the whole authorisation: it was minted when the file was
 * shown to someone allowed to see it, it names exactly one attachment or
 * one Drive file, and it only opens for the organisation it was made for.
 * Nothing in the request can widen it to a different file.
 */
assistantRouter.get(
  '/file',
  asyncHandler(async (req: Request, res: Response) => {
    const opened = openFileGrant(String(req.query.token ?? ''), req.auth!.orgId);
    if (!opened.ok) {
      const message =
        opened.reason === 'expired'
          ? 'This file link has expired — ask again and a fresh one is made.'
          : 'This file link is not valid.';
      return res.status(opened.reason === 'expired' ? 410 : 403).json({ error: message });
    }
    const { grant } = opened;

    let file: Awaited<ReturnType<typeof fetchGrantedContent>>;
    try {
      // A page preview is trimmed to what can be returned, rather than
      // refused whole for the weight of its least relevant page.
      file = await fetchGrantedContent(grant, { maxBytes: MAX_RELAY_BYTES });
    } catch (err) {
      if (err instanceof FileFetchError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
    const { bytes, name, mimeType, webUrl } = file;

    // Past what the platform will return, the person would get a bare
    // platform error instead of their file. Say so, and say where it is.
    if (bytes.length > MAX_RELAY_BYTES) {
      return res.status(413).json({
        error:
          grant.source === 'upload'
            ? `This file is too large to download here (${(bytes.length / (1024 * 1024)).toFixed(1)} MB).`
            : `This file is too large to download here (${(bytes.length / (1024 * 1024)).toFixed(1)} MB). Open it in ${grant.source === 'gmail' ? 'Gmail' : 'Drive'} instead.`,
        webUrl,
      });
    }

    // Always an attachment, never rendered inline, and never sniffed: the
    // file came from someone's inbox, and an HTML or SVG attachment served
    // inline from this origin would run as the app. The browser previews
    // only the types it chooses to, from a blob.
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
  }),
);

/**
 * Make a picture or a clip, without going through Jenny at all.
 *
 * The Create buttons in the composer come here. Reaching the same work
 * through a question costs a whole assistant turn — the system prompt, the
 * studio snapshot and the entire tool block sent to Claude — purely to
 * decide that the person who pressed "Image" wants an image. They already
 * decided, so this spends NO model tokens: the brief goes to the provider
 * as written, and the answer is shaped here.
 *
 * Everything else is identical to the tool path, because it IS the tool
 * path: same permission check, same day cap, same storage, same spend row.
 */
assistantRouter.get(
  '/imagine/options',
  asyncHandler(async (req: Request, res: Response) => {
    const { db, orgId, userId, role, permissions } = req.auth!;
    if (!orgId) return res.json({ data: null });
    const actor = { db, orgId, userId, role, permissions };
    if (!mayImagine(actor)) return res.json({ data: null });
    res.json({ data: await imagineOptions(actor) });
  }),
);

/**
 * How long Image mode may spend on one request.
 *
 * This request is nothing BUT the picture — no Claude turn shares its clock —
 * so it gets most of the function (60s on Vercel), less what storing the
 * result and answering take. It used to inherit the 25s cap written for a
 * render inside one of Jenny's turns, and a long brief at 2K ran past it.
 */
const IMAGINE_BUDGET_MS = Number(process.env.IMAGINE_BUDGET_MS || 56_000);
/**
 * A flooring plan is a whole presentation sheet: GPT Image 2 takes 45–55s to
 * draw one, over the ordinary budget. Hosted, the function's own limit is
 * what actually stops it (raise `maxDuration` in vercel.json to allow this);
 * anywhere without that limit it now finishes.
 */
const IMAGINE_LONG_BUDGET_MS = Number(process.env.IMAGINE_LONG_BUDGET_MS || 110_000);
/**
 * Briefs that draw a whole sheet rather than a picture.
 *
 * The flooring plan was only the first of these. An architectural floor
 * plan, a site plan or an elevation is the same job and the same 45–55
 * seconds of drawing, so matching the word "flooring" alone handed "a full
 * site plan with room dimensions in feet" the ordinary clock and let it run
 * out — a timeout on the one kind of brief that most needed the long one.
 */
const SHEET_BRIEF =
  /\b(?:floor|site|roof|ceiling|elevation|lighting|furniture|landscape|reflected\s+ceiling)\s+plans?\b|\bfloorplans?\b|\belevations?\b|\bpresentation\s+sheet\b/i;

/** Held back for the upload, the job row and the reply once the picture is in. */
const IMAGINE_STORE_RESERVE_MS = 4_000;

assistantRouter.post(
  '/imagine',
  asyncHandler(async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const { db, orgId, userId, role, permissions } = req.auth!;
    if (!orgId) return res.status(400).json({ error: 'No studio is attached to this account.' });

    const actor = { db, orgId, userId, role, permissions };
    const kind = req.body?.kind === 'video' ? 'video' : 'image';
    const prompt = String(req.body?.prompt ?? '').trim();
    if (!prompt) return res.status(400).json({ error: 'Say what you would like made.' });
    if (prompt.length > 2000) return res.status(400).json({ error: 'That brief is too long.' });

    // Only tokens this server sealed for this studio; anything else is dropped.
    const attachments = (Array.isArray(req.body?.attachments) ? (req.body.attachments as unknown[]) : [])
      .map((f) => (f as { token?: unknown })?.token)
      .filter((t): t is string => typeof t === 'string' && t.length < 6000)
      .slice(0, MAX_ATTACHMENTS)
      .flatMap((token) => {
        const opened = openFileGrant(token, orgId);
        return opened.ok && opened.grant.mimeType.startsWith('image/') ? [opened.grant] : [];
      });

    const pictures: { mimeType: string; bytes: Buffer; label: string }[] = [];
    for (const grant of attachments) {
      try {
        const file = await fetchGrantedFile(grant);
        pictures.push({ mimeType: file.mimeType, bytes: file.bytes, label: grant.name });
      } catch {
        // An unreadable attachment falls through to drawing from words.
      }
    }

    if (kind === 'video') {
      const started = await startClip({
        actor,
        brief: prompt,
        seconds: Number(req.body?.seconds) || undefined,
        aspectRatio: typeof req.body?.aspect_ratio === 'string' ? req.body.aspect_ratio : undefined,
        still: pictures[0] ?? null,
        projectId: typeof req.body?.project_id === 'string' ? req.body.project_id : null,
      });
      if (!started.ok) return res.status(400).json({ error: started.reason });

      const lead = `Rendering a ${started.value.seconds}-second clip — it appears here by itself in a minute or so.`;
      return res.json({
        data: {
          answer: {
            lead,
            items: [],
            more: 0,
            speech: 'Rendering it now. It will appear when it is ready.',
            sources: ['Grok'],
            suggestions: [],
          },
          startedJobs: [started.value.jobId],
        },
      });
    }

    const drawn = await makePicture({
      actor,
      brief: prompt,
      sources: pictures,
      aspectRatio: typeof req.body?.aspect_ratio === 'string' ? req.body.aspect_ratio : undefined,
      resolution: req.body?.resolution === '1K' ? '1K' : '2K',
      projectId: typeof req.body?.project_id === 'string' ? req.body.project_id : null,
      // Whatever reading the attachments left of the budget.
      timeoutMs: Math.max(
        15_000,
        (FLOORING_PLAN.test(prompt) || SHEET_BRIEF.test(prompt) ? IMAGINE_LONG_BUDGET_MS : IMAGINE_BUDGET_MS) -
          (Date.now() - startedAt) -
          IMAGINE_STORE_RESERVE_MS,
      ),
    });
    // `timedOut` lets the page offer the same brief again as it stands;
    // a refusal or a missing key would only fail the same way twice.
    if (!drawn.ok) return res.status(400).json({ error: drawn.reason, timedOut: drawn.timedOut === true });
    const picture = drawn.value;

    const roomList = picture.rooms.map((r) => r.room).join(', ');
    const lead = picture.plan
      ? `Here is your floor plan, furnished${
          picture.mode === 'generate'
            ? ' — laid out from the room list you gave, with the labels and dimensions drawn exactly as stated'
            : " — the walls, room names and dimensions are your original drawing"
        }.${
          picture.rooms.length
            ? ` Below it, ${picture.rooms.length} room${picture.rooms.length === 1 ? '' : 's'} in perspective: ${roomList}. They follow each room's use and size from the plan, not its exact walls and windows.`
            : ' Ask for any room on its own to see it in perspective.'
        } Furniture and finishes are illustrative.`
      : picture.board
      ? picture.sketch
        ? `Here is the board. The picture on it is an illustrated sketch — add an OpenAI key in Settings for a photoreal rendering.`
        : 'Here is the board. The rendering is generated, not a photograph — check every specification before it goes to a client.'
      : picture.sketch
        ? `Here is a sketch of it. ${picture.note ?? ''}`.trim()
        : picture.mode === 'edit'
        ? 'Here it is, worked up from the picture you attached. It is a generated image, not a photograph.'
        : 'Here it is. It is a generated image, not a photograph.';

    res.json({
      data: {
        answer: {
          lead,
          items: [
            {
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
            },
            // A floor plan's rooms, one picture each, in the order Claude
            // ranked them — the kitchen and living room first.
            ...picture.rooms.map((r) => ({
              kind: 'file' as const,
              title: r.roomSize ? `${r.room} — ${r.roomSize}` : r.room,
              preview: 'image' as const,
              file: {
                name: r.name,
                mimeType: r.mimeType,
                size: r.size,
                source: 'upload' as const,
                token: r.token,
                downloadable: true,
                webUrl: null,
              },
            })),
          ],
          more: 0,
          speech: 'Here it is.',
          caveat: picture.ignored.length
            ? `Only one picture can be transformed at a time, so ${picture.ignored.join(', ')} was not used.`
            : null,
          sources: [picture.model],
          suggestions: [],
        },
        startedJobs: [],
      },
    });
  }),
);

/**
 * Wait on a clip that was started by an earlier question.
 *
 * Polled by the browser while someone is watching, which is what makes the
 * video appear in the conversation without a reload. Each call moves the
 * job on by one provider poll — and the first one to see it finished is
 * what fetches the mp4 into storage, before the provider's own URL goes
 * stale. The cron sweep does the same for anyone who closed the tab.
 */
assistantRouter.get(
  '/media/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId } = req.auth!;
    if (!orgId) return res.status(400).json({ error: 'No studio is attached to this account.' });

    const job = await finishJob(String(req.params.id), orgId);
    if (!job) return res.status(404).json({ error: 'No such job.' });
    res.json({ data: await viewOf(job) });
  }),
);

/** This person's recent media, so a reopened conversation catches up. */
assistantRouter.get(
  '/media',
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId, userId } = req.auth!;
    if (!orgId) return res.json({ data: [] });
    const jobs = await recentJobs(orgId, userId, Number(req.query.limit) || 10);
    res.json({ data: await Promise.all(jobs.map((job) => viewOf(job))) });
  }),
);

/**
 * Attach a file to a question: a PDF or an image, sent as the raw request
 * body with its name in the query string.
 *
 * Returns a grant for it. The file is kept for the person's conversations —
 * its grant lasts a month — and read only when a question needs it.
 */
assistantRouter.post(
  '/upload',
  (req, res, next) => {
    // Refused before a byte is read: a body past the limit would otherwise
    // be buffered in full just to be thrown away.
    if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `That file is too large — the limit is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.` });
    }
    next();
  },
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId, userId } = req.auth!;
    if (!orgId) return res.status(400).json({ error: 'No studio is attached to this account.' });

    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) return res.status(400).json({ error: 'The file is empty.' });
    const mimeType = sniffType(bytes);

    /**
     * What Jenny can actually do something with.
     *
     * Narrower than what `sniffType` recognises, on purpose: the extra
     * types are sniffed so a refusal can NAME the file rather than call a
     * photograph "not an image". Told what it is, a person knows what to
     * do; told the generic line, they try the same file again.
     */
    const READABLE = [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ];
    if (!mimeType || !READABLE.includes(mimeType)) {
      const called: Record<string, string> = {
        'image/avif': 'an AVIF image',
        'image/heic': 'a HEIC photo (the format iPhones use)',
        'image/svg+xml': 'an SVG drawing',
        'video/mp4': 'a video',
      };
      const what = mimeType ? called[mimeType] : null;
      return res.status(415).json({
        error: what
          ? `That file is ${what}. Jenny reads PDFs, images (PNG, JPEG, GIF, WebP), spreadsheets, Word documents and text — export or screenshot it as one of those.`
          : 'Jenny could not tell what that file is. PDFs, images, .xlsx, .docx, .csv and .txt all work.',
      });
    }

    const name = String(req.query.name ?? '').trim().slice(0, 200) || (mimeType === 'application/pdf' ? 'document.pdf' : 'image');
    let stored: { path: string };
    try {
      stored = await storeUpload({ orgId, userId, name, mimeType, bytes });
    } catch (err) {
      console.error('[assistant] upload failed:', (err as Error).message);
      return res.status(503).json({ error: 'The file could not be stored right now. Try again in a moment.' });
    }

    const token = sealFileGrant(
      { source: 'upload', orgId, path: stored.path, name, mimeType, size: bytes.length },
      UPLOAD_GRANT_TTL_MS,
    );
    res.json({ data: { token, name, mimeType, size: bytes.length } });
  }),
);

/**
 * Delete uploads — when their conversation is deleted. Only the person's own
 * files: a grant for someone else's upload is ignored, not refused, so a
 * conversation that mixes both still clears what it can.
 */
assistantRouter.post(
  '/uploads/forget',
  asyncHandler(async (req: Request, res: Response) => {
    const { orgId, userId } = req.auth!;
    const tokens = (Array.isArray(req.body?.tokens) ? (req.body.tokens as unknown[]) : [])
      .filter((t): t is string => typeof t === 'string' && t.length < 6000)
      .slice(0, 100);
    const paths = tokens.flatMap((token) => {
      const opened = openFileGrant(token, orgId);
      return opened.ok && opened.grant.source === 'upload' ? [opened.grant.path] : [];
    });
    const removed = orgId && paths.length ? await removeUploads(orgId, userId, paths) : 0;
    res.json({ data: { removed } });
  }),
);

// Commit a proposal the person confirmed with the button. Saying "yes" in
// the conversation reaches the same code through the assistant's
// respond_to_proposal tool, so both are checked and recorded alike.
assistantRouter.post(
  '/confirm',
  asyncHandler(async (req, res) => {
    const tool = typeof req.body?.tool === 'string' ? req.body.tool : 'propose_task';
    const input = (req.body?.input ?? {}) as Record<string, unknown>;
    try {
      res.json({ data: await commitProposal(req.auth!, tool, input, 'button') });
    } catch (err) {
      if (err instanceof ProposalError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }),
);
