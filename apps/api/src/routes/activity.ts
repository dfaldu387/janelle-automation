import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { AI_USAGE_ACTION } from '../services/anthropic.js';

export const activityRouter = Router();
activityRouter.use(requireAuth);

// Audit log — everything the system read, extracted and drafted.
//
// Supervisors only. SUPERVISOR_ROLES has said "reassigning someone else's
// work, and reading the full audit trail" since it was written, but nothing
// here ever checked it: every role could read the whole trail, including who
// changed what on Team & roles.
activityRouter.get(
  '/',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    // Who and what to narrow to. `scope` splits people's own actions from the
    // system/automation rows that otherwise flood the trail; `actor` pins it
    // to one person, which is how the page tracks a single teammate.
    const scope = String(req.query.scope ?? 'all');
    const actor = typeof req.query.actor === 'string' && req.query.actor ? req.query.actor : null;

    let query = req.auth!.db
      .from('activity_log')
      .select('id, action, entity, meta, created_at, actor, profiles(full_name)')
      // Every Claude call is logged here too; those belong on the AI usage
      // report, not in the studio's audit trail.
      .neq('action', AI_USAGE_ACTION);

    if (actor) query = query.eq('actor', actor);
    else if (scope === 'people') query = query.not('actor', 'is', null);
    else if (scope === 'system') query = query.is('actor', null);

    const { data, error } = await query.order('created_at', { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);
