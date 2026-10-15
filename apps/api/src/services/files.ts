import type { PDFDocument } from 'pdf-lib';

/**
 * pdf-lib, loaded on first use. It costs over half a second of CPU to load,
 * and on Vercel every cold start would pay that — including the scheduled
 * calls that never touch a PDF.
 */
const pdfLib = () => import('pdf-lib');
import type { FileGrant } from '../lib/fileTokens.js';
import { isGoogleAuthFailure, orgSourceUserId } from '../lib/tokens.js';
import { downloadAttachment, gmailForReply, gmailMessageUrl } from './gmail.js';
import { downloadShape, driveFileBytes, driveFor } from './drive.js';
import { readUpload } from '../lib/uploads.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { hasEmailOwner } from '../lib/columns.js';

/**
 * The bytes behind a file grant, for whoever needs them — the download
 * endpoint handing a file to the browser, or Jenny reading one to answer a
 * question about it. One place fetches, so both see the same file.
 */

/** A failure the person should see in words, with the status a route would send. */
export class FileFetchError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface FetchedFile {
  bytes: Buffer;
  name: string;
  mimeType: string;
  /** The file where it lives — the Gmail message or the Drive file. */
  webUrl: string | null;
}

/**
 * The HTTP status behind a Google (Gaxios) error, however the SDK carried it.
 *
 * Googleapis does not reliably put the numeric status on `.code` — that is
 * often a string like `ERR_BAD_REQUEST`, while the real status sits on
 * `.status` or `.response.status`. Reading only `.code` (as this used to) made
 * `Number(code)` NaN, so a plain 404/400 fell straight through to a generic
 * 500 "Server error" instead of the message meant for it.
 */
function googleErrorStatus(err: unknown): number | null {
  const e = err as { status?: number; code?: number | string; response?: { status?: number } };
  const raw = e?.status ?? e?.response?.status ?? e?.code;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Which mailbox actually holds a Gmail message, by its own Gmail id — so its
 * attachment is fetched with THAT mailbox's token, not whichever account
 * happens to be the org's "source". A quote parsed from systems@ carries a
 * per-mailbox message id that only systems@'s token can resolve; fetching it
 * as a different principal 404s. Null when the owner cannot be read (no column
 * yet, mail from before it was tracked, or shared studio mail) — the caller
 * then falls back to the studio's shared connection, as before.
 */
async function mailboxOwnerFor(orgId: string, gmailId: string): Promise<string | null> {
  if (!supabaseAdmin || !(await hasEmailOwner())) return null;
  try {
    const { data } = await supabaseAdmin
      .from('emails')
      .select('owner_id')
      .eq('org_id', orgId)
      .eq('gmail_id', gmailId)
      .maybeSingle();
    return (data as { owner_id: string | null } | null)?.owner_id ?? null;
  } catch {
    return null;
  }
}

export async function fetchGrantedFile(grant: FileGrant): Promise<FetchedFile> {
  // Someone's own upload needs no Google account at all.
  if (grant.source === 'upload') {
    const bytes = await readUpload(grant.path);
    if (!bytes) throw new FileFetchError('That file is no longer stored — attach it again.', 404);
    return { bytes, name: grant.name, mimeType: grant.mimeType, webUrl: null };
  }

  const userId = await orgSourceUserId(grant.orgId);
  if (!userId) throw new FileFetchError('No Google account is connected for the studio.', 409);

  try {
    if (grant.source === 'gmail') {
      // The mailbox the message actually lives in, so its per-mailbox id
      // resolves; the studio's shared connection only when the owner is
      // unknown. Without this the fetch ran as the org "source" account and
      // 404'd on anything in another mailbox (e.g. systems@).
      const ownerId = await mailboxOwnerFor(grant.orgId, grant.messageId);
      const gmail = await gmailForReply(grant.orgId, ownerId);
      if (!gmail) throw new FileFetchError('Gmail is not connected for the studio.', 409);
      const bytes = await downloadAttachment(gmail, grant.messageId, grant.attachmentId);
      return { bytes, name: grant.name, mimeType: grant.mimeType, webUrl: gmailMessageUrl(grant.messageId) };
    }
    const drive = await driveFor(userId);
    if (!drive) throw new FileFetchError('Google Drive is not connected for the studio.', 409);
    const bytes = await driveFileBytes(drive, grant.fileId, grant.mimeType);
    const shape = downloadShape(grant.name, grant.mimeType);
    return {
      bytes,
      name: shape.name,
      mimeType: shape.mimeType,
      webUrl: `https://drive.google.com/file/d/${grant.fileId}/view`,
    };
  } catch (err) {
    if (err instanceof FileFetchError) throw err;
    if (isGoogleAuthFailure(err)) throw new FileFetchError('Google needs reconnecting in Settings → Integrations.', 409);
    const status = googleErrorStatus(err);
    // 404: the message or attachment is gone from the mailbox. 400: Gmail
    // rejected the attachment id — these rotate when a message is re-indexed,
    // so a link minted earlier can go stale. Either way the original is still
    // reachable in Gmail, which the card offers as the fallback.
    if (status === 404) throw new FileFetchError('That file is no longer in Google — open it in Gmail instead.', 404);
    if (status === 400) throw new FileFetchError('This attachment link has expired — open it in Gmail to see the file.', 410);
    if (status === 403) throw new FileFetchError('The studio account cannot reach that file — reconnect Google in Settings → Integrations.', 403);
    throw err;
  }
}

const isPdf = (mimeType: string, name: string) => mimeType === 'application/pdf' || /\.pdf$/i.test(name);

/** How many pages a PDF has, or null when it cannot be opened. */
export async function pdfPageCount(bytes: Buffer): Promise<number | null> {
  try {
    const { PDFDocument } = await pdfLib();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    return null;
  }
}

/**
 * A new PDF holding only these pages (1-based), in the order given.
 *
 * Page numbers outside the document are ignored rather than refused: they
 * come from a model's reading of it, and one wrong number should not cost
 * the pages that were right.
 */
export async function pdfSubset(bytes: Buffer, pages: number[]): Promise<Buffer> {
  const cutter = await pdfCutter(bytes);
  if (!cutter) throw new FileFetchError('That PDF could not be opened.', 422);
  return cutter.cut(pages);
}

export interface PdfCutter {
  pageCount: number;
  /** A new PDF of these pages (1-based), in the order given. */
  cut: (pages: number[]) => Promise<Buffer>;
}

/**
 * One PDF, opened once and cut as many times as needed.
 *
 * Reading a 45MB plan set in parts cuts it five or six times; loading the
 * source for each cut parsed the whole file again every time. Null when the
 * file cannot be opened at all.
 */
export async function pdfCutter(bytes: Buffer): Promise<PdfCutter | null> {
  const { PDFDocument } = await pdfLib();
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return null;
  }
  const count = source.getPageCount();
  return {
    pageCount: count,
    cut: async (pages) => {
      const wanted = [...new Set(pages)].filter((p) => Number.isInteger(p) && p >= 1 && p <= count);
      if (!wanted.length) throw new FileFetchError('None of those pages are in the document.', 404);
      const out = await PDFDocument.create();
      const copied = await out.copyPages(source, wanted.map((p) => p - 1));
      copied.forEach((page) => out.addPage(page));
      return Buffer.from(await out.save());
    },
  };
}

/**
 * The most pages, in the order given, whose cut stays within `maxBytes` —
 * always at least the first. The order is relevance, so what is dropped is
 * what mattered least.
 */
export async function fitPages(cutter: PdfCutter, pages: number[], maxBytes: number): Promise<{ pages: number[]; bytes: Buffer }> {
  let take = pages.slice();
  let bytes = await cutter.cut(take);
  while (bytes.byteLength > maxBytes && take.length > 1) {
    take = take.slice(0, -1);
    bytes = await cutter.cut(take);
  }
  return { pages: take, bytes };
}

/**
 * The file a grant stands for — cut down to its pages when it names some.
 *
 * `maxBytes` is what the caller can hand on. Pages of a plan set are
 * pictures, three or four MB each, and six of them were over what the host
 * will return: the preview failed with "too large" when the first page
 * alone was the answer. Past the limit the least relevant pages go first.
 */
export async function fetchGrantedContent(grant: FileGrant, opts: { maxBytes?: number } = {}): Promise<FetchedFile> {
  const file = await fetchGrantedFile(grant);
  if (!grant.pages?.length || !isPdf(file.mimeType, file.name)) return file;
  const cutter = await pdfCutter(file.bytes);
  if (!cutter) throw new FileFetchError('That PDF could not be opened.', 422);
  const { pages, bytes } = opts.maxBytes
    ? await fitPages(cutter, grant.pages, opts.maxBytes)
    : { pages: grant.pages, bytes: await cutter.cut(grant.pages) };
  const stem = file.name.replace(/\.pdf$/i, '');
  const label = pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(', ')}`;
  return {
    ...file,
    bytes,
    name: `${stem} (${label}).pdf`,
    mimeType: 'application/pdf',
  };
}
