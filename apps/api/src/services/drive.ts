import { Readable } from 'node:stream';
import { drive as driveApi, type drive_v3 } from '@googleapis/drive';
import { googleClientForUser } from '../lib/tokens.js';
import { isWorkbook, workbookText } from '../lib/xlsx.js';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  /** Bytes, as Drive reports them; 0 when the file did not say. */
  size: number;
}

/** Drive client acting as the given user, or null if not connected. */
export async function driveFor(userId: string): Promise<drive_v3.Drive | null> {
  const auth = await googleClientForUser(userId, 'drive');
  if (!auth) return null;
  return driveApi({ version: 'v3', auth });
}

/**
 * List PDF files, optionally within a folder, most-recently-modified
 * first. Used to find new quotes and order confirmations.
 */
export async function listPdfs(
  drive: drive_v3.Drive,
  opts: { folderId?: string; max?: number } = {},
): Promise<DriveFile[]> {
  const clauses = ["mimeType = 'application/pdf'", 'trashed = false'];
  if (opts.folderId) clauses.push(`'${opts.folderId}' in parents`);
  const res = await drive.files.list({
    q: clauses.join(' and '),
    orderBy: 'modifiedTime desc',
    pageSize: opts.max ?? 25,
    fields: 'files(id,name,mimeType,modifiedTime,size)',
    // Include shared drives, where studios usually keep quote PDFs.
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });
  return (res.data.files ?? []).map((f) => ({
    id: f.id!,
    name: f.name ?? 'untitled.pdf',
    mimeType: f.mimeType ?? 'application/pdf',
    modifiedTime: f.modifiedTime ?? '',
    // Drive sends this as a string; 0 for anything that did not report one.
    size: Number(f.size ?? 0) || 0,
  }));
}

/** Download a Drive file's raw bytes. */
export async function downloadFile(drive: drive_v3.Drive, fileId: string): Promise<Buffer> {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

// ── Live reading, for the assistant ─────────────────────────

/** A Drive file as the assistant sees it: enough to find it and hand it over. */
export interface DriveHit extends DriveFile {
  webViewLink: string | null;
}

/** The kinds of file a person asks for by kind — "the spreadsheet", "the photos". */
export type DriveKind = 'pdf' | 'image' | 'document' | 'spreadsheet' | 'presentation' | 'folder';

const KIND_CLAUSE: Record<DriveKind, string> = {
  pdf: "mimeType = 'application/pdf'",
  image: "mimeType contains 'image/'",
  document:
    "(mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType = 'application/msword')",
  spreadsheet:
    "(mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' or mimeType = 'application/vnd.ms-excel' or mimeType = 'text/csv')",
  presentation:
    "(mimeType = 'application/vnd.google-apps.presentation' or mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation')",
  folder: "mimeType = 'application/vnd.google-apps.folder'",
};

/**
 * A value inside a Drive query string.
 *
 * Drive's `q` is a small language of its own, quoted with single quotes, so
 * a project called "O'Neill Residence" would otherwise end the string early
 * and turn the rest of the name into query syntax.
 */
const quoted = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const DRIVE_FIELDS = 'files(id,name,mimeType,modifiedTime,size,webViewLink)';

function toHit(f: drive_v3.Schema$File): DriveHit {
  return {
    id: f.id!,
    name: f.name ?? 'untitled',
    mimeType: f.mimeType ?? 'application/octet-stream',
    modifiedTime: f.modifiedTime ?? '',
    size: Number(f.size ?? 0) || 0,
    webViewLink: f.webViewLink ?? null,
  };
}

/** The id of the folder whose name best matches, or null. */
export async function findFolderId(drive: drive_v3.Drive, name: string): Promise<string | null> {
  const res = await drive.files.list({
    q: `${KIND_CLAUSE.folder} and trashed = false and name contains ${quoted(name)}`,
    pageSize: 1,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });
  return res.data.files?.[0]?.id ?? null;
}

/**
 * Search Drive by name and by what the files contain.
 *
 * `fullText` is what finds "the Harborview finish schedule" when the file is
 * called FS_v3_final.xlsx. Drive refuses to sort a full-text search, so
 * those come back in its own relevance order; a search with no words is
 * simply the most recently changed files.
 */
export async function searchDriveFiles(
  drive: drive_v3.Drive,
  opts: { search?: string; kind?: DriveKind; folderId?: string; max?: number } = {},
): Promise<DriveHit[]> {
  const clauses = ['trashed = false'];
  const words = (opts.search ?? '').trim();
  if (words) clauses.push(`(name contains ${quoted(words)} or fullText contains ${quoted(words)})`);
  if (opts.kind) clauses.push(KIND_CLAUSE[opts.kind]);
  if (opts.folderId) clauses.push(`${quoted(opts.folderId)} in parents`);

  const res = await drive.files.list({
    q: clauses.join(' and '),
    ...(words ? {} : { orderBy: 'modifiedTime desc' }),
    pageSize: Math.min(Math.max(opts.max ?? 10, 1), 25),
    fields: DRIVE_FIELDS,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });
  return (res.data.files ?? []).map(toHit);
}

/** One file's metadata. */
export async function getDriveFile(drive: drive_v3.Drive, fileId: string): Promise<DriveHit> {
  const res = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType,modifiedTime,size,webViewLink',
    supportsAllDrives: true,
  });
  return toHit(res.data);
}

/**
 * What a Google-native file becomes when it leaves Drive.
 *
 * Docs, Sheets and Slides have no bytes of their own — `alt=media` refuses
 * them — so they are exported, into the format a person would expect to
 * open: a PDF for writing and slides, a workbook for a spreadsheet.
 */
const EXPORTS: Record<string, { mimeType: string; ext: string }> = {
  'application/vnd.google-apps.document': { mimeType: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.presentation': { mimeType: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.drawing': { mimeType: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
  },
};

/** The type and filename a file will have once downloaded, before fetching it. */
export function downloadShape(name: string, mimeType: string): { name: string; mimeType: string; exported: boolean } {
  const exp = EXPORTS[mimeType];
  if (!exp) return { name, mimeType, exported: false };
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, '');
  return { name: `${stem}.${exp.ext}`, mimeType: exp.mimeType, exported: true };
}

/** A file's bytes, exporting Google-native formats on the way out. */
export async function driveFileBytes(
  drive: drive_v3.Drive,
  fileId: string,
  mimeType: string,
): Promise<Buffer> {
  const exp = EXPORTS[mimeType];
  if (!exp) return downloadFile(drive, fileId);
  const res = await drive.files.export({ fileId, mimeType: exp.mimeType }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data as ArrayBuffer);
}

// ── Writing, for the document organiser ─────────────────────
//
// Everything below runs on the `drive.file` grant, which can see and touch
// ONLY the files and folders this app itself created. That is why the organiser
// builds its own tree from a named root: it can always find the folders it made
// before (so filing is idempotent), and it can never reach — let alone change —
// anything the studio keeps elsewhere in Drive.

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** An app-created folder with this exact name under `parentId` (root when null), or null. */
async function childFolder(drive: drive_v3.Drive, name: string, parentId: string | null): Promise<string | null> {
  const where = parentId ? `${quoted(parentId)} in parents` : `'root' in parents`;
  const res = await drive.files.list({
    q: `mimeType = '${FOLDER_MIME}' and trashed = false and name = ${quoted(name)} and ${where}`,
    pageSize: 1,
    fields: 'files(id)',
    spaces: 'drive',
  });
  return res.data.files?.[0]?.id ?? null;
}

async function createFolder(drive: drive_v3.Drive, name: string, parentId: string | null): Promise<string> {
  const res = await drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) },
    fields: 'id',
  });
  return res.data.id!;
}

/**
 * Ensure a folder path exists, creating any missing segment, and return the
 * leaf folder's id. `['Filed', 'Purchasing', 'Oak FF&E']` walks or builds each
 * level in turn. Idempotent: a path filed into yesterday is found, not remade.
 */
export async function ensureFolderPath(drive: drive_v3.Drive, segments: string[]): Promise<string> {
  let parent: string | null = null;
  for (const name of segments) {
    parent = (await childFolder(drive, name, parent)) ?? (await createFolder(drive, name, parent));
  }
  if (!parent) throw new Error('ensureFolderPath needs at least one segment');
  return parent;
}

export interface FiledFile {
  id: string;
  webViewLink: string | null;
}

/**
 * An app-created file already tagged with this source reference, or null.
 *
 * Every filed attachment carries its `gmail:<msg>:<att>` origin in
 * `appProperties`, so a re-run finds what it filed before and uploads nothing
 * twice — the dedupe key that makes the whole pass safe to repeat.
 */
export async function findFiledByRef(drive: drive_v3.Drive, ref: string): Promise<FiledFile | null> {
  const res = await drive.files.list({
    q: `trashed = false and appProperties has { key='sourceRef' and value=${quoted(ref)} }`,
    pageSize: 1,
    fields: 'files(id,webViewLink)',
    spaces: 'drive',
  });
  const f = res.data.files?.[0];
  return f ? { id: f.id!, webViewLink: f.webViewLink ?? null } : null;
}

/** Upload a PDF into a folder, tagged with its origin ref for idempotent re-runs. */
export async function uploadPdf(
  drive: drive_v3.Drive,
  opts: { folderId: string; name: string; bytes: Buffer; sourceRef: string },
): Promise<FiledFile> {
  const res = await drive.files.create({
    requestBody: {
      name: opts.name,
      parents: [opts.folderId],
      mimeType: 'application/pdf',
      appProperties: { sourceRef: opts.sourceRef },
    },
    media: { mimeType: 'application/pdf', body: Readable.from(opts.bytes) },
    fields: 'id,webViewLink',
  });
  return { id: res.data.id!, webViewLink: res.data.webViewLink ?? null };
}

/** Formats whose text can be read directly, and how to get at it. */
const TEXT_EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};
const PLAIN_TYPES = /^(text\/|application\/(json|xml|csv))/;

/**
 * The readable text of a file, or null when it has none to give.
 *
 * Only what can be read exactly: a Doc, a Sheet (its first tab, as CSV), a
 * text file. A PDF or an image would need a model to read it, which is a
 * cost and a guess — for those the honest answer is to hand the file over.
 */
export async function readDriveText(
  drive: drive_v3.Drive,
  file: { id: string; mimeType: string; name?: string },
  maxChars = 6000,
): Promise<string | null> {
  const name = file.name ?? '';
  const exportAs = TEXT_EXPORTS[file.mimeType];
  let bytes: Buffer;
  if (exportAs) {
    const res = await drive.files.export({ fileId: file.id, mimeType: exportAs }, { responseType: 'arraybuffer' });
    bytes = Buffer.from(res.data as ArrayBuffer);
  } else if (isWorkbook(file.mimeType, name)) {
    // An uploaded .xlsx is not a Google Sheet, so `files.export` refuses
    // it — which is why the studio's own schedules, the ones people
    // actually send as attachments, were the files Jenny could never read.
    // Downloaded and parsed instead.
    return workbookText(await downloadFile(drive, file.id), maxChars);
  } else if (PLAIN_TYPES.test(file.mimeType)) {
    bytes = await downloadFile(drive, file.id);
  } else {
    return null;
  }
  return bytes.toString('utf8').slice(0, maxChars);
}
