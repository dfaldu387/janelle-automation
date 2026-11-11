import { assertProductionSecrets, isSupabaseConfigured } from './env.js';
import { startScheduler } from './services/scheduler.js';

/**
 * The background jobs alone, with no web server.
 *
 * For when the site and API are hosted on Vercel: the scheduled work — the
 * CPU-heavy part (reading mail, PDFs, Slack) — runs here instead, on any
 * always-on machine, straight against Supabase. Vercel then only answers
 * people's requests. Same jobs and claim fields as `index.ts`, so never run
 * both a worker and a self-hosted API with the scheduler on.
 *
 *   npm run build && npm run worker --workspace apps/api
 */
assertProductionSecrets();
if (!isSupabaseConfigured()) {
  console.error('  ✖ Worker needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
console.log('  ▸ Janelle worker (scheduler only, no web server)');
startScheduler();
