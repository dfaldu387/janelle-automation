// ============================================================
//  Verify apps/api/src/lib/time.ts (Task D1). Pure date logic:
//  no database, no network, safe to run anywhere.
//
//  Usage (from repo root):  npx tsx scripts/verify/time.ts
// ============================================================
import {
  addBusinessDays,
  businessDaysBetween,
  isBusinessDay,
  localDateFor,
  localTimeFor,
} from '../../apps/api/src/lib/time.js';

const LA = 'America/Los_Angeles';
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// Noon Pacific (PST, UTC-8) on each day, so the local date is unambiguous.
const pst = (ymd: string, hh = '12:00') => new Date(`${ymd}T${hh}:00-08:00`);
const fri = pst('2026-11-13');
const sat = pst('2026-11-14');
const sun = pst('2026-11-15');
const mon = pst('2026-11-16');
const thu = pst('2026-11-12');

// Required by docs/V2_FASTTRACK_C_D.md
{
  const n = businessDaysBetween(fri, mon, LA);
  check('due Fri, checked Mon → 1 business day overdue (not 3)', n === 1, `got ${n}`);
}
check('Saturday is not a business day', isBusinessDay(sat, LA) === false);
check('Sunday is not a business day', isBusinessDay(sun, LA) === false);
check('Monday–Friday are business days', [mon, thu, fri].every((d) => isBusinessDay(d, LA)));
{
  // 23:00 Pacific on Wed 11 Nov 2026 = 07:00 UTC on Thu 12 Nov.
  const late = new Date('2026-11-12T07:00:00Z');
  const local = localDateFor(late, LA);
  const utc = late.toISOString().slice(0, 10);
  check('23:00 Pacific on day X → local date X although UTC is X+1', local === '2026-11-11' && utc === '2026-11-12', `local ${local}, utc ${utc}`);
}
{
  const next = addBusinessDays(fri, 1, LA);
  check('addBusinessDays(Fri, 1) → Mon', localDateFor(next, LA) === '2026-11-16', `got ${localDateFor(next, LA)}`);
}

// Extra edge cases
{
  const n = businessDaysBetween(fri, sat, LA);
  check('due Fri, checked Sat → 0', n === 0, `got ${n}`);
}
{
  const n = businessDaysBetween(thu, mon, LA);
  check('due Thu, checked Mon → 2', n === 2, `got ${n}`);
}
{
  const n = businessDaysBetween(mon, fri, LA);
  check('earlier date second → negative (Mon → previous Fri = -1)', businessDaysBetween(mon, fri, LA) === -1 && n === -1, `got ${n}`);
}
{
  const back = addBusinessDays(mon, -1, LA);
  check('addBusinessDays(Mon, -1) → Fri', localDateFor(back, LA) === '2026-11-13', `got ${localDateFor(back, LA)}`);
}
{
  const fromSat = addBusinessDays(sat, 1, LA);
  check('addBusinessDays(Sat, 1) → Mon', localDateFor(fromSat, LA) === '2026-11-16', `got ${localDateFor(fromSat, LA)}`);
}
{
  // Across the end of daylight saving (1 Nov 2026): Fri 30 Oct 10:00 PDT → Mon 2 Nov 10:00 PST.
  const before = new Date('2026-10-30T10:00:00-07:00');
  const after = addBusinessDays(before, 1, LA);
  const wall = localTimeFor({ timezone: LA }, after);
  check('across DST change: Fri 10:00 + 1 → Mon 10:00 local', wall.date === '2026-11-02' && wall.time === '10:00', `got ${wall.date} ${wall.time}`);
}
{
  const t = localTimeFor({ timezone: null }, new Date('2026-11-12T07:00:00Z'));
  check('localTimeFor defaults to America/Los_Angeles', t.timezone === LA && t.date === '2026-11-11' && t.time === '23:00', `${t.timezone} ${t.date} ${t.time}`);
}
{
  const t = localTimeFor({ timezone: 'Not/AZone' }, mon);
  check('localTimeFor falls back to Pacific on an invalid zone', t.timezone === LA);
}
{
  const t = localTimeFor({ timezone: 'Asia/Kolkata' }, new Date('2026-11-12T07:00:00Z'));
  check('localTimeFor uses profiles.timezone (Kolkata 12:30 on 12 Nov)', t.date === '2026-11-12' && t.time === '12:30', `${t.date} ${t.time}`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
