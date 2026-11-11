import app from './app.js';
import { assertProductionSecrets, env, isSupabaseConfigured } from './env.js';
import { startScheduler } from './services/scheduler.js';

/**
 * Local / self-hosted entry point: a long-running Node server.
 *
 * This process owns the schedule: startScheduler() runs every background job
 * with node-cron (see deploy/README.md). Nothing else is needed — no Vercel
 * Cron, no Supabase pg_cron.
 */
assertProductionSecrets();

app.listen(env.port, env.host, () => {
  console.log(`  ▸ Janelle API listening on http://${env.host}:${env.port}`);
  console.log(`  ▸ CORS origins: ${env.corsOrigins.join(', ') || '(any)'}`);
  if (!isSupabaseConfigured()) {
    console.warn('  ⚠ Supabase not configured — data & auth routes return 503 until keys are set in .env');
  }
  startScheduler();
});
