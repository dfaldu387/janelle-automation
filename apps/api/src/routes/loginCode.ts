import { Router, type Request } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { deliveryAddressFor } from '../lib/studioTeam.js';
import {
  CODE_TTL_MS, MAX_ATTEMPTS, MAX_CODES_PER_HOUR, RESEND_AFTER_MS,
  codeRequiredFor, hashCode, isVerified, maskEmail, newCode, rememberVerified, sameHash,
} from '../lib/loginCode.js';
import { gmailFor, sendMessage } from '../services/gmail.js';
import { loginCodeEmail } from '../services/emailTemplate.js';

/**
 * Sending and checking the code asked for after signing in.
 * requireAuth lets these routes through before the code is entered; every
 * other route waits. See lib/loginCode.ts.
 */
export const loginCodeRouter = Router();
loginCodeRouter.use(requireAuth);

interface CodeRow {
  id: string;
  code_hash: string;
  attempts: number;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

/** The sign-in this request belongs to, when it is one that has to give a code. */
function pending(req: Request): { sessionId: string } | null {
  const a = req.auth!;
  if (!codeRequiredFor(a.signInMethod) || !a.sessionId) return null;
  return { sessionId: a.sessionId };
}

async function log(req: Request, action: string, meta: Record<string, unknown> = {}) {
  const a = req.auth!;
  const { error } = await supabaseAdmin!.from('activity_log').insert({
    org_id: a.orgId,
    actor: a.userId,
    action,
    entity: 'auth',
    entity_id: a.userId,
    meta: { email: a.email, ...meta },
  });
  if (error) console.error('[login-code] log failed:', error.message);
}

loginCodeRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const p = pending(req);
    const done = p ? await isVerified(p.sessionId) : true;
    res.json({ data: { required: Boolean(p) && !done, to: maskEmail(req.auth!.email) } });
  }),
);

loginCodeRouter.post(
  '/send',
  asyncHandler(async (req, res) => {
    const p = pending(req);
    const to = maskEmail(req.auth!.email);
    if (!p || (await isVerified(p.sessionId))) return res.json({ data: { required: false, to } });
    const { userId, orgId, email } = req.auth!;
    if (!email) return res.status(400).json({ error: 'This account has no email address to send a code to.' });

    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { data: recent, error } = await supabaseAdmin!
      .from('login_codes')
      .select('id, created_at, used_at, expires_at')
      .eq('session_id', p.sessionId)
      .gte('created_at', hourAgo)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    // A reload, or a second click, inside a minute keeps the code already sent.
    const latest = recent?.[0] as CodeRow | undefined;
    const age = latest ? Date.now() - Date.parse(latest.created_at) : Infinity;
    if (latest && !latest.used_at && age < RESEND_AFTER_MS) {
      return res.json({ data: { required: true, to, resendIn: Math.ceil((RESEND_AFTER_MS - age) / 1000) } });
    }
    if ((recent?.length ?? 0) >= MAX_CODES_PER_HOUR) {
      return res.status(429).json({ error: 'Too many codes sent. Wait an hour, or sign in again later.' });
    }

    const sender = orgId ? await orgSourceUserId(orgId) : null;
    const gmail = sender ? await gmailFor(sender) : null;
    if (!gmail) {
      console.error('[login-code] no studio mailbox to send from');
      return res.status(503).json({ error: 'The code email could not be sent. Ask the studio admin, or sign in with your password.' });
    }

    // Only the newest code works.
    await supabaseAdmin!
      .from('login_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('session_id', p.sessionId)
      .is('used_at', null);

    const code = newCode();
    const { data: row, error: insertError } = await supabaseAdmin!
      .from('login_codes')
      .insert({
        user_id: userId,
        session_id: p.sessionId,
        code_hash: hashCode(p.sessionId, code),
        expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      })
      .select('id')
      .single();
    if (insertError) throw new Error(insertError.message);

    try {
      const mail = loginCodeEmail({ code, minutes: CODE_TTL_MS / 60_000 });
      await sendMessage(gmail, { to: deliveryAddressFor(email), subject: mail.subject, body: mail.text, html: mail.html });
    } catch (err) {
      await supabaseAdmin!.from('login_codes').delete().eq('id', (row as { id: string }).id);
      console.error('[login-code] send failed:', (err as Error).message);
      return res.status(503).json({ error: 'The code email could not be sent. Try again in a moment.' });
    }

    await log(req, 'auth.login_code_sent');
    res.json({ data: { required: true, to, resendIn: RESEND_AFTER_MS / 1000 } });
  }),
);

loginCodeRouter.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const p = pending(req);
    if (!p || (await isVerified(p.sessionId))) return res.json({ data: { verified: true } });

    const code = String(req.body?.code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code from the email.' });

    const { data, error } = await supabaseAdmin!
      .from('login_codes')
      .select('id, code_hash, attempts, expires_at, used_at, created_at')
      .eq('session_id', p.sessionId)
      .is('used_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as CodeRow | null;

    if (!row) return res.status(400).json({ error: 'There is no active code. Send a new one.' });
    if (Date.parse(row.expires_at) < Date.now()) {
      return res.status(400).json({ error: 'That code has expired. Send a new one.' });
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many wrong tries. Send a new code.' });
    }

    if (!sameHash(row.code_hash, hashCode(p.sessionId, code))) {
      const attempts = row.attempts + 1;
      await supabaseAdmin!.from('login_codes').update({ attempts }).eq('id', row.id);
      await log(req, 'auth.login_code_failed', { attempts });
      const left = MAX_ATTEMPTS - attempts;
      return res.status(400).json({
        error: left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong tries. Send a new code.',
      });
    }

    await supabaseAdmin!.from('login_codes').update({ used_at: new Date().toISOString() }).eq('id', row.id);
    const { error: saveError } = await supabaseAdmin!
      .from('verified_sessions')
      .upsert({ session_id: p.sessionId, user_id: req.auth!.userId }, { onConflict: 'session_id' });
    if (saveError) throw new Error(saveError.message);
    rememberVerified(p.sessionId);
    await log(req, 'auth.login_code_verified');
    res.json({ data: { verified: true } });
  }),
);
