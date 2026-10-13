import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EXPORT_FORMATS, exportImage, saveBlob, type ExportFormat } from '../lib/imageExport';
import { Link } from 'react-router-dom';
import {
  assistantItemHref,
  type AssistantAnswer,
  type AssistantFile,
  type AssistantItem,
  type AssistantItemKind,
} from '@janelle/shared';
import { apiBlob } from '../lib/api';
import { Markdown } from './Markdown';

/**
 * How the assistant's answers are drawn.
 *
 * Three shapes, chosen from the rows themselves rather than asked of the
 * model: a list of files becomes files, a list of like records — every row
 * with the same labelled facts — becomes a table, and anything else stays
 * a list of rows. The model only says which records; how they line up is
 * decided here, where it can be right every time.
 */

/** What each row is, said once, so a list of eight reads as a list of kinds. */
const KIND_LABELS: Record<AssistantItemKind, string> = {
  task: 'Task',
  project: 'Project',
  purchase_order: 'PO',
  vendor: 'Vendor',
  email: 'Email',
  document: 'Document',
  draft: 'Draft',
  follow_up: 'Follow-up',
  person: 'Person',
  report: 'Report',
  file: 'File',
  link: 'Link',
  note: '',
};

const TONE_DOT: Record<string, string> = {
  neutral: 'bg-ink-faint',
  good: 'bg-good',
  warn: 'bg-warn',
  crit: 'bg-crit',
};

const Dot = ({ tone }: { tone?: string }) => (
  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone ?? 'neutral']}`} aria-hidden="true" />
);

/** A figure reads right-aligned in a column; a name does not. */
const numeric = (v: string) => /^[-$]?\d[\d,.]*\s*(%|[KMB]B?|d late)?$/i.test(v.trim());

/** Where a row goes, split into the router's links and the outside world's. */
function Target({
  item,
  className,
  children,
}: {
  item: AssistantItem;
  className: string;
  children: ReactNode;
}) {
  const href = assistantItemHref(item);
  if (!href) return <span className={className}>{children}</span>;
  if (/^https?:/i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={`${className} focusable`}>
        {children}
      </a>
    );
  }
  return (
    <Link to={href} className={`${className} focusable`}>
      {children}
    </Link>
  );
}

// ── Rows ────────────────────────────────────────────────────

/**
 * One record the answer is about.
 *
 * The whole row is the target, not a "view" link at the end: these are
 * read quickly, often on the way to doing something about them, and a
 * small link is a small target. A row with nowhere to go renders as the
 * same row without the affordance, so the list stays one shape.
 */
function ItemRow({ item }: { item: AssistantItem }) {
  if (item.kind === 'file') return <FileRow item={item} />;

  const href = assistantItemHref(item);
  const external = Boolean(href && /^https?:/i.test(href));
  const label = KIND_LABELS[item.kind];
  const facts = (item.fields ?? []).filter((f) => f.value !== '—');
  /** Longer than a date or a status, so it is prose and may be broken. */
  const LONG_FACT = 28;

  return (
    <Target
      item={item}
      className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left ${href ? 'transition-colors hover:bg-surface' : ''}`}
    >
      <span className="mt-[7px]">
        <Dot tone={item.tone} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          {label && <span className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</span>}
          <span className="text-[13.5px] font-medium text-ink">{item.title}</span>
        </span>
        {item.detail && <span className="mt-0.5 block text-[12.5px] text-ink-soft">{item.detail}</span>}
        {facts.length > 0 && (
          // A wrapping row, not inline text: JSX puts no whitespace between
          // the facts, so as inline spans there was nowhere to break and a
          // long row ran out of the bubble.
          <span className="mt-0.5 flex flex-wrap text-[12px] text-ink-soft">
            {facts.map((f, i) => {
              /**
               * A short fact holds together; a long one has to break.
               *
               * Keeping every fact on one line is right for "Due Sep 18" —
               * broken, it reads as "Due Sep / 18". But a next step is a
               * whole sentence, and an unbreakable sentence cannot wrap, so
               * it pushed the answer card wider than the panel holding it
               * and ran out past its own border. Length decides which it is.
               */
              const short = f.value.length <= LONG_FACT;
              return (
                <span key={f.label} className={short ? 'whitespace-nowrap' : 'min-w-0 break-words'}>
                  {i > 0 && <span className="px-1.5 text-ink-faint">·</span>}
                  <span className="whitespace-nowrap text-ink-faint">{f.label}</span> {f.value}
                </span>
              );
            })}
          </span>
        )}
        {/* The URL is shown as well as linked: a person often wants to send
            it to somebody rather than follow it. */}
        {external && item.url && (
          <span className="mt-0.5 block truncate text-[12px] text-brass-deep">{item.url}</span>
        )}
      </span>
      {item.meta && (
        <span className="shrink-0 whitespace-nowrap pt-0.5 text-[12px] tabular-nums text-ink-soft">{item.meta}</span>
      )}
    </Target>
  );
}

// ── Tables ──────────────────────────────────────────────────

/**
 * The labels every row shares, in order — or null when they do not.
 *
 * A table is only honest when each column means the same thing all the way
 * down. Rows that disagree on their labels are different kinds of thing,
 * and forcing them into columns would put a vendor's contact under a
 * project's install date.
 */
function sharedColumns(items: AssistantItem[]): string[] | null {
  if (items.length < 2) return null;
  const first = items[0].fields?.map((f) => f.label);
  if (!first?.length) return null;
  const key = first.join('|');
  return items.every((i) => i.kind === items[0].kind && i.fields?.map((f) => f.label).join('|') === key)
    ? first
    : null;
}

function RecordTable({
  items,
  columns,
  compact,
}: {
  items: AssistantItem[];
  columns: string[];
  /** A narrow container — the side panel — gets cards at every screen size. */
  compact: boolean;
}) {
  const hasMeta = items.some((i) => i.meta);
  const heading = KIND_LABELS[items[0].kind] || 'Name';

  return (
    <>
      {/* Wide enough: a real table, so a column of amounts can be read down. */}
      <div className={`mt-2.5 hidden overflow-x-auto rounded-lg border border-line bg-surface ${compact ? '' : 'sm:block'}`}>
        <table className="w-full border-collapse text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-line">
              <th className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">{heading}</th>
              {columns.map((c, ci) => {
                const right = items.every((i) => {
                  const v = i.fields?.[ci]?.value ?? '—';
                  return v === '—' || numeric(v);
                });
                return (
                  <th
                    key={c}
                    className={`whitespace-nowrap px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint ${right ? 'text-right' : ''}`}
                  >
                    {c}
                  </th>
                );
              })}
              {hasMeta && <th className="px-3 py-2" aria-label="Note" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((item, r) => (
              <tr key={r} className="transition-colors hover:bg-sunk">
                <td className="px-3 py-2">
                  <Target item={item} className="flex items-center gap-2 rounded font-medium text-ink hover:underline">
                    <Dot tone={item.tone} />
                    <span>{item.title}</span>
                  </Target>
                </td>
                {columns.map((c, ci) => {
                  const v = item.fields?.[ci]?.value ?? '—';
                  const right = items.every((i) => {
                    const x = i.fields?.[ci]?.value ?? '—';
                    return x === '—' || numeric(x);
                  });
                  return (
                    <td
                      key={c}
                      className={`whitespace-nowrap px-3 py-2 ${v === '—' ? 'text-ink-faint' : 'text-ink-soft'} ${right ? 'text-right tabular-nums' : ''}`}
                    >
                      {v}
                    </td>
                  );
                })}
                {hasMeta && (
                  <td className="whitespace-nowrap px-3 py-2 text-right text-[12px] text-ink-soft">{item.meta}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* A phone has no room for columns: each record becomes a small card
          with its facts labelled, which reads down a narrow screen. */}
      <div className={`mt-2.5 space-y-2 ${compact ? '' : 'sm:hidden'}`}>
        {items.map((item, r) => (
          <Target key={r} item={item} className="block rounded-lg border border-line bg-surface px-3 py-2.5">
            {/* The title wraps rather than truncating: on a phone it is the
                one line that has to be readable, and "Review updated Lemon
                Resid…" names no task anybody can act on. */}
            <span className="flex items-start gap-2">
              <span className="mt-[5px] shrink-0">
                <Dot tone={item.tone} />
              </span>
              <span className="min-w-0 flex-1 text-[13.5px] font-medium leading-snug text-ink">{item.title}</span>
              {item.meta && <span className="shrink-0 pt-px text-[12px] text-ink-soft">{item.meta}</span>}
            </span>
            {/* Label beside value, not above it, and one pair per line. Two
                columns split an already narrow screen in half and every
                value landed on an ellipsis — a project and an owner you
                cannot read are worth less than the room they took. */}
            <span className="mt-2 block space-y-1">
              {(item.fields ?? []).map((f) => (
                <span key={f.label} className="flex gap-2 text-[12px] leading-snug">
                  <span className="w-[4.25rem] shrink-0 text-ink-faint">{f.label}</span>
                  <span className="min-w-0 flex-1 text-ink-soft">{f.value}</span>
                </span>
              ))}
            </span>
          </Target>
        ))}
      </div>
    </>
  );
}

// ── Files ───────────────────────────────────────────────────

/**
 * Types a browser can show without running anything.
 *
 * A blob URL opens with this app's origin, so an HTML or SVG attachment
 * previewed that way would execute as the app itself — with the session in
 * reach. Anything not on this list is downloaded, never opened here.
 */
const PREVIEWABLE = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
]);

/**
 * Types that may be drawn INSIDE an <img>, which is a narrower thing than
 * the list above allows.
 *
 * The distinction is where the markup ends up. Opening an SVG in a tab makes
 * it a document on this origin and its scripts run with the session in
 * reach — so it stays off PREVIEWABLE, and Open still downloads it. Drawn in
 * an <img> it is a picture: no script runs, no network request of its own is
 * made. Rendered boards come back as SVG when the studio has no image
 * billing, and a board that shows as a broken icon is no board at all.
 */
const INLINE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

/** The badge colour for a kind of file, so a list of mixed files can be scanned. */
function badgeTone(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'bg-crit/10 text-crit';
  if (mimeType.startsWith('image/')) return 'bg-olive/10 text-olive';
  if (/sheet|excel|csv/.test(mimeType)) return 'bg-good/10 text-good';
  if (/word|document|presentation|powerpoint/.test(mimeType)) return 'bg-brass/10 text-brass-deep';
  return 'bg-sunk text-ink-soft';
}

const fileUrl = (file: AssistantFile) => `/assistant/file?token=${encodeURIComponent(file.token)}`;

/**
 * A file handed over by the assistant: what it is, and the two things a
 * person does with one.
 */
/**
 * What a person does with a file: open it, download it — or, when it cannot
 * come through here, go to where it lives. Shared by a file row and by a page
 * preview, so both behave alike.
 */
function FileActions({ item }: { item: AssistantItem }) {
  const [busy, setBusy] = useState<'open' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const file = item.file ?? null;
  const where = file?.source === 'drive' ? 'Drive' : 'Gmail';
  const elsewhere = file?.webUrl ?? item.url ?? null;
  const canPreview = Boolean(file?.downloadable && PREVIEWABLE.has(file.mimeType));

  async function open() {
    if (!file) return;
    // Opened before the fetch, or a popup blocker treats it as unrequested.
    const win = window.open('', '_blank');
    setBusy('open');
    setError(null);
    try {
      const blob = await apiBlob(fileUrl(file));
      // Re-typed from the allowlist, never from the response, so nothing the
      // sender chose decides how this browser treats the bytes.
      const url = URL.createObjectURL(new Blob([blob], { type: file.mimeType }));
      if (win) win.location.href = url;
      else window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      win?.close();
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    if (!file) return;
    setBusy('download');
    setError(null);
    try {
      const blob = await apiBlob(fileUrl(file));
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <span className="flex items-center gap-1.5">
        {file?.downloadable ? (
          <>
            {canPreview && (
              <button type="button" onClick={open} disabled={busy !== null} className="btn-secondary btn-sm">
                {busy === 'open' ? 'Opening…' : 'Open'}
              </button>
            )}
            <button type="button" onClick={download} disabled={busy !== null} className="btn-primary btn-sm">
              {busy === 'download' ? 'Downloading…' : 'Download'}
            </button>
          </>
        ) : (
          elsewhere && (
            // Too large to relay, or no grant could be made: the original is
            // still one click away, and saying why keeps it from looking broken.
            <a
              href={elsewhere}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary btn-sm"
              title={file ? 'Too large to download here' : undefined}
            >
              Open in {where}
            </a>
          )
        )}
      </span>
      {error && (
        <span className="max-w-[18rem] text-right text-[12px] text-crit">
          {error}
          {elsewhere && (
            <>
              {' '}
              <a href={elsewhere} target="_blank" rel="noopener noreferrer" className="underline">
                Open in {where}
              </a>
            </>
          )}
        </span>
      )}
    </span>
  );
}

function FileRow({ item }: { item: AssistantItem }) {
  const file = item.file ?? null;
  const type = item.fields?.find((f) => f.label === 'Type')?.value ?? 'File';
  const facts = (item.fields ?? []).filter((f) => f.label !== 'Type' && f.value !== '—').map((f) => f.value);

  return (
    <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-2.5 py-2">
      <span
        className={`grid h-9 w-11 shrink-0 place-items-center rounded-md text-[10.5px] font-semibold tracking-wide ${badgeTone(file?.mimeType ?? '')}`}
        aria-hidden="true"
      >
        {type.length > 6 ? type.slice(0, 5) : type}
      </span>

      <span className="min-w-0 flex-1 basis-40">
        <span className="block truncate text-[13.5px] font-medium text-ink" title={item.title}>
          {item.title}
        </span>
        <span className="block truncate text-[12px] text-ink-soft">
          {[type, ...facts].join(' · ')}
          {item.detail ? ` — ${item.detail}` : ''}
        </span>
      </span>

      <FileActions item={item} />
    </div>
  );
}

/** "2.1 MB", "340 KB". */
export function sizeLabel(bytes: number): string {
  if (!bytes) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Files a person attached to a question, shown with it, and openable from it later. */
export function AttachedFiles({ files }: { files: { name: string; mimeType: string; size: number; token: string }[] }) {
  return (
    <div className="mt-2 space-y-1.5">
      {files.map((f) => (
        <div key={f.token} className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-2 py-1.5 text-left">
          <span
            className={`grid h-8 w-10 shrink-0 place-items-center rounded-md text-[10px] font-semibold tracking-wide ${badgeTone(f.mimeType)}`}
            aria-hidden="true"
          >
            {f.mimeType === 'application/pdf' ? 'PDF' : 'IMAGE'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-ink" title={f.name}>{f.name}</span>
            <span className="block text-[11.5px] text-ink-faint">{sizeLabel(f.size)}</span>
          </span>
          <FileActions
            item={{
              kind: 'file',
              title: f.name,
              file: { name: f.name, mimeType: f.mimeType, size: f.size, source: 'upload', token: f.token, downloadable: true, webUrl: null },
            }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Download a picture Jenny drew as PNG, JPG, JPEG, PDF or SVG.
 *
 * The file is fetched once (already cached from showing it) and converted in
 * the browser, so choosing a format costs nothing on the server.
 */
function ImageDownloadMenu({ file, name }: { file: AssistantFile; name: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  async function pick(format: ExportFormat) {
    setBusy(format);
    setError(null);
    try {
      const source = await fetchPreviewFile(file);
      const { blob, filename } = await exportImage(source, file.mimeType, format, name);
      saveBlob(blob, filename);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <span ref={box} className="relative flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-primary btn-sm"
      >
        Download ▾
      </button>
      {open && (
        <span
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-56 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface py-1 text-left shadow-pop"
        >
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="menuitem"
              disabled={busy !== null}
              onClick={() => pick(f.id)}
              className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-sunk disabled:opacity-60"
            >
              <span className="text-[13px] font-medium text-ink">{busy === f.id ? `Preparing ${f.label}…` : f.label}</span>
              <span className="text-[11.5px] text-ink-faint">{f.note}</span>
            </button>
          ))}
        </span>
      )}
      {error && <span className="max-w-[16rem] text-right text-[12px] text-crit">{error}</span>}
    </span>
  );
}

// ── Pages and pictures ──────────────────────────────────────

interface RenderedImage {
  url: string;
  label: string;
}

/**
 * Files already fetched for a preview, by grant — the last few only.
 *
 * A preview mounts again whenever the conversation moves between the side
 * panel and the full page, and React mounts it twice in development; each
 * mount used to download the whole PDF again. The promise is kept, not the
 * result, so two mounts at the same moment share one request.
 */
const previewFiles = new Map<string, Promise<Blob>>();
const PREVIEW_CACHE = 6;

function fetchPreviewFile(file: AssistantFile): Promise<Blob> {
  const hit = previewFiles.get(file.token);
  if (hit) return hit;
  const request = apiBlob(fileUrl(file)).catch((err: unknown) => {
    // A failure is not worth remembering: the next attempt should try again.
    previewFiles.delete(file.token);
    throw err;
  });
  previewFiles.set(file.token, request);
  while (previewFiles.size > PREVIEW_CACHE) previewFiles.delete(previewFiles.keys().next().value as string);
  return request;
}

/**
 * The pages an answer came from, drawn as pictures.
 *
 * Asked for "the living room furniture and decor from this PDF", Jenny finds
 * the pages that show it and this draws them — the boards themselves, not a
 * description of them. The server sends only those pages as a small PDF, and
 * pdf.js turns each into an image here, in the browser: rendering a PDF on
 * the server would need native graphics libraries a serverless host does not
 * have. pdf.js is loaded only when the first preview appears, so the rest of
 * the app does not carry it.
 */
function PagePreview({ item, compact }: { item: AssistantItem; compact: boolean }) {
  const file = item.file ?? null;
  const [images, setImages] = useState<RenderedImage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    const urls: string[] = [];
    setImages(null);
    setError(null);

    (async () => {
      const blob = await fetchPreviewFile(file);

      if (item.preview === 'image') {
        // Mislabelling the blob is what broke this: an SVG handed to the
        // browser as image/png decodes as nothing at all.
        const type = INLINE_IMAGE_TYPES.has(file.mimeType) ? file.mimeType : 'image/png';
        const url = URL.createObjectURL(new Blob([blob], { type }));
        urls.push(url);
        if (!cancelled) setImages([{ url, label: item.title }]);
        return;
      }

      const pdfjs = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
      const rendered: RenderedImage[] = [];
      try {
        for (let i = 1; i <= Math.min(doc.numPages, 6) && !cancelled; i++) {
          const page = await doc.getPage(i);
          const natural = page.getViewport({ scale: 1 });
          // Sharp enough to read a spec sheet, bounded so a huge board does
          // not become a hundred-megapixel canvas.
          const viewport = page.getViewport({ scale: Math.min(2, 1600 / natural.width) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('This browser cannot draw the page.');
          await page.render({ canvasContext: context, viewport }).promise;
          const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
          if (!png) continue;
          const url = URL.createObjectURL(png);
          urls.push(url);
          rendered.push({ url, label: `Page ${item.pages?.[i - 1] ?? i}` });
        }
      } finally {
        void doc.destroy();
      }
      if (!cancelled) setImages(rendered);
    })().catch((e: Error) => {
      if (!cancelled) setError(e.message || 'The pages could not be shown.');
    });

    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [file?.token, item.preview]);

  if (!file) return null;
  const where = file.source === 'drive' ? 'Drive' : 'Gmail';
  const stem = file.name.replace(/\.[a-z0-9]{2,5}$/i, '');

  return (
    <div className="px-3 py-3">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[13.5px] font-medium text-ink" title={item.title}>
          {item.title}
        </span>
        {item.preview === 'image' ? <ImageDownloadMenu file={file} name={stem} /> : <FileActions item={item} />}
      </div>

      {error ? (
        <p className="text-[12.5px] text-crit">
          {error}
          {file.webUrl && (
            <>
              {' '}
              <a href={file.webUrl} target="_blank" rel="noopener noreferrer" className="underline">
                Open in {where}
              </a>
            </>
          )}
        </p>
      ) : !images ? (
        <div className={`grid gap-2.5 ${compact ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {(item.pages?.length ? item.pages : [1]).slice(0, compact ? 1 : 2).map((p) => (
            <div key={p} className="flex aspect-[4/3] items-center justify-center rounded-lg bg-sunk text-[12px] text-ink-faint">
              Opening the {item.preview === 'image' ? 'image' : 'pages'}…
            </div>
          ))}
        </div>
      ) : (
        <div className={`grid gap-2.5 ${compact || images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {images.map((img) => (
            <figure key={img.url} className="overflow-hidden rounded-lg border border-line bg-white">
              <a href={img.url} target="_blank" rel="noopener noreferrer" title="Open full size" className="focusable block">
                <img src={img.url} alt={`${stem} — ${img.label}`} className="block h-auto w-full" loading="lazy" />
              </a>
              <figcaption className="flex items-center justify-between gap-2 border-t border-line bg-surface px-2.5 py-1.5 text-[11.5px] text-ink-soft">
                <span>{img.label}</span>
                {item.preview !== 'image' && (
                  <a href={img.url} download={`${stem} - ${img.label}.png`} className="focusable rounded px-1 font-medium text-brass-deep hover:underline">
                    Save image
                  </a>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A clip Jenny made, played where it was asked for.
 *
 * Not fetched as a blob the way a picture or a PDF is: an mp4 is past what
 * the API will relay back through a serverless response, so the server
 * signs a short-lived URL straight off storage and this plays from that.
 *
 * Muted, with controls, and never autoplaying. Jenny reads her answers
 * aloud, and a clip that starts talking over her is both rude and a
 * problem — the browser's echo filter would hear the soundtrack as the
 * next question.
 */
function ClipPreview({ item }: { item: AssistantItem }) {
  const file = item.file ?? null;
  const src = file?.streamUrl ?? null;

  return (
    <div className="px-3 py-3">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[13.5px] font-medium text-ink" title={item.title}>
          {item.title}
        </span>
        {item.detail && <span className="text-[12px] text-ink-faint">{item.detail}</span>}
      </div>

      {src ? (
        <video
          src={src}
          controls
          muted
          playsInline
          preload="metadata"
          className="block w-full rounded-lg border border-line bg-black"
        />
      ) : (
        <p className="rounded-lg bg-sunk px-3 py-6 text-center text-[12.5px] text-ink-faint">
          This clip's link has expired — ask again and a fresh one is made.
        </p>
      )}
    </div>
  );
}

// ── The answer ──────────────────────────────────────────────

/** An answer that is nothing but pictures Jenny drew — shown thumbnail-sized, so its bubble is too. */
export function answerIsPictures(answer: AssistantAnswer | undefined): boolean {
  return Boolean(answer?.items.length) && answer!.items.every((i) => i.kind === 'file' && i.preview === 'image');
}

/** Whether this answer wants the room a table needs. */
export function answerIsWide(answer: AssistantAnswer | undefined): boolean {
  if (!answer?.items.length) return false;
  if (answerIsPictures(answer)) return false;
  return Boolean(sharedColumns(answer.items.filter((i) => i.kind !== 'file'))) || answer.items.some((i) => i.kind === 'file');
}

/**
 * An answer: the sentence, then the rows behind it.
 *
 * Kept deliberately quiet — one dot of colour per row and nothing else —
 * because this sits inside a chat bubble and an answer that shouts is
 * harder to read than one that does not.
 */
/**
 * Work the assistant produced, rather than a fact it looked up.
 *
 * Set apart from the prose and given its own copy button: a moodboard or a
 * finish schedule is something the designer takes somewhere else — into a
 * presentation, a spec book, an email — and the thing they will want first
 * is all of it, unedited, on the clipboard.
 */
function AnswerDocument({ title, body }: { title?: string | null; body: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked */
    }
  };

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-line-soft bg-sunk/40 px-3.5 py-2">
        <span className="min-w-0 truncate text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
          {title || 'Draft work'}
        </span>
        <button onClick={copy} className="btn-secondary btn-sm shrink-0">{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <Markdown text={body} className="max-h-[32rem] overflow-y-auto px-4 py-3 text-[13.5px] leading-relaxed text-ink-soft" />
    </div>
  );
}

// ── Briefing tiles ──────────────────────────────────────────

const STATUS_STYLE: Record<string, string> = {
  'in progress': 'bg-brass/15 text-brass-deep',
  open: 'bg-sky-500/10 text-sky-400',
  completed: 'bg-good/15 text-good',
  overdue: 'bg-crit/15 text-crit',
};

function statusStyle(s: string): string {
  return STATUS_STYLE[s.toLowerCase()] ?? 'bg-sunk text-ink-soft';
}

function BriefingTile({ item }: { item: AssistantItem }) {
  const label = KIND_LABELS[item.kind];
  const fields = (item.fields ?? []).filter((f) => f.value !== '—');

  const inner = (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        {label && (
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">{label}</span>
        )}
        {item.meta && (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${statusStyle(item.meta)}`}>
            {item.meta}
          </span>
        )}
      </div>
      <p className="flex-1 text-[13.5px] font-semibold leading-snug text-ink">{item.title}</p>
      {item.detail && (
        <p className="text-[12px] leading-snug text-ink-soft">{item.detail}</p>
      )}
      {fields.length > 0 && (
        <div className="mt-auto border-t border-line pt-2">
          {fields.map((f) => (
            <div key={f.label} className="flex gap-1 text-[11.5px]">
              <span className="shrink-0 text-ink-faint">{f.label}</span>
              <span className="min-w-0 truncate text-ink-soft">{f.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const href = assistantItemHref(item);
  const cls = `block rounded-xl border border-line bg-surface p-3.5 transition-colors ${href ? 'hover:border-brass/40 hover:bg-brass/5' : ''}`;
  return <Target item={item} className={cls}>{inner}</Target>;
}

export function BriefingAnswerView({ answer, wide = false }: { answer: AssistantAnswer; wide?: boolean }) {
  const followUps = answer.items.filter((i) => i.kind === 'follow_up');
  const tasks = answer.items.filter((i) => i.kind === 'task');
  const rest = answer.items.filter((i) => i.kind !== 'follow_up' && i.kind !== 'task');
  // On the full page the briefing has the width of the screen: three tiles
  // across, so a morning's work is seen in one look instead of a scroll.
  const cols = wide ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2';

  return (
    <div className="space-y-4">
      <p className="text-[14px] leading-relaxed text-ink">{answer.lead}</p>

      {followUps.length > 0 && (
        <div className={`grid gap-2.5 ${followUps.length === 1 ? 'grid-cols-1' : cols}`}>
          {followUps.map((item, i) => <BriefingTile key={i} item={item} />)}
        </div>
      )}

      {tasks.length > 0 && (
        <div className={`grid gap-2.5 ${cols}`}>
          {tasks.map((item, i) => <BriefingTile key={i} item={item} />)}
        </div>
      )}

      {rest.length > 0 && (
        <div className={`grid gap-2.5 ${cols}`}>
          {rest.map((item, i) => <BriefingTile key={i} item={item} />)}
        </div>
      )}

      {answer.caveat && (
        <p className="border-l-2 border-warn/50 pl-2.5 text-[12.5px] text-ink-soft">{answer.caveat}</p>
      )}
    </div>
  );
}

export function AssistantAnswerView({
  answer,
  compact = false,
}: {
  answer: AssistantAnswer;
  /**
   * Lay out for a narrow container rather than for the screen. Media queries
   * see the window, not the panel: at desktop width a five-column table in a
   * 440px panel would scroll sideways.
   */
  compact?: boolean;
}) {
  const files = answer.items.filter((i) => i.kind === 'file');
  const records = answer.items.filter((i) => i.kind !== 'file');
  const columns = sharedColumns(records);

  return (
    <>
      <p className="whitespace-pre-line text-[14px] leading-relaxed text-ink">{answer.lead}</p>

      {answer.document && <AnswerDocument title={answer.documentTitle} body={answer.document} />}

      {records.length > 0 &&
        (columns ? (
          <RecordTable items={records} columns={columns} compact={compact} />
        ) : (
          <div className="-mx-1 mt-2.5 divide-y divide-line border-y border-line">
            {records.map((item, i) => (
              <ItemRow key={i} item={item} />
            ))}
          </div>
        ))}

      {files.length > 0 && (
        // A picture Jenny drew is shown thumbnail-sized, not stretched across the
        // whole chat: at full width a 3:2 sheet was taller than the window.
        // Clicking it opens it at full size.
        <div
          className={`mt-2.5 divide-y divide-line rounded-lg border border-line bg-surface ${
            files.every((f) => f.preview === 'image') ? 'max-w-[34rem]' : ''
          }`}
        >
          {files.map((item, i) =>
            item.preview === 'video' ? (
              <ClipPreview key={i} item={item} />
            ) : item.preview ? (
              <PagePreview key={i} item={item} compact={compact} />
            ) : (
              <FileRow key={i} item={item} />
            ),
          )}
        </div>
      )}

      {answer.more > 0 && (
        <p className="mt-2 text-[12.5px] text-ink-faint">
          …and {answer.more} more{answer.items.length > 0 ? ' not shown' : ''}.
        </p>
      )}

      {answer.caveat && (
        <p className="mt-2 border-l-2 border-warn/50 pl-2.5 text-[12.5px] text-ink-soft">{answer.caveat}</p>
      )}

      {answer.sources.length > 0 && (
        <p className="mt-2.5 text-[11.5px] text-ink-faint">Checked {answer.sources.join(', ')}.</p>
      )}
    </>
  );
}
