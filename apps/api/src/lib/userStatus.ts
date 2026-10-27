import { supabaseAdmin } from './supabase.js';

/**
 * Whether a sign-in account is currently banned (disabled).
 *
 * Supabase stores a ban as `banned_until`, a timestamp: a far-future one for a
 * standing ban, and a past one once it has been lifted. So "disabled" is not
 * "has a value" but "has a value still ahead of now".
 */
export function isBanned(bannedUntil: string | null | undefined): boolean {
  return !!bannedUntil && new Date(bannedUntil).getTime() > Date.now();
}

/**
 * Which of the given users are disabled. The ban lives on the sign-in account,
 * not the profile, so it is read from Supabase auth rather than `profiles`.
 * Best-effort: if the auth list is unreadable the caller still has a roster,
 * so an empty set (nobody flagged) is returned rather than throwing.
 */
export async function disabledUserIds(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!supabaseAdmin || !ids.length) return out;
  const wanted = new Set(ids);
  try {
    // A studio is a handful of people; one page covers everybody, and the loop
    // is only there so a large directory cannot silently cut it short.
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw new Error(error.message);
      for (const u of data.users) if (wanted.has(u.id) && isBanned(u.banned_until)) out.add(u.id);
      if (data.users.length < 1000) break;
    }
  } catch (err) {
    console.error('[userStatus] sign-in accounts unreadable:', (err as Error).message);
  }
  return out;
}
