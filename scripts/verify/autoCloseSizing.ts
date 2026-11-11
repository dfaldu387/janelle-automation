// ============================================================
//  Auto-close sizing — READ-ONLY (Task D2 bonus).
//
//  How many open Gmail tasks WOULD auto-close because a team member
//  already replied in the thread after the task was created?
//
//  Strictly read-only, by construction:
//    - database: SELECT only (tasks, emails, profiles, integrations)
//    - Gmail:    users.threads.get, metadata (From/Date) only
//    - Google tokens are used IN MEMORY; refreshed tokens are NOT written
//      back (unlike the app's normal client), so nothing is written anywhere.
//  The only file written is the optional local CSV (--csv <path>).
//
//  Usage (from repo root):
//    npx tsx scripts/verify/autoCloseSizing.ts                      # dev database
//    npx tsx scripts/verify/autoCloseSizing.ts --production-readonly [--csv out.csv]
//
//  --production-readonly is required when .env points at production
//  (approved by Denish 2026-11-11 for this read-only check).
// ============================================================
import { writeFileSync } from 'node:fs';
import { isProductionDb } from './_guard.js';

const PROD_OK = process.argv.includes('--production-readonly');
if (isProductionDb() && !PROD_OK) {
  console.error('✗ .env points at PRODUCTION. Re-run with --production-readonly to run this read-only check there.');
  process.exit(1);
}

const { supabaseAdmin } = await import('../../apps/api/src/lib/supabase.js');
const { resolveOrgId } = await import('../../apps/api/src/lib/org.js');
const { decrypt } = await import('../../apps/api/src/lib/crypto.js');
const { oauthClient, servicesGranted } = await import('../../apps/api/src/lib/google.js');
const { getTeamAddresses, teamRepliedAfter } = await import('../../apps/api/src/services/gmailThreads.js');
const { gmail: gmailApi } = await import('@googleapis/gmail');

type Gmail = ReturnType<typeof gmailApi>;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const csvPath = arg('--csv');

if (!supabaseAdmin) {
  console.error('✗ Supabase is not configured (.env).');
  process.exit(1);
}
const db = supabaseAdmin;
const orgId = await resolveOrgId();
if (!orgId) {
  console.error('✗ Could not resolve a single organization.');
  process.exit(1);
}
console.log(`Database: ${isProductionDb() ? 'PRODUCTION (read-only mode)' : 'dev'}\n`);

// ---- Read-only Gmail clients, one per mailbox owner -------------------
const clients = new Map<string, Gmail | null>();
async function readOnlyGmail(userId: string): Promise<Gmail | null> {
  if (clients.has(userId)) return clients.get(userId)!;
  let client: Gmail | null = null;
  const { data } = await db
    .from('integrations')
    .select('encrypted_tokens, status, scopes')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle();
  const row = data as { encrypted_tokens: string | null; status: string; scopes: string | null } | null;
  if (row?.encrypted_tokens && row.status === 'connected' && servicesGranted(row.scopes).gmail) {
    try {
      const auth = oauthClient();
      auth.setCredentials(JSON.parse(decrypt(row.encrypted_tokens)));
      // Deliberately NO auth.on('tokens') handler: refreshed tokens stay in memory.
      client = gmailApi({ version: 'v1', auth });
    } catch (err) {
      console.error(`  could not open mailbox ${userId}:`, (err as Error).message);
    }
  }
  clients.set(userId, client);
  return client;
}

// ---- Data -------------------------------------------------------------
const LIVE = ['open', 'in_progress', 'blocked'];
const team = await getTeamAddresses(orgId);

const { count: liveTotal, error: countError } = await db
  .from('tasks')
  .select('id', { count: 'exact', head: true })
  .eq('org_id', orgId)
  .in('status', LIVE);
if (countError) throw new Error(countError.message);

type Row = {
  id: string; title: string; status: string; created_at: string;
  emails: { thread_id: string | null; owner_id: string | null } | null;
};
const rows: Row[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db
    .from('tasks')
    .select('id, title, status, created_at, emails!inner(thread_id, owner_id)')
    .eq('org_id', orgId)
    .in('status', LIVE)
    .not('source_email_id', 'is', null)
    .order('created_at', { ascending: true })
    .range(from, from + 999);
  if (error) throw new Error(error.message);
  rows.push(...((data ?? []) as unknown as Row[]));
  if ((data ?? []).length < 1000) break;
}

// ---- Check each thread ------------------------------------------------
type Outcome = { row: Row; result: 'would_close' | 'stays_open' | 'no_thread' | 'no_mailbox' | 'gmail_error'; at?: Date; error?: string };
const outcomes: Outcome[] = [];
let done = 0;
async function checkOne(row: Row): Promise<Outcome> {
  const threadId = row.emails?.thread_id;
  const owner = row.emails?.owner_id;
  if (!threadId || !owner) return { row, result: 'no_thread' };
  const gmail = await readOnlyGmail(owner);
  if (!gmail) return { row, result: 'no_mailbox' };
  const r = await teamRepliedAfter({ mailboxUserId: owner, threadId, after: new Date(row.created_at), teamAddresses: team, gmail });
  if (r.error) return { row, result: 'gmail_error', error: r.error };
  return r.replied ? { row, result: 'would_close', at: r.at } : { row, result: 'stays_open' };
}
const queue = [...rows];
const started = Date.now();
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      outcomes.push(await checkOne(row));
      done += 1;
      if (done % 25 === 0) console.log(`  …checked ${done}/${rows.length}`);
    }
  }),
);

// ---- Report -----------------------------------------------------------
const by = (k: Outcome['result']) => outcomes.filter((o) => o.result === k);
const wouldClose = by('would_close');
const statusOf = (list: Outcome[]) =>
  LIVE.map((s) => `${s} ${list.filter((o) => o.row.status === s).length}`).join(', ');

console.log(`\n=== Auto-close sizing (nothing was changed) — ${((Date.now() - started) / 1000).toFixed(0)}s ===`);
console.log(`Live tasks (open / in progress / blocked):        ${liveTotal ?? '?'}`);
console.log(`  of which raised from Gmail (checked):           ${rows.length}`);
console.log(`  not from Gmail (manual / Houzz, not checkable): ${(liveTotal ?? 0) - rows.length}`);
console.log('');
console.log(`WOULD AUTO-CLOSE (team replied after creation):   ${wouldClose.length}   [${statusOf(wouldClose)}]`);
console.log(`Stay open (no team reply after creation):         ${by('stays_open').length}`);
console.log(`Not checkable — no thread/mailbox on the email:   ${by('no_thread').length}`);
console.log(`Not checkable — mailbox not connected to Gmail:   ${by('no_mailbox').length}`);
console.log(`Gmail errors (skipped):                           ${by('gmail_error').length}`);
const errs = by('gmail_error').slice(0, 3);
for (const e of errs) console.log(`    e.g. ${e.error}`);

if (csvPath) {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = ['task_id,title,status,created_at,result,team_replied_at,error'];
  for (const o of outcomes) {
    lines.push([o.row.id, esc(o.row.title), o.row.status, o.row.created_at, o.result, o.at?.toISOString() ?? '', esc(o.error ?? '')].join(','));
  }
  writeFileSync(csvPath, lines.join('\n'));
  console.log(`\nPer-task CSV written to ${csvPath}`);
}
process.exit(0);
