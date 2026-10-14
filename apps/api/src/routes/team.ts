import { Router } from 'express';
import { SEAT_KEYS, USER_ROLES, canWith, type Seat, type UserRole } from '@janelle/shared';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { hasSeatColumn, profileColumns } from '../lib/columns.js';
import { env } from '../env.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { servicesGranted } from '../lib/google.js';
import { latestGoogleHealth } from '../lib/googleHealth.js';
import { gmailFor, sendMessage } from '../services/gmail.js';
import { inviteEmail } from '../services/emailTemplate.js';
import crypto from 'node:crypto';

/**
 * Addresses that mean nothing to anyone else.
 *
 * A recipient's `localhost` is their own machine, and a 10.x or 192.168.x
 * address is a network they are not on. A link to either is not a weaker
 * link — it is a broken one.
 */
function isLocalUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return true;
  }
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
  );
}

/**
 * Where the person should go to sign in, as somewhere they can actually
 * reach. Throws rather than returning a local address: an invitation
 * carrying a dead link is worse than one that was never sent, because the
 * password inside it has already been set and the recipient has no way to
 * tell the link is the problem.
 */
function publicAppUrl(): string {
  const candidates = [env.appUrl, ...env.corsOrigins].map((u) => (u ?? '').trim()).filter(Boolean);
  const reachable = candidates.find((u) => !isLocalUrl(u));
  if (reachable) return reachable.replace(/\/+$/, '');
  throw new Error(
    'No public address is configured, so the invitation would have linked to localhost. ' +
      'Set APP_URL to the address the studio uses, then send it again.',
  );
}

/**
 * A password nobody has to invent.
 *
 * Random, not memorable: it exists to be used once and replaced. The
 * alphabet leaves out the characters that get misread when somebody types
 * this off a screen — O/0, I/l/1 — because that is exactly how it will be
 * entered the first time.
 */
function newPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}


/**
 * Give somebody a way in, and tell them what it is.
 *
 * Shared by adding a person and by sending an existing one their details
 * again — the two differ only in whether the account was just made. Sets a
 * fresh password either way, because the point of pressing this is that
 * they cannot get in with whatever they have.
 *
 * Never throws on the mail: the password is already live by then, so a
 * failed send has to come back with it rather than leave a changed password
 * nobody knows.
 */
async function issueCredentials(
  orgId: string,
  userId: string,
  email: string,
  fullName: string,
  /**
   * A password the admin chose, rather than a generated one; and whether
   * to email it at all — a password reset may be handed over in person.
   */
  opts: { password?: string; send?: boolean } = {},
): Promise<{ emailed: boolean; mailError: string | null; password: string }> {
  const password = opts.password ?? newPassword();
  const { error } = await supabaseAdmin!.auth.admin.updateUserById(userId, {
    password,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);

  let emailed = false;
  let mailError: string | null = null;
  if (opts.send === false) return { emailed, mailError, password };
  try {
    const sender = await orgSourceUserId(orgId);
    const gmail = sender ? await gmailFor(sender) : null;
    if (!gmail) throw new Error('No Google account is connected to send from');
    // Resolved before anything is sent: a bad address should stop the mail,
    // not produce one nobody can use.
    const mail = inviteEmail({ name: fullName, email, password, url: publicAppUrl() });
    await sendMessage(gmail, {
      to: email,
      cc: env.invite.cc,
      bcc: env.invite.bcc,
      subject: mail.subject,
      body: mail.text,
      html: mail.html,
    });
    emailed = true;
  } catch (err) {
    mailError = (err as Error).message;
    console.error('[team] invite email failed:', mailError);
  }

  return { emailed, mailError, password };
}

/** Long enough to mean "until someone turns it back on" — about a century. */
const DISABLED_FOR = '876000h';

function isBanned(bannedUntil: string | null | undefined): boolean {
  const at = bannedUntil ? Date.parse(bannedUntil) : NaN;
  return !Number.isNaN(at) && at > Date.now();
}

/** Of these people, the ones whose sign-in account is currently disabled. */
async function disabledUserIds(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!supabaseAdmin || !ids.length) return out;
  const wanted = new Set(ids);
  try {
    // A studio is a handful of people; one page covers everybody, and the
    // loop is only there so a large directory cannot silently cut it short.
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw new Error(error.message);
      for (const u of data.users) if (wanted.has(u.id) && isBanned(u.banned_until)) out.add(u.id);
      if (data.users.length < 1000) break;
    }
  } catch (err) {
    // The roster is still worth showing without the flag.
    console.error('[team] sign-in accounts unreadable:', (err as Error).message);
  }
  return out;
}

/** Bounds Supabase accepts for a password; the minimum matches the reset screen. */
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72;

export const teamRouter = Router();
teamRouter.use(requireAuth);
// Closing a module to a role has to mean something: until now nothing
// anywhere checked `read`, so revoking it would have been a switch that
// changed nothing. No view, no module — writes are still checked
// separately below.
teamRouter.use(requirePermission('team', 'read'));

// The people in this org, for assignee pickers and the admin screen.
// RLS scopes it to the caller's org.
teamRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('profiles')
      .select(await profileColumns('id, full_name, email, role, created_at'))
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);

    // How much live work each person is carrying, so the principal can see
    // load before reassigning. A missing tasks table must not break the
    // screen — the roster is still worth showing.
    const { data: tasks } = await req.auth!.db
      .from('tasks')
      .select('assigned_to')
      .in('status', ['open', 'in_progress', 'blocked']);
    const load = new Map<string, number>();
    for (const t of tasks ?? []) {
      const id = (t as { assigned_to: string | null }).assigned_to;
      if (id) load.set(id, (load.get(id) ?? 0) + 1);
    }

    // The select is built at runtime (seat only exists after 0008), so the
    // client cannot infer a row type for it.
    const rows = (data ?? []) as unknown as Record<string, unknown>[];

    // Whose Google is connected. A person's mail is only read once they
    // connect, so an unconnected teammate is a board with nothing on it —
    // worth seeing at a glance. Read as the server: row-level security lets
    // each person see only their own integration row. Status and scopes
    // only; the tokens never leave this query.
    const ids = rows.map((p) => p.id as string);
    const google = new Map<string, { status: string; scopes: string | null; connected_at: string | null }>();
    if (supabaseAdmin && ids.length) {
      const { data: integrations } = await supabaseAdmin
        .from('integrations')
        .select('user_id, status, scopes, connected_at')
        .eq('provider', 'google')
        .in('user_id', ids);
      for (const row of (integrations ?? []) as { user_id: string; status: string; scopes: string | null; connected_at: string | null }[]) {
        google.set(row.user_id, row);
      }
    }

    // What the keep-alive last found: a grant Google refused since they
    // connected needs them to reconnect, and nobody else can do it for them.
    const health = await latestGoogleHealth(ids);

    // Who has been disabled. The ban lives on the sign-in account, not the
    // profile, so it is read from there.
    const disabled = await disabledUserIds(ids);

    res.json({
      data: rows.map((p) => {
        const id = p.id as string;
        const g = google.get(id);
        const connected = g?.status === 'connected';
        const services = connected ? servicesGranted(g?.scopes) : { gmail: false, drive: false };
        const h = health.get(id);
        const refused = connected && h && !h.ok && (!g?.connected_at || h.at > g.connected_at) ? h : null;
        return {
          ...p,
          live_tasks: load.get(id) ?? 0,
          is_you: id === req.auth!.userId,
          disabled: disabled.has(id),
          google: {
            connected: connected && (services.gmail || services.drive),
            ...services,
            connected_at: connected ? g?.connected_at ?? null : null,
            needs_reconnect: refused ? refused.reason ?? 'Google refused the stored access' : null,
          },
        };
      }),
    });
  }),
);

// What the caller may do on this screen, so it offers only those controls.
// The routes below check again; this only decides what is shown.
teamRouter.get('/can', (req, res) => {
  const { permissions, role } = req.auth!;
  res.json({
    data: {
      create: canWith(permissions, role, 'team', 'create'),
      update: canWith(permissions, role, 'team', 'update'),
      delete: canWith(permissions, role, 'team', 'delete'),
      impersonate: mayImpersonate(req.auth!),
    },
  });
});

/**
 * Who may sign in as somebody else: the studio's admin mailbox and nobody
 * else, and only while it holds the principal role. Named by address rather
 * than by role on purpose — every principal can already change roles, and
 * "act as anyone" must not come with them. IMPERSONATOR_EMAILS overrides.
 */
const IMPERSONATORS = (process.env.IMPERSONATOR_EMAILS || 'systems@janelleinteriors.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function mayImpersonate(auth: { email: string | null; role: UserRole | null }): boolean {
  return auth.role === 'principal' && Boolean(auth.email) && IMPERSONATORS.includes(auth.email!.toLowerCase());
}

/**
 * Sign in as a teammate, without their password — to see exactly what they
 * see when they report a problem.
 *
 * Returns a one-time sign-in token for that person's account; the browser
 * exchanges it for a session and keeps the admin's own session aside to
 * return to. Nothing is emailed to them. Every use is written to the audit
 * log, because it is the most powerful thing this API can do.
 */
teamRouter.post(
  '/:id/impersonate',
  asyncHandler(async (req, res) => {
    const auth = req.auth!;
    if (!mayImpersonate(auth)) {
      return res.status(403).json({ error: 'Only the studio admin account can sign in as someone else.' });
    }
    if (!supabaseAdmin || !auth.orgId) return res.status(503).json({ error: 'Backend not configured' });

    const id = String(req.params.id);
    if (id === auth.userId) return res.status(400).json({ error: 'That is your own account.' });

    const { data: target } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email, org_id')
      .eq('id', id)
      .maybeSingle();
    const person = target as { id: string; full_name: string | null; email: string | null; org_id: string } | null;
    if (!person || person.org_id !== auth.orgId) return res.status(404).json({ error: 'Person not found in this studio' });
    if (!person.email) return res.status(400).json({ error: 'They have no sign-in email.' });
    if ((await disabledUserIds([person.id])).has(person.id)) {
      return res.status(400).json({ error: 'Their account is disabled — enable it first.' });
    }

    // A magic-link token, generated rather than sent: no email goes out.
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email: person.email });
    const tokenHash = data?.properties?.hashed_token;
    if (error || !tokenHash) throw new Error(error?.message ?? 'Could not issue a sign-in token');

    await supabaseAdmin.from('activity_log').insert({
      org_id: auth.orgId,
      actor: auth.userId,
      action: 'auth.impersonate',
      entity: 'profiles',
      entity_id: person.id,
      meta: { as: person.email },
    });

    res.json({ data: { token_hash: tokenHash, email: person.email, name: person.full_name ?? person.email } });
  }),
);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Change someone's name, sign-in email, role or seat. This is how access is
// granted, so only those the permission matrix allows.
teamRouter.patch(
  '/:id',
  requirePermission('team', 'update'),
  asyncHandler(async (req, res) => {
    // Role and seat are set through the same screen but mean different
    // things: the role is what the software lets you touch, the seat is the
    // outcome the roles document holds you to. Either may be sent alone.
    const hasRole = 'role' in (req.body ?? {});
    const hasSeat = 'seat' in (req.body ?? {});
    const hasName = 'full_name' in (req.body ?? {});
    const hasEmail = 'email' in (req.body ?? {});
    const fullName = String(req.body?.full_name ?? '').replace(/\s+/g, ' ').trim();
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (hasName && (!fullName || fullName.length > 120)) {
      return res.status(400).json({ error: 'A name is required (at most 120 characters)' });
    }
    if (hasEmail && !EMAIL.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    const role = String(req.body?.role ?? '');
    // An empty seat is meaningful — it takes the seat away again.
    const seat = req.body?.seat === null || req.body?.seat === '' ? null : String(req.body?.seat ?? '');

    if (hasRole && !USER_ROLES.includes(role as UserRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (hasSeat && seat !== null && !SEAT_KEYS.includes(seat as Seat)) {
      return res.status(400).json({ error: 'Invalid seat' });
    }
    if (!hasRole && !hasSeat && !hasName && !hasEmail) {
      return res.status(400).json({ error: 'Nothing to change' });
    }

    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });

    if (hasSeat && !(await hasSeatColumn())) {
      return res.status(503).json({
        error: 'Seats are not available yet — apply migration 0008 (npm run db:apply) first',
      });
    }

    const { data: target } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email, role, org_id')
      .eq('id', req.params.id)
      .maybeSingle();

    // Scoped to the caller's own studio: a principal changes their org, not others.
    if (!target || (target as { org_id: string }).org_id !== req.auth!.orgId) {
      return res.status(404).json({ error: 'Person not found in this studio' });
    }

    // A studio with no principal cannot grant access to anyone again, so
    // refuse to demote the last one rather than leaving it unrecoverable.
    // This covers demoting ANY principal, not only yourself — the studio is
    // just as stuck either way.
    if (hasRole && (target as { role: string }).role === 'principal' && role !== 'principal') {
      const { count } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', req.auth!.orgId)
        .eq('role', 'principal');
      if ((count ?? 0) <= 1) {
        return res.status(400).json({
          error: 'That is the studio’s only principal — promote someone else first',
        });
      }
    }

    // Row-level security lets a person update only their OWN profile row
    // (`profiles_update_self` in 0001), so doing this through the caller's
    // client matched nothing and surfaced as a baffling "Person not found" —
    // the role dropdown could never change anybody. Authorisation for this is
    // requirePermission('team','update') above; the write goes through the
    // service client, exactly as inviting and adding a teammate already do.
    const patch: Record<string, unknown> = {};
    if (hasRole) patch.role = role;
    if (hasSeat) patch.seat = seat;
    if (hasName) patch.full_name = fullName;

    // A new sign-in address changes the account itself, not only the profile.
    // Confirmed on the spot, so Supabase sends no confirmation email to
    // either address — changing someone's email never mails them.
    const previousEmail = (target as { email: string | null }).email;
    if (hasEmail && email !== (previousEmail ?? '').toLowerCase()) {
      const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, { email, email_confirm: true });
      if (authErr) {
        return res.status(400).json({
          error: /already|exists|registered/i.test(authErr.message) ? 'That email already has an account' : authErr.message,
        });
      }
      patch.email = email;
    }
    if (!Object.keys(patch).length) return res.json({ data: target });

    // One seat, one holder: the roles document allows a person two seats but
    // never two people in one seat, and the whole point of routing by seat is
    // that it names exactly one person. Clear it from whoever held it.
    if (hasSeat && seat) {
      await supabaseAdmin
        .from('profiles')
        .update({ seat: null })
        .eq('org_id', req.auth!.orgId)
        .eq('seat', seat)
        .neq('id', req.params.id);
    }

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update(patch)
      .eq('id', req.params.id)
      .select(await profileColumns('id, full_name, email, role'))
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Person not found in this studio' });

    await supabaseAdmin.from('activity_log').insert({
      org_id: req.auth!.orgId,
      actor: req.auth!.userId,
      action: hasRole || hasSeat ? 'team.role_change' : 'team.edit',
      entity: 'profiles',
      entity_id: req.params.id,
      meta: {
        ...(hasRole ? { role } : {}),
        ...(hasSeat ? { seat } : {}),
        ...(hasName ? { renamed_from: (target as { full_name: string | null }).full_name } : {}),
        ...(patch.email ? { email_from: previousEmail, email_to: patch.email } : {}),
        name: (data as unknown as { full_name: string | null }).full_name,
      },
    });

    res.json({ data });
  }),
);

/**
 * Invite a teammate. Creates the auth user and their profile, then asks
 * Supabase to email them a sign-in link.
 *
 * This SENDS AN EMAIL, which is why it is a deliberate action behind its own
 * button rather than something the system does on its own.
 */
teamRouter.post(
  '/invite',
  requirePermission('team', 'create'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });

    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const fullName = String(req.body?.full_name ?? '').trim();
    const role = String(req.body?.role ?? 'assistant');
    if (!email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    if (!USER_ROLES.includes(role as UserRole)) return res.status(400).json({ error: 'Invalid role' });

    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    // Created directly, not invited.
    //
    // `inviteUserByEmail` sends through Supabase's own mailer, which is what
    // produced "email rate limit exceeded" — the built-in sender allows only
    // a handful an hour. It also gives no way to add a password, a Cc or a
    // Bcc, because its template is fixed. So the account is made here and the
    // studio sends its own welcome from its own mailbox.
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      // No confirmation round-trip: they were added by a principal, and the
      // password issued below is what proves they were meant to be here.
      email_confirm: true,
      user_metadata: { full_name: fullName || email.split('@')[0] },
    });
    if (createErr || !created?.user) {
      const msg = createErr?.message ?? 'Could not create the account';
      return res.status(400).json({ error: /already|registered/i.test(msg) ? 'That email already has an account' : msg });
    }

    const { error: profileErr } = await supabaseAdmin.from('profiles').insert({
      id: created.user.id,
      org_id: orgId,
      full_name: fullName || email.split('@')[0],
      email,
      role,
    });
    if (profileErr) throw new Error(profileErr.message);

    // Sent from the studio's own mailbox, so it arrives from an address the
    // person recognises and carries the Cc and Bcc the studio asked for.
    // A failure here must not undo the account: they exist either way, and
    // the password comes back so a principal can pass it on by hand.
    const { emailed, mailError, password: sentPassword } = await issueCredentials(
      orgId,
      created.user.id,
      email,
      fullName,
    );

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'team.invite',
      entity: 'profiles',
      entity_id: created.user.id,
      // Never the password.
      meta: { email, role, emailed },
    });

    // The password is returned so the principal can hand it over when the
    // mail did not go. It is shown once and never stored anywhere readable.
    res.json({ data: { id: created.user.id, email, role, emailed, mailError, password: sentPassword } });
  }),
);

/**
 * Add a teammate WITHOUT emailing them — for seeding the roster the studio
 * already agreed offline. They can sign in later with the same address.
 */
teamRouter.post(
  '/',
  requirePermission('team', 'create'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });

    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const fullName = String(req.body?.full_name ?? '').trim();
    const role = String(req.body?.role ?? 'assistant');
    if (!email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    if (!USER_ROLES.includes(role as UserRole)) return res.status(400).json({ error: 'Invalid role' });

    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    // A profile row is keyed to an auth user, so one has to exist first.
    // Created without a confirmation email; they set a password via the
    // normal "forgot password" flow when they first sign in.
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      const msg = createErr?.message ?? 'Could not create the account';
      return res.status(400).json({ error: /already/i.test(msg) ? 'That email already has an account' : msg });
    }

    const { error: profileErr } = await supabaseAdmin.from('profiles').insert({
      id: created.user.id,
      org_id: orgId,
      full_name: fullName || email.split('@')[0],
      email,
      role,
    });
    if (profileErr) throw new Error(profileErr.message);

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'team.add',
      entity: 'profiles',
      entity_id: created.user.id,
      meta: { email, role },
    });

    res.json({ data: { id: created.user.id, email, role } });
  }),
);

/**
 * Remove someone from the studio: their sign-in account and their profile.
 *
 * Nothing they touched is lost. Their tasks stay on the board, unassigned,
 * for whoever runs it to hand on; what they wrote keeps its history with the
 * author left blank (the foreign keys set it null). Refused for yourself, for
 * the studio's last principal, and for the account the studio's Gmail and
 * Drive are read through — removing that one would stop the reading.
 */
teamRouter.delete(
  '/:id',
  requirePermission('team', 'delete'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    const orgId = req.auth!.orgId;
    const id = req.params.id;

    if (id === req.auth!.userId) {
      return res.status(400).json({ error: 'You cannot remove your own account' });
    }

    const { data: target } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email, role, org_id')
      .eq('id', id)
      .maybeSingle();
    const person = target as { id: string; full_name: string | null; email: string | null; role: UserRole; org_id: string } | null;
    if (!person || person.org_id !== orgId) {
      return res.status(404).json({ error: 'Person not found in this studio' });
    }

    if (person.role === 'principal') {
      const { count } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('role', 'principal');
      if ((count ?? 0) <= 1) {
        return res.status(400).json({ error: 'That is the studio’s only principal — make someone else principal first' });
      }
    }

    const { data: google } = await supabaseAdmin
      .from('integrations')
      .select('status')
      .eq('user_id', id)
      .eq('provider', 'google')
      .maybeSingle();
    if ((google as { status?: string } | null)?.status === 'connected') {
      return res.status(400).json({
        error: 'The studio’s Gmail and Drive are connected through this account — connect Google from another principal in Settings first',
      });
    }

    // Counted before, because afterwards they belong to nobody.
    const { count: openTasks } = await supabaseAdmin
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('assigned_to', id)
      .in('status', ['open', 'in_progress', 'blocked']);

    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(id);
    if (authErr && !/not.?found/i.test(authErr.message)) throw new Error(authErr.message);
    // Deleting the account removes the profile with it; a profile with no
    // account behind it is removed directly.
    await supabaseAdmin.from('profiles').delete().eq('id', id).eq('org_id', orgId);

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'team.remove',
      entity: 'profiles',
      entity_id: id,
      meta: { name: person.full_name, email: person.email, role: person.role, unassigned_tasks: openTasks ?? 0 },
    });

    res.json({ data: { id, unassigned_tasks: openTasks ?? 0 } });
  }),
);

/**
 * Send an existing teammate their sign-in details.
 *
 * For the roster that was seeded offline, and for anyone who has lost their
 * way in. It sets a NEW password, so it is not a way of looking up the old
 * one — nobody, including a principal, can read an existing password, and
 * this does not pretend otherwise.
 *
 * That makes it destructive in one specific way: whatever they were using
 * stops working. The screen says so before it is pressed.
 */
teamRouter.post(
  '/:id/invite',
  requirePermission('team', 'update'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const { data: person } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email, org_id')
      .eq('id', req.params.id)
      .maybeSingle();
    const target = person as { id: string; full_name: string | null; email: string | null; org_id: string } | null;

    // Scoped to the caller's own studio: the admin client bypasses row
    // security, so the check the database would have made is made here.
    if (!target || target.org_id !== orgId) return res.status(404).json({ error: 'No such person' });
    if (!target.email) return res.status(400).json({ error: 'That person has no email address on file' });

    const { emailed, mailError, password } = await issueCredentials(
      orgId,
      target.id,
      target.email,
      target.full_name ?? '',
    );

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'team.reinvite',
      entity: 'profiles',
      entity_id: target.id,
      // Never the password.
      meta: { email: target.email, emailed },
    });

    res.json({ data: { id: target.id, email: target.email, emailed, mailError, password } });
  }),
);

/** A person in the caller's studio, or null. The admin client skips row security, so the org is checked here. */
async function memberOf(orgId: string | null, id: string) {
  if (!supabaseAdmin || !orgId) return null;
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email, role, org_id')
    .eq('id', id)
    .maybeSingle();
  const person = data as { id: string; full_name: string | null; email: string | null; role: UserRole; org_id: string } | null;
  return person && person.org_id === orgId ? person : null;
}

/**
 * Reset a teammate's password.
 *
 * The admin either types the new one or has one generated, and chooses
 * whether it is emailed. Unlike "Invite", which always generates and always
 * sends, this is for handing a password over in person or on a call.
 * Whatever they were using stops working at once.
 */
teamRouter.post(
  '/:id/password',
  requirePermission('team', 'update'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    const orgId = req.auth!.orgId;
    const person = await memberOf(orgId, String(req.params.id));
    if (!person) return res.status(404).json({ error: 'Person not found in this studio' });

    const typed = typeof req.body?.password === 'string' ? req.body.password : '';
    if (typed && (typed.length < MIN_PASSWORD || typed.length > MAX_PASSWORD)) {
      return res.status(400).json({ error: `Use between ${MIN_PASSWORD} and ${MAX_PASSWORD} characters.` });
    }
    if (typed && typed.trim() !== typed) {
      return res.status(400).json({ error: 'The password cannot start or end with a space.' });
    }
    const send = req.body?.notify === true;
    if (send && !person.email) return res.status(400).json({ error: 'They have no email address to send it to.' });

    const { emailed, mailError, password } = await issueCredentials(
      orgId!,
      person.id,
      person.email ?? '',
      person.full_name ?? '',
      { password: typed || undefined, send },
    );

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'team.password_reset',
      entity: 'profiles',
      entity_id: person.id,
      // Never the password.
      meta: { name: person.full_name, email: person.email, chosen: Boolean(typed), emailed },
    });

    // A generated password comes back once so it can be handed over; one the
    // admin typed is not echoed — they already have it.
    res.json({
      data: { id: person.id, email: person.email, emailed, mailError, password: typed ? null : password },
    });
  }),
);

/**
 * Disable or re-enable a teammate's account.
 *
 * Disabled means they cannot sign in, and the session they have is refused
 * on their next request (see requireAuth). Nothing else changes: their
 * tasks, their mail and their history stay where they are, so turning them
 * back on is exactly as it was. Removing them is the permanent version.
 */
teamRouter.post(
  '/:id/status',
  requirePermission('team', 'update'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    const orgId = req.auth!.orgId;
    const id = String(req.params.id);
    if (typeof req.body?.disabled !== 'boolean') return res.status(400).json({ error: 'Say whether to disable or enable' });
    const disable = req.body.disabled as boolean;

    if (disable && id === req.auth!.userId) {
      return res.status(400).json({ error: 'You cannot disable your own account' });
    }
    const person = await memberOf(orgId, id);
    if (!person) return res.status(404).json({ error: 'Person not found in this studio' });

    // A studio whose every principal is disabled has nobody who can turn
    // anyone back on — the same trap as demoting the last principal.
    if (disable && person.role === 'principal') {
      const { data: principals } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('org_id', orgId)
        .eq('role', 'principal');
      const others = ((principals ?? []) as { id: string }[]).map((p) => p.id).filter((p) => p !== id);
      const off = await disabledUserIds(others);
      if (others.every((p) => off.has(p))) {
        return res.status(400).json({ error: 'That is the studio’s only active principal — make someone else principal first' });
      }
    }

    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { ban_duration: disable ? DISABLED_FOR : 'none' });
    if (error) throw new Error(error.message);

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: disable ? 'team.disable' : 'team.enable',
      entity: 'profiles',
      entity_id: id,
      meta: { name: person.full_name, email: person.email },
    });

    res.json({ data: { id, disabled: disable } });
  }),
);
