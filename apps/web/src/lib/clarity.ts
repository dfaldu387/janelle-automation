/**
 * Microsoft Clarity — loaded only for signed-in sessions, when an admin has
 * set a project id (delivered by `/me`). Session replays and heatmaps land in
 * the studio's Clarity dashboard; nothing about it is shown in the app.
 *
 * Idempotent: the tag is injected once per page, and re-identifying on each
 * `/me` just keeps the current session labelled with who is using it.
 */

type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[] };

declare global {
  interface Window {
    clarity?: ClarityFn;
  }
}

/** The id the tag was loaded with, so a changed id reloads and a repeat is a no-op. */
let loadedProject: string | null = null;

/**
 * Inject Clarity's tag for this project, once. Mirrors Clarity's official
 * snippet: a queue function stands in until the async script replaces it, so
 * an identify call made before the script lands is not lost.
 */
export function loadClarity(projectId: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const id = projectId.trim();
  if (!id || loadedProject === id) return;
  loadedProject = id;

  if (!window.clarity) {
    const q: unknown[] = [];
    const fn: ClarityFn = (...args: unknown[]) => {
      (fn.q = fn.q ?? q).push(args);
    };
    fn.q = q;
    window.clarity = fn;
  }

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.clarity.ms/tag/${encodeURIComponent(id)}`;
  const first = document.getElementsByTagName('script')[0];
  first?.parentNode?.insertBefore(script, first);
}

/**
 * Tag the current recording with who is using it, so a replay is attributable
 * to a real teammate rather than an anonymous session. `friendlyName` is what
 * shows in the Clarity dashboard; the id is the stable key.
 */
export function identifyClarity(userId: string, friendlyName?: string | null): void {
  if (typeof window === 'undefined' || !window.clarity || !userId) return;
  try {
    // (custom-id, custom-session-id, custom-page-id, friendly-name)
    window.clarity('identify', userId, undefined, undefined, friendlyName ?? undefined);
  } catch {
    // Recording without a label is still useful; never let this throw into render.
  }
}
