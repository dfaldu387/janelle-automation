import { Router } from 'express';
import { TASK_CATEGORIES, TASK_KINDS, TASK_STATUSES, canManageTasks } from '@janelle/shared';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { hasEmailOwner, hasTaskAssignment, hasTaskCategory, hasTaskComments, hasTaskCompletedBy, hasTaskCompletion } from '../lib/columns.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { closeCopiesOfFinishedTasks, markTaskChecked } from '../services/tasks.js';
import { resolveFollowUpsForTask } from '../services/followups.js';

export const tasksRouter = Router();
tasksRouter.use(requireAuth);
// Closing a module to a role has to mean something: until now nothing
// anywhere checked `read`, so revoking it would have been a switch that
// changed nothing. No view, no module — writes are still checked
// separately below.
tasksRouter.use(requirePermission('tasks', 'read'));

// When a task was finished, and the system's note when it closed it — only
// once migration 0015 has added them. `updated_at` stands in until then.
async function completionColumns(): Promise<string> {
  const when = (await hasTaskCompletion()) ? ', completed_at, completion_note' : '';
  // And who moved it there — migration 0032. A plain uuid, not an embed: a
  // second foreign key to profiles would make the implicit `profiles(...)`
  // join on this table ambiguous. The board matches it against the team
  // roster it already has.
  return when + ((await hasTaskCompletedBy()) ? ', completed_by' : '');
}

// When the current owner got it — migration 0016. Absent before that, and
// the reminder then simply has nothing new to announce.
async function assignmentColumns(): Promise<string> {
  return (await hasTaskAssignment()) ? ', assigned_at' : '';
}

// Which part of the studio a task belongs to — migration 0026. Absent before
// it applies, and the app then works the category out from seat and kind.
async function categoryColumns(): Promise<string> {
  return (await hasTaskCategory()) ? ', category' : '';
}

// List tasks, newest first, with the names needed to render a row.
tasksRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const columns = `id, title, detail, kind, status, assigned_to, assigned_role, seat, next_step, project_id, vendor_id, source_email_id, due_date, created_at, updated_at${await completionColumns()}${await assignmentColumns()}${await categoryColumns()}, projects(name), vendors(name), profiles(full_name)`;
    // PostgREST caps a single response at its `max-rows` (1000 here), and the
    // board needs EVERY task: ordered newest-first, a cap silently drops the
    // oldest, so once the studio passed 1000 tasks its September overdue work
    // stopped loading and no board filter could bring it back. Page through
    // until a short page proves the end, rather than trusting one request.
    const PAGE = 1000;
    const all: unknown[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await req.auth!.db
        .from('tasks')
        .select(columns)
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const batch = data ?? [];
      all.push(...batch);
      if (batch.length < PAGE) break;
    }
    res.json({ data: all });
  }),
);

/**
 * Everything behind one task, for the detail panel.
 *
 * Four questions the board itself cannot answer: what the task actually
 * says, which email it came from, what has happened to it since, and what
 * it breaks down into. Assembled here rather than in four calls from the
 * browser, because opening a card should cost one round-trip.
 */
tasksRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const db = req.auth!.db;

    const { data: task, error } = await db
      .from('tasks')
      .select(
        `id, title, detail, kind, status, assigned_to, assigned_role, seat, next_step,
         project_id, vendor_id, source_email_id, due_date, created_at, updated_at,
         reminded_at, reminder_count${await completionColumns()}${await categoryColumns()},
         projects(name), vendors(name), profiles(full_name, email)`,
      )
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const t = task as unknown as { source_email_id: string | null };

    // The email that raised it — the studio's first question about any task
    // is "where did this come from". Never the body: the snippet and the
    // summary Claude already extracted are enough to recognise the thread.
    const emailQuery = t.source_email_id
      ? db
          .from('emails')
          .select('id, subject, from_addr, to_addr, snippet, received_at, class, extracted_json')
          .eq('id', t.source_email_id)
          .maybeSingle()
      : null;

    // What has happened since: reminders and escalations raised against it.
    const historyQuery = db
      .from('follow_ups')
      .select('id, type, reason, status, created_at')
      .eq('task_id', req.params.id)
      .order('created_at', { ascending: true });

    // The thread on this task, oldest first — migration 0033. Author names
    // come from its own single relationship to profiles, which is why the
    // embed here can stay implicit while the one on `tasks` could not.
    const commentsReady = await hasTaskComments();
    const commentQuery = commentsReady
      ? db
          .from('task_comments')
          .select('id, body, created_at, author, profiles(full_name)')
          .eq('task_id', req.params.id)
          .order('created_at', { ascending: true })
      : null;

    const [emailRes, historyRes, commentRes] = await Promise.all([
      emailQuery,
      historyQuery,
      commentQuery,
    ]);

    const email = emailRes?.data ?? null;

    // source_email_id set but RLS handed back nothing is not the same as no
    // email at all: a task raised from a teammate's PERSONAL mailbox is
    // visible to everyone on the board, but the mail itself, by design
    // (migration 0018), is only visible to them. Telling those two apart
    // needs the admin client — the whole point of RLS is that the request's
    // own client cannot see far enough to say which one happened.
    let emailHiddenFrom: string | null = null;
    if (t.source_email_id && !email && supabaseAdmin) {
      const withOwner = await hasEmailOwner();
      const { data: real } = await supabaseAdmin
        .from('emails')
        .select(withOwner ? 'owner_id, profiles(full_name)' : 'id')
        .eq('id', t.source_email_id)
        .maybeSingle();
      if (real) {
        emailHiddenFrom =
          (real as { profiles?: { full_name: string | null } | null }).profiles?.full_name ?? 'a teammate';
      }
    }

    res.json({
      data: {
        task,
        email,
        // Set only when the email exists but is someone's personal mail —
        // lets the panel say why, instead of the false "added by hand".
        emailHiddenFrom,
        history: historyRes.data ?? [],
        comments: commentRes?.data ?? [],
        // So the panel can say why it is not offering the box, rather than
        // pretending nobody has said anything.
        commentsAvailable: commentsReady,
      },
    });
  }),
);

/**
 * Say something on a task.
 *
 * What replaced subtasks. A task raised from an email is a conversation —
 * who is chasing it, what the vendor said on the phone, who needs to pick
 * it up next — and the only field that could hold any of it was `detail`,
 * which belongs to the extractor and is rewritten whenever the mail is read
 * again. So it was all said in Slack and in email instead, where the task
 * could not see it.
 *
 * Mentions are sent as ids by the composer, not parsed out of the text.
 * Two people called Joanna, a name typed with the wrong spelling, a
 * surname nobody uses — matching on words is how an @mention reaches the
 * wrong person or nobody at all. The picker already knows who was chosen.
 */
tasksRouter.post(
  '/:id/comments',
  requirePermission('tasks', 'update'),
  asyncHandler(async (req, res) => {
    if (!(await hasTaskComments())) {
      return res.status(503).json({
        error: 'Comments are not available yet — apply migration 0033 (npm run db:apply) first',
      });
    }

    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'Write something first' });

    const { db, orgId, userId } = req.auth!;
    const { data: task } = await db
      .from('tasks')
      .select('id, title, org_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const taskOrg = (task as { org_id: string }).org_id;

    const { data: comment, error } = await db
      .from('task_comments')
      .insert({ org_id: taskOrg, task_id: req.params.id, author: userId, body: body.slice(0, 4000) })
      .select('id, body, created_at, author, profiles(full_name)')
      .maybeSingle();
    if (error) throw new Error(error.message);

    // Only real teammates, only once each, and never yourself: being told
    // you mentioned yourself is noise, and the bell is the one surface that
    // has to stay worth looking at.
    const asked = Array.isArray(req.body?.mentions) ? req.body.mentions.map(String) : [];
    let mentioned: string[] = [];
    if (asked.length) {
      const { data: team } = await db
        .from('profiles')
        .select('id')
        .eq('org_id', taskOrg)
        .in('id', [...new Set(asked)].slice(0, 20));
      mentioned = (team ?? []).map((p) => (p as { id: string }).id).filter((id) => id !== userId);
    }

    if (mentioned.length) {
      const commentId = (comment as { id: string }).id;
      const { error: mentionError } = await db.from('task_comment_mentions').insert(
        mentioned.map((id) => ({
          org_id: taskOrg,
          comment_id: commentId,
          task_id: req.params.id,
          user_id: id,
        })),
      );
      // The comment is saved either way: losing the words because a bell
      // badge could not be written would be the worse failure.
      if (mentionError) console.error('[tasks] mentions not recorded:', mentionError.message);
    }

    await db.from('activity_log').insert({
      org_id: orgId,
      actor: userId,
      action: 'task.comment',
      entity: 'tasks',
      entity_id: req.params.id,
      meta: { title: (task as { title: string }).title, mentioned: mentioned.length },
    });

    res.json({ data: { comment, mentioned: mentioned.length } });
  }),
);

// Edit a comment body. Only the author may change what they wrote.
tasksRouter.patch(
  '/:id/comments/:commentId',
  requirePermission('tasks', 'update'),
  asyncHandler(async (req, res) => {
    if (!(await hasTaskComments())) {
      return res.status(503).json({ error: 'Comments not available' });
    }
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'Body cannot be empty' });

    const { db, userId } = req.auth!;
    const { data: existing } = await db
      .from('task_comments')
      .select('id, author')
      .eq('id', req.params.commentId)
      .eq('task_id', req.params.id)
      .maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Comment not found' });
    if ((existing as { author: string }).author !== userId) {
      return res.status(403).json({ error: 'You can only edit your own comments' });
    }

    const { data, error } = await db
      .from('task_comments')
      .update({ body: body.slice(0, 4000) })
      .eq('id', req.params.commentId)
      .select('id, body, created_at, author, profiles(full_name)')
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);

// Delete a comment. Only the author may remove it.
tasksRouter.delete(
  '/:id/comments/:commentId',
  requirePermission('tasks', 'update'),
  asyncHandler(async (req, res) => {
    if (!(await hasTaskComments())) {
      return res.status(503).json({ error: 'Comments not available' });
    }
    const { db, userId } = req.auth!;
    const { data: existing } = await db
      .from('task_comments')
      .select('id, author')
      .eq('id', req.params.commentId)
      .eq('task_id', req.params.id)
      .maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Comment not found' });
    if ((existing as { author: string }).author !== userId) {
      return res.status(403).json({ error: 'You can only delete your own comments' });
    }

    const { error } = await db
      .from('task_comments')
      .delete()
      .eq('id', req.params.commentId);
    if (error) throw new Error(error.message);
    res.json({ data: { id: req.params.commentId } });
  }),
);

// Update a task's status and/or its assignee.
tasksRouter.patch(
  '/:id',
  requirePermission('tasks', 'update'),
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};

    if ('status' in b) {
      if (!TASK_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
      patch.status = b.status;
    }
    if ('assigned_to' in b) {
      patch.assigned_to = b.assigned_to ? String(b.assigned_to) : null;
    }
    // The SOP's other two requirements, editable where the work is looked
    // at. A task without a date cannot be chased, and one without a next
    // step fails the studio's own review — so both have to be fixable here
    // rather than only by re-reading the email that raised it.
    if ('due_date' in b) {
      const due = b.due_date ? String(b.due_date) : null;
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
        return res.status(400).json({ error: 'A due date must be YYYY-MM-DD' });
      }
      patch.due_date = due;
    }
    if ('next_step' in b) {
      const step = String(b.next_step ?? '').trim();
      patch.next_step = step ? step.slice(0, 500) : null;
    }

    if ('category' in b) {
      if (!TASK_CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'Invalid category' });
      if (!(await hasTaskCategory())) {
        return res.status(409).json({ error: 'Categories need migration 0026_task_category.sql applied first.' });
      }
      patch.category = b.category;
    }

    if ('project_id' in b) {
      patch.project_id = b.project_id ? String(b.project_id) : null;
    }

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No fields to update' });

    const { db, orgId, userId, role, seat } = req.auth!;
    const manages = canManageTasks(role, seat);
    const movingStatus = 'status' in patch;

    // Read the row once and use it twice: for the ownership check below, and
    // for the audit line a status change leaves. Skipped entirely when
    // neither is in play, so an ordinary edit still costs one round-trip.
    let before: { status: string; title: string; assigned_to: string | null } | null = null;
    if (!manages || movingStatus) {
      const { data: current } = await db
        .from('tasks')
        .select('status, title, assigned_to')
        .eq('id', req.params.id)
        .maybeSingle();
      if (!current) return res.status(404).json({ error: 'Task not found' });
      before = current as { status: string; title: string; assigned_to: string | null };
    }

    // Anyone may work their own queue; handing work to someone else — or
    // taking it off them — belongs to whoever runs the board. That is a
    // principal or coordinator by role, and also the seats the roles
    // document puts on the board: PM support owns "pushing tasks so each
    // has ONE owner", which is impossible without this. Claiming an
    // unassigned task for yourself stays open to everyone, which is how
    // gaps get filled.
    if (!manages) {
      const owner = before!.assigned_to;

      if (owner && owner !== userId) {
        return res.status(403).json({ error: "You cannot change someone else's task" });
      }
      if ('assigned_to' in patch && patch.assigned_to !== userId && patch.assigned_to !== null) {
        return res.status(403).json({ error: 'Only someone who runs the task board can assign work to others' });
      }
    }

    // Only the move INTO Done, and only out of it, are events. Saving a date
    // on a task that was already finished is neither, and must not restamp
    // work somebody else closed.
    const closing = movingStatus && patch.status === 'done' && before!.status !== 'done';
    const reopening = movingStatus && patch.status !== 'done' && before!.status === 'done';

    // Who finished it — migration 0032. Written here rather than in the
    // trigger because the database does not know who is asking; the trigger
    // owns the other direction and clears it on reopen.
    if (closing && (await hasTaskCompletedBy())) patch.completed_by = userId;

    const { data, error } = await db
      .from('tasks')
      .update(patch)
      .eq('id', req.params.id)
      .select(`id, status, assigned_to${(await hasTaskCompletedBy()) ? ', completed_by' : ''}`)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Task not found' });

    // Closing a task used to leave no trace at all: 0015 recorded when, never
    // who, and this route logged nothing. The column answers "who finished
    // this" on the board; the log answers "what did she get through
    // yesterday", and survives the reopen that clears the column.
    if (closing || reopening) {
      await db.from('activity_log').insert({
        org_id: orgId,
        actor: userId,
        action: closing ? 'task.complete' : 'task.reopen',
        entity: 'tasks',
        entity_id: req.params.id,
        meta: { title: before!.title, from: before!.status, to: patch.status },
      });
    }

    // Done by anyone: every other copy of the same task is done too, so none
    // is left in the open queue — whoever it was handed to.
    if (patch.status === 'done' && orgId) {
      await closeCopiesOfFinishedTasks(orgId).catch((err) =>
        console.error('[tasks] closing copies failed:', (err as Error).message),
      );
    }
    // And the nudges about it stop here rather than at the next sweep, so
    // Top Priority Actions is not still chasing work that was just filed.
    // Cancelled counts too: there is nothing left to chase either way.
    if ((patch.status === 'done' || patch.status === 'cancelled') && orgId) {
      await resolveFollowUpsForTask(orgId, req.params.id).catch((err) =>
        console.error('[tasks] clearing follow-ups failed:', (err as Error).message),
      );
    }
    res.json({ data });
  }),
);

// Create a task by hand, for work that never arrived as an email.
tasksRouter.post(
  '/',
  requirePermission('tasks', 'create'),
  asyncHandler(async (req, res) => {
    const title = String(req.body?.title ?? '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const kind = TASK_KINDS.includes(req.body?.kind) ? req.body.kind : 'admin';

    const { data, error } = await req.auth!.db
      .from('tasks')
      .insert({
        org_id: req.auth!.orgId,
        title: title.slice(0, 200),
        detail: req.body?.detail ? String(req.body.detail) : null,
        kind,
        ...((await hasTaskCategory()) && TASK_CATEGORIES.includes(req.body?.category) ? { category: req.body.category } : {}),
        assigned_to: req.body?.assigned_to ? String(req.body.assigned_to) : null,
        project_id: req.body?.project_id ? String(req.body.project_id) : null,
        due_date: req.body?.due_date || null,
      })
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ data: { id: data?.id } });
  }),
);

/**
 * Delete a task outright.
 *
 * The board could only ever move a task between statuses, so a card raised
 * from a misread email — or a duplicate of one already being worked — could
 * be cancelled but never removed, and sat in the list for ever. Principals
 * and coordinators hold this by default; every other role reaches it only
 * if the studio grants it on Permissions.
 *
 * Logged, because the work itself is gone afterwards and the audit trail is
 * the only remaining record that it existed.
 */
tasksRouter.delete(
  '/:id',
  requirePermission('tasks', 'delete'),
  asyncHandler(async (req, res) => {
    const { db, orgId, userId } = req.auth!;

    const { data: task } = await db
      .from('tasks')
      .select('id, title, source_email_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const { error } = await db.from('tasks').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);

    // Deleted on purpose: the email it came from must not raise it again the
    // next time the mail is scanned.
    const sourceEmail = (task as { source_email_id: string | null }).source_email_id;
    if (sourceEmail) await markTaskChecked(sourceEmail);

    await db.from('activity_log').insert({
      org_id: orgId,
      actor: userId,
      action: 'task.delete',
      entity: 'tasks',
      entity_id: (task as { id: string }).id,
      meta: {
        title: (task as { title: string }).title,
        from_email: Boolean((task as { source_email_id: string | null }).source_email_id),
      },
    });

    res.json({ data: { ok: true } });
  }),
);
