import { supabaseAdmin } from './supabase.js';
import { addressOf } from './studioTeam.js';

/**
 * The document organiser — files email-attachment PDFs into a tidy Drive tree,
 * split Purchasing vs Accounting, by project.
 *
 * Off by default: it writes to Drive, so nobody's files move until an admin
 * turns it on. `senders` is whose attachments to file — Adeleigh and Carissa to
 * begin with, editable without a redeploy. Stored beside every other studio
 * setting under `settings.drive_filing`, so it needs no migration.
 */
const FIELD = 'drive_filing';

/** Who the studio asked to organise, by default. */
const DEFAULT_SENDERS = ['adeleigh@janelleinteriors.com', 'carissa@janelleinteriors.com'];

export interface DriveFilingSettings {
  /** Whether filing runs at all. */
  enabled: boolean;
  /** Addresses whose attachments are filed; empty means nobody. */
  senders: string[];
}

const EMPTY: DriveFilingSettings = { enabled: false, senders: DEFAULT_SENDERS };

/** Clean a list of addresses to bare, lower-cased, de-duplicated form. */
function normalizeSenders(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  for (const item of list) {
    const addr = addressOf(String(item ?? ''));
    if (addr) seen.add(addr);
  }
  return [...seen];
}

export async function readDriveFilingSettings(orgId: string): Promise<DriveFilingSettings> {
  if (!supabaseAdmin) return EMPTY;
  try {
    const { data } = await supabaseAdmin.from('organizations').select('settings').eq('id', orgId).maybeSingle();
    const raw = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {})[FIELD];
    const cfg = (raw && typeof raw === 'object' ? raw : {}) as Partial<DriveFilingSettings>;
    const senders = cfg.senders === undefined ? DEFAULT_SENDERS : normalizeSenders(cfg.senders);
    return { enabled: Boolean(cfg.enabled), senders };
  } catch (err) {
    console.error('[drive-filing] settings unreadable:', (err as Error).message);
    return EMPTY;
  }
}

/** Whether an address is one the organiser was told to file. */
export function senderAllowed(settings: DriveFilingSettings, from: string | null | undefined): boolean {
  const addr = addressOf(from);
  return !!addr && settings.senders.includes(addr);
}

export async function saveDriveFilingSettings(
  orgId: string,
  patch: { enabled?: boolean; senders?: string[] },
): Promise<DriveFilingSettings> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const current = await readDriveFilingSettings(orgId);

  const next: DriveFilingSettings = { ...current };
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.senders !== undefined) next.senders = normalizeSenders(patch.senders);

  const { error } = await supabaseAdmin.rpc('merge_org_settings', {
    p_org_id: orgId,
    p_patch: { [FIELD]: next },
  });
  if (error) throw new Error(error.message);
  return next;
}
