import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconCalendar, IconChevronLeft, IconChevronRight } from './icons';

/**
 * One date, picked from a calendar drawn in the app's own colours.
 *
 * Replaces `<input type="date">`, whose popup is the operating system's: a
 * grey box with up/down arrows over a dark screen, that looked like another
 * product. Values stay `YYYY-MM-DD` strings, exactly what the date input
 * gave, so callers only swap the element.
 *
 * The calendar is portalled to <body> and placed against the trigger, so a
 * card inside a scrolling board column cannot clip it. Weeks start Monday.
 */

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YEARS_PER_PAGE = 12;
const POP_W = 288;
const POP_H = 372;
const GAP = 6;

function toIso(d: Date): string {
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

function fromIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const firstOfMonth = (d: Date, n = 0) => new Date(d.getFullYear(), d.getMonth() + n, 1);

/** The 42 cells of a month grid, Monday first, with neighbouring days. */
function monthCells(month: Date): Date[] {
  const lead = (month.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), 1 - lead + i));
}

/** "Sep 28" this year, "Sep 28, 2027" otherwise — short enough for a card. */
export function formatShortDate(iso: string | null | undefined): string {
  const d = fromIso(iso);
  if (!d) return '';
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) });
}

export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder = 'Pick a date',
  ariaLabel,
  className = 'input',
  valueClassName = '',
  clearable = true,
  compact = false,
  id,
}: {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  min?: string | null;
  max?: string | null;
  placeholder?: string;
  ariaLabel?: string;
  /** Classes for the trigger: `input` for a form field, `control-quiet` on a card. */
  className?: string;
  /** Extra classes for the date text, e.g. the overdue colour. */
  valueClassName?: string;
  clearable?: boolean;
  /** Card use: a smaller icon and no stretching. */
  compact?: boolean;
  id?: string;
}) {
  const selected = fromIso(value);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(() => firstOfMonth(selected ?? new Date()));
  // The calendar drills down: days → tap the title for months → tap the year
  // for a grid of years, so any month and year is two taps away instead of a
  // long run of the arrows.
  const [view, setView] = useState<'days' | 'months' | 'years'>('days');
  const [yearPage, setYearPage] = useState(() => shown.getFullYear() - (shown.getFullYear() % YEARS_PER_PAGE));
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const minD = fromIso(min);
  const maxD = fromIso(max);
  const outOfBounds = (d: Date) => (!!minD && d < minD) || (!!maxD && d > maxD);

  /** Below the trigger when it fits, above when it does not; never off-screen. */
  const place = useCallback(() => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const below = r.bottom + GAP + POP_H <= window.innerHeight;
    const top = below ? r.bottom + GAP : Math.max(8, r.top - GAP - POP_H);
    const left = Math.min(Math.max(8, r.right - POP_W), window.innerWidth - POP_W - 8);
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    // Scrolling the board moves the trigger; follow it rather than float away.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, place]);

  const toggle = () => {
    if (!open) {
      const start = firstOfMonth(selected ?? new Date());
      setShown(start);
      setView('days');
      setYearPage(start.getFullYear() - (start.getFullYear() % YEARS_PER_PAGE));
    }
    setOpen((o) => !o);
  };

  // A whole month / year is unreachable only when it lies entirely outside
  // [min, max]; a partly-allowed one stays pickable and the day grid blocks
  // the individual days.
  const monthDisabled = (year: number, m: number) =>
    (!!minD && new Date(year, m + 1, 0) < minD) || (!!maxD && new Date(year, m, 1) > maxD);
  const yearDisabled = (year: number) =>
    (!!minD && new Date(year, 11, 31) < minD) || (!!maxD && new Date(year, 0, 1) > maxD);

  const choose = (d: Date | null) => {
    onChange(d ? toIso(d) : null);
    setOpen(false);
    trigger.current?.focus();
  };

  const today = new Date();
  const todayIso = toIso(today);
  const quick = [
    { label: 'Today', d: today },
    { label: 'Tomorrow', d: addDays(today, 1) },
    { label: 'Next week', d: addDays(today, 7) },
  ];

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel ? `${ariaLabel}: ${selected ? formatShortDate(value) : 'not set'}` : undefined}
        onClick={toggle}
        className={`${className} flex items-center gap-1.5 text-left ${compact ? 'w-auto shrink-0' : 'w-full'} ${
          open ? 'border-brass/60' : ''
        }`}
      >
        <IconCalendar
          width={compact ? 13 : 15}
          height={compact ? 13 : 15}
          className="shrink-0 text-ink-faint"
        />
        <span className={`truncate tabular-nums ${selected ? valueClassName || 'text-ink' : 'text-ink-faint'}`}>
          {selected ? formatShortDate(value) : placeholder}
        </span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={pop}
            role="dialog"
            aria-label={ariaLabel ?? 'Choose a date'}
            style={{ top: pos.top, left: pos.left, width: POP_W }}
            className="popover fixed z-[60] rounded-xl border border-line bg-surface p-3 shadow-pop"
            // Portalled to <body>, so this calendar sits outside the DOM of any
            // menu that opens it (e.g. the tasks Filters popover). Without this,
            // a menu's own "click outside closes me" handler treats a click on
            // the month arrows as an outside click and closes the menu — taking
            // the calendar with it, so month/year navigation looks broken.
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Header: arrows step the current view (month / year / 12-year page),
                and the centre label climbs one level — month → year → day. */}
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                onClick={() =>
                  view === 'days'
                    ? setShown(firstOfMonth(shown, -1))
                    : view === 'months'
                      ? setShown(firstOfMonth(new Date(shown.getFullYear() - 1, shown.getMonth(), 1)))
                      : setYearPage((y) => y - YEARS_PER_PAGE)
                }
                className="focusable grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-sunk hover:text-ink"
                aria-label={view === 'days' ? 'Previous month' : view === 'months' ? 'Previous year' : 'Previous years'}
              >
                <IconChevronLeft width={16} height={16} />
              </button>
              <button
                type="button"
                onClick={() => setView(view === 'days' ? 'months' : view === 'months' ? 'years' : 'days')}
                aria-label="Change month or year"
                className="focusable rounded-lg px-2.5 py-1 text-[13.5px] font-semibold text-ink hover:bg-sunk"
              >
                {view === 'days'
                  ? shown.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
                  : view === 'months'
                    ? shown.getFullYear()
                    : `${yearPage} – ${yearPage + YEARS_PER_PAGE - 1}`}
              </button>
              <button
                type="button"
                onClick={() =>
                  view === 'days'
                    ? setShown(firstOfMonth(shown, 1))
                    : view === 'months'
                      ? setShown(firstOfMonth(new Date(shown.getFullYear() + 1, shown.getMonth(), 1)))
                      : setYearPage((y) => y + YEARS_PER_PAGE)
                }
                className="focusable grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-sunk hover:text-ink"
                aria-label={view === 'days' ? 'Next month' : view === 'months' ? 'Next year' : 'Next years'}
              >
                <IconChevronRight width={16} height={16} />
              </button>
            </div>

            {view === 'days' && (
              <div className="grid grid-cols-7 gap-y-0.5">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="pb-1 text-center text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">
                    {w}
                  </div>
                ))}
                {monthCells(shown).map((d) => {
                  const iso = toIso(d);
                  const outside = d.getMonth() !== shown.getMonth();
                  const isSel = iso === value;
                  const isToday = iso === todayIso;
                  const disabled = outOfBounds(d);
                  return (
                    <button
                      key={iso}
                      type="button"
                      disabled={disabled}
                      onClick={() => choose(d)}
                      aria-pressed={isSel}
                      aria-label={d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                      className={`focusable relative grid h-9 place-items-center rounded-lg text-[13px] tabular-nums transition-colors ${
                        isSel
                          ? 'bg-brass font-semibold text-white'
                          : disabled
                            ? 'cursor-not-allowed text-ink-faint/30'
                            : isToday
                              ? 'font-semibold text-brass-deep ring-1 ring-inset ring-brass/50 hover:bg-sunk'
                              : outside
                                ? 'text-ink-faint/60 hover:bg-sunk'
                                : 'text-ink hover:bg-sunk'
                      }`}
                    >
                      {d.getDate()}
                    </button>
                  );
                })}
              </div>
            )}

            {view === 'months' && (
              <div className="grid grid-cols-3 gap-1.5 py-1">
                {MONTHS.map((m, i) => {
                  const isSel = i === shown.getMonth();
                  const disabled = monthDisabled(shown.getFullYear(), i);
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={disabled}
                      aria-pressed={isSel}
                      onClick={() => {
                        setShown(new Date(shown.getFullYear(), i, 1));
                        setView('days');
                      }}
                      className={`focusable grid h-11 place-items-center rounded-lg text-[13px] font-medium transition-colors ${
                        isSel
                          ? 'bg-brass font-semibold text-white'
                          : disabled
                            ? 'cursor-not-allowed text-ink-faint/30'
                            : 'text-ink hover:bg-sunk'
                      }`}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            )}

            {view === 'years' && (
              <div className="grid grid-cols-3 gap-1.5 py-1">
                {Array.from({ length: YEARS_PER_PAGE }, (_, i) => yearPage + i).map((y) => {
                  const isSel = y === shown.getFullYear();
                  const disabled = yearDisabled(y);
                  return (
                    <button
                      key={y}
                      type="button"
                      disabled={disabled}
                      aria-pressed={isSel}
                      onClick={() => {
                        setShown(new Date(y, shown.getMonth(), 1));
                        setView('months');
                      }}
                      className={`focusable grid h-11 place-items-center rounded-lg text-[13px] font-medium tabular-nums transition-colors ${
                        isSel
                          ? 'bg-brass font-semibold text-white'
                          : disabled
                            ? 'cursor-not-allowed text-ink-faint/30'
                            : 'text-ink hover:bg-sunk'
                      }`}
                    >
                      {y}
                    </button>
                  );
                })}
              </div>
            )}

            {view === 'days' && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-2.5">
              {quick.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  disabled={outOfBounds(q.d)}
                  onClick={() => choose(q.d)}
                  className="focusable rounded-md bg-sunk px-2 py-1 text-[12px] font-medium text-ink-soft transition-colors hover:text-ink disabled:opacity-40"
                >
                  {q.label}
                </button>
              ))}
              {clearable && value && (
                <button
                  type="button"
                  onClick={() => choose(null)}
                  className="focusable ml-auto rounded-md px-2 py-1 text-[12px] font-medium text-ink-faint transition-colors hover:text-crit"
                >
                  Clear
                </button>
              )}
            </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
