// ============================================================
//  Verify apps/api/src/services/gmailThreads.ts (Task D2).
//  READ-ONLY: only Gmail threads.get and database SELECTs.
//  Dev database + TEST Google account only (guarded).
//
//  Usage (from repo root):
//    npx tsx scripts/verify/gmailThreads.ts --mailbox <profileId> --thread <threadId>
//    npx tsx scripts/verify/gmailThreads.ts --mailbox <profileId> --bonus
//
//  --mailbox  profile whose Google (test account) holds the thread
//  --thread   a real thread ID from that mailbox (e.g. emails.thread_id)
//  --bonus    count how many open dev tasks WOULD auto-close because the
//             team already replied (prints only, changes nothing)
// ============================================================
import { assertNotProduction, check, failureCount, skip } from './_guard.js';

assertNotProduction();

const { supabaseAdmin } = await import('../../apps/api/src/lib/supabase.js');
const { resolveOrgId } = await import('../../apps/api/src/lib/org.js');
const { getThread, getTeamAddresses, lastInboundAt, teamRepliedAfter } = await import('../../apps/api/src/services/gmailThreads.js');

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const mailbox = arg('--mailbox');
const threadId = arg('--thread');
const BONUS = process.argv.includes('--bonus');
const orgId = await resolveOrgId();
if (!supabaseAdmin || !orgId) {
  console.error('✗ Supabase is not configured, or no single organization was found.');
  process.exit(1);
}
const team = await getTeamAddresses(orgId);
console.log(`Team addresses (${team.size}): ${[...team].join(', ')}\n`);

// 1. A real thread.
if (!mailbox || !threadId) {
  skip('real thread checks', 'pass --mailbox <profileId> --thread <threadId>');
} else {
  const thread = await getThread(mailbox, threadId);
  check('getThread returns messages without error', !thread.error && thread.messages.length > 0, thread.error ?? `${thread.messages.length} message(s)`);
  for (const m of thread.messages) {
    console.log(`      ${m.at.toISOString()}  ${team.has(m.from) ? 'TEAM ' : 'other'}  ${m.from}`);
  }

  const teamMsgs = thread.messages.filter((m) => team.has(m.from));
  const lastTeam = teamMsgs[teamMsgs.length - 1];
  if (!lastTeam) {
    skip('teamRepliedAfter before/after the last team reply', 'this thread has no message from a team address — pick one where the team replied');
  } else {
    const before = new Date(lastTeam.at.getTime() - 60_000);
    const after = new Date(lastTeam.at.getTime() + 60_000);
    const r1 = await teamRepliedAfter({ mailboxUserId: mailbox, threadId, after: before, teamAddresses: team });
    const r2 = await teamRepliedAfter({ mailboxUserId: mailbox, threadId, after, teamAddresses: team });
    check('a date BEFORE the last team reply → replied = true', r1.replied === true, JSON.stringify(r1));
    check('a date AFTER the last team reply → replied = false', r2.replied === false && !r2.error, JSON.stringify(r2));
  }

  const inbound = await lastInboundAt({ mailboxUserId: mailbox, threadId, teamAddresses: team });
  check('lastInboundAt returns without error', !inbound.error, inbound.at ? `latest outside message ${inbound.at.toISOString()}` : 'no message from outside the team');
}

// 2. A fake thread ID must come back as an error, not a crash.
if (!mailbox) {
  skip('fake thread ID → error, no crash', 'pass --mailbox <profileId>');
} else {
  const fake = await teamRepliedAfter({ mailboxUserId: mailbox, threadId: 'ffffffffffffffff', after: new Date(0), teamAddresses: team });
  check('fake thread ID → replied = false with an error, no crash', fake.replied === false && Boolean(fake.error), fake.error ?? 'no error returned');
}

// 3. Bonus: how many open tasks would auto-close (read-only).
if (!BONUS) {
  skip('bonus: would-auto-close count', 'run with --bonus');
} else {
  const { data, error } = await supabaseAdmin
    .from('tasks')
    .select('id, title, created_at, emails!inner(thread_id, owner_id)')
    .eq('org_id', orgId)
    .in('status', ['open', 'in_progress', 'blocked'])
    .not('source_email_id', 'is', null);
  if (error) {
    check('bonus: read open tasks', false, error.message);
  } else {
    type Row = { id: string; title: string; created_at: string; emails: { thread_id: string | null; owner_id: string | null } | null };
    const rows = (data ?? []) as unknown as Row[];
    let wouldClose = 0;
    let noThread = 0;
    let errors = 0;
    for (const t of rows) {
      const threadOf = t.emails?.thread_id;
      const owner = t.emails?.owner_id;
      if (!threadOf || !owner) {
        noThread += 1;
        continue;
      }
      const r = await teamRepliedAfter({ mailboxUserId: owner, threadId: threadOf, after: new Date(t.created_at), teamAddresses: team });
      if (r.error) errors += 1;
      else if (r.replied) wouldClose += 1;
    }
    console.log(`\nBONUS (nothing changed): ${rows.length} open Gmail task(s) checked`);
    console.log(`  would auto-close (team replied after creation): ${wouldClose}`);
    console.log(`  no thread / mailbox on the source email:       ${noThread}`);
    console.log(`  Gmail errors (skipped):                        ${errors}`);
  }
}

const failed = failureCount();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll run checks passed');
process.exit(failed ? 1 : 0);
