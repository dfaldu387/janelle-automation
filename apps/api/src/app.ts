import express from 'express';
import cors from 'cors';
import { env } from './env.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { dashboardRouter } from './routes/dashboard.js';
import { projectsRouter } from './routes/projects.js';
import { vendorsRouter } from './routes/vendors.js';
import { purchaseOrdersRouter } from './routes/purchaseOrders.js';
import { promptsRouter } from './routes/prompts.js';
import { followUpsRouter } from './routes/followUps.js';
import { reportsRouter } from './routes/reports.js';
import { emailsRouter } from './routes/emails.js';
import { documentsRouter } from './routes/documents.js';
import { activityRouter } from './routes/activity.js';
import { draftsRouter } from './routes/drafts.js';
import { opsRouter } from './routes/ops.js';
import { tasksRouter } from './routes/tasks.js';
import { teamRouter } from './routes/team.js';
import { digestsRouter } from './routes/digests.js';
import { assistantRouter } from './routes/assistant.js';
import { usageRouter } from './routes/usage.js';
import { publicUsageRouter } from './routes/publicUsage.js';
import { permissionsRouter } from './routes/permissions.js';
import { settingsRouter } from './routes/settings.js';
import { auditRouter } from './routes/audit.js';
import { loginHistoryRouter } from './routes/loginHistory.js';
import { loginCodeRouter } from './routes/loginCode.js';
import { errorHandler, notFound } from './middleware/error.js';

/**
 * The Express application, with no server attached.
 *
 * Kept separate from `index.ts` so the same app can run two ways:
 *   • locally — `index.ts` calls `listen()` and starts the cron scheduler;
 *   • on Vercel — `api/[...path].mjs` exports this app as a serverless
 *     function, where there is no long-running process to listen or schedule.
 */
const app = express();

app.use(express.json({ limit: '4mb' }));

/**
 * Which browser origins may call this API.
 *
 * In development the Vite dev server slides to 5174, 5175 … whenever a
 * previous instance is still holding 5173, and an origin that is not on
 * the list comes back to the browser as a bare "Failed to fetch" — which
 * looks exactly like the API being down, and sends you looking in the
 * wrong place. So locally any loopback origin is accepted; deployments
 * still honour CORS_ORIGINS exactly.
 */
const isDev = process.env.NODE_ENV !== 'production';
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header at all: curl, same-origin, health checks.
      if (!origin) return callback(null, true);
      if (env.corsOrigins.includes(origin)) return callback(null, true);
      if (isDev && LOOPBACK.test(origin)) return callback(null, true);
      // Omit the header rather than erroring — the browser blocks it,
      // and a rejected origin should not become a 500 in the log.
      return callback(null, false);
    },
    credentials: true,
  }),
);

// Routes
app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/me', meRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/vendors', vendorsRouter);
app.use('/api/purchase-orders', purchaseOrdersRouter);
app.use('/api/prompts', promptsRouter);
app.use('/api/follow-ups', followUpsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/emails', emailsRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/activity', activityRouter);
app.use('/api/drafts', draftsRouter);
app.use('/api/ops', opsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/team', teamRouter);
app.use('/api/digests', digestsRouter);
app.use('/api/assistant', assistantRouter);
app.use('/api/usage', usageRouter);
app.use('/api/permissions', permissionsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/audit', auditRouter);
// Reading it needs a supervisor's session; reporting an attempt cannot have
// one — the router draws that line itself, per route.
app.use('/api/login-history', loginHistoryRouter);
// The code after Continue with Google. Reachable before that code is entered.
app.use('/api/login-code', loginCodeRouter);

// No session required — the token in the URL is the credential.
app.use('/api/public', publicUsageRouter);

// Fallbacks
app.use(notFound);
app.use(errorHandler);

export default app;
