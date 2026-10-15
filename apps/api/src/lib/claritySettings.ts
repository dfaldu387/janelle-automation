import { supabaseAdmin } from './supabase.js';

/**
 * Microsoft Clarity — session replay and heatmaps for the studio's own team.
 *
 * Clarity is loaded in the browser from a project id. The id lives in the
 * org's settings blob (not an env var) so an admin can set or change it
 * without a redeploy, and it is handed to every signed-in session through
 * `/me` so each person's use of the app is recorded. Only an admin ever sees
 * the id or the toggle; to everyone else the tag just loads, silently.
 *
 * Stored beside every other studio setting under `settings.clarity`, so it
 * needs no migration.
 */
const CLARITY_FIELD = 'clarity';

export interface ClaritySettings {
  /** The Clarity project id, or null when none has been set. */
  projectId: string | null;
  /** Whether recording is switched on. Off keeps the id but loads nothing. */
  enabled: boolean;
}

const EMPTY: ClaritySettings = { projectId: null, enabled: false };

/** A Clarity project id is a short run of letters and digits (e.g. `abcd1234ef`). */
export function normalizeClarityId(raw: unknown): string | null {
  const id = String(raw ?? '').trim().toLowerCase();
  return /^[a-z0-9]{4,40}$/.test(id) ? id : null;
}

export async function readClaritySettings(orgId: string): Promise<ClaritySettings> {
  if (!supabaseAdmin) return EMPTY;
  try {
    const { data } = await supabaseAdmin.from('organizations').select('settings').eq('id', orgId).maybeSingle();
    const raw = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {})[CLARITY_FIELD];
    const cfg = (raw && typeof raw === 'object' ? raw : {}) as Partial<ClaritySettings>;
    const projectId = normalizeClarityId(cfg.projectId);
    return { projectId, enabled: projectId ? cfg.enabled !== false : false };
  } catch (err) {
    console.error('[clarity] settings unreadable:', (err as Error).message);
    return EMPTY;
  }
}

/**
 * Save the project id and/or the on-off switch. An empty id clears it (and
 * turns recording off, since there is nothing left to load). Merged by
 * Postgres so it cannot clobber the other settings sharing the blob.
 */
export async function saveClaritySettings(
  orgId: string,
  patch: { projectId?: string | null; enabled?: boolean },
): Promise<ClaritySettings> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const current = await readClaritySettings(orgId);

  const next: ClaritySettings = { ...current };
  if (patch.projectId !== undefined) {
    const id = normalizeClarityId(patch.projectId);
    // A non-empty value that is not a valid id is a mistake worth reporting,
    // rather than silently clearing what was there.
    if (patch.projectId && !id) throw new Error('That does not look like a Clarity project id.');
    next.projectId = id;
  }
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (!next.projectId) next.enabled = false;

  const { error } = await supabaseAdmin.rpc('merge_org_settings', {
    p_org_id: orgId,
    p_patch: { [CLARITY_FIELD]: next },
  });
  if (error) throw new Error(error.message);
  return next;
}
