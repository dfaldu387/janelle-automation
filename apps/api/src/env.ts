import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Central, validated environment access. Loads the repo-root .env
 * explicitly (this file sits at apps/api/{src,dist}, so the root is
 * three levels up) and falls back to the process cwd. Missing
 * critical values fail loud at boot.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '../../../.env') });
loadEnv(); // also honour a local .env / real process env if present

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  // Managed hosts (Railway, Render, Fly) inject PORT and route to it; they
  // also require binding every interface, not just loopback. API_PORT and
  // API_HOST remain the local-development overrides.
  port: Number(process.env.PORT || optional('API_PORT', '4000')),
  host: process.env.PORT ? '0.0.0.0' : optional('API_HOST', 'localhost'),
  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  supabase: {
    // Optional so the server can boot before credentials are added.
    // Data routes return a clear "not configured" error until set.
    url: optional('SUPABASE_URL'),
    anonKey: optional('SUPABASE_ANON_KEY'),
    serviceRoleKey: optional('SUPABASE_SERVICE_ROLE_KEY'),
  },

  google: {
    clientId: optional('GOOGLE_CLIENT_ID'),
    clientSecret: optional('GOOGLE_CLIENT_SECRET'),
    redirectUri: optional('GOOGLE_REDIRECT_URI', 'http://localhost:4000/api/auth/google/callback'),
    scopes: optional('GOOGLE_SCOPES').split(' ').filter(Boolean),
  },

  /**
   * Who else hears about a new teammate.
   *
   * The studio wants the principal copied so she knows who has been let in,
   * and the developer blind-copied while the system is being built. Both are
   * configurable rather than written into the code: the second one in
   * particular should be removable without a deploy.
   */
  invite: {
    cc: optional('INVITE_CC', 'janelle@janelleinteriors.com'),
    bcc: optional('INVITE_BCC', 'dfaldu387@gmail.com'),
  },

  /**
   * The address the app is reachable at from outside this machine.
   *
   * Separate from CORS_ORIGINS on purpose. That list is about which browser
   * origins may call the API, and in development its first entry is
   * localhost — which is correct there and useless in an email, because the
   * recipient's localhost is their own machine, not the studio's server.
   *
   * Set APP_URL in any environment that sends mail.
   */
  appUrl: optional('APP_URL'),

  anthropic: {
    apiKey: optional('ANTHROPIC_API_KEY'),
    model: optional('ANTHROPIC_MODEL', 'claude-opus-5'),
  },

  // Renderings from OpenAI's GPT Image models. Empty until a key is set here
  // or in Settings; without one this provider is simply not offered.
  openai: {
    apiKey: optional('OPENAI_API_KEY'),
    imageModel: optional('OPENAI_IMAGE_MODEL', 'gpt-image-2'),
  },

  // Task and follow-up updates posted to Slack. Settings → Connections
  // overrides these per studio; empty means Slack is simply not connected.
  slack: {
    botToken: optional('SLACK_BOT_TOKEN'),
    channel: optional('SLACK_CHANNEL').replace(/^#/, ''),
  },

  tokenEncryptionKey: optional('TOKEN_ENCRYPTION_KEY'),

  /**
   * The address automatic emails are sent from, e.g. systems@janelleinteriors.com.
   * Gmail only allows it once the studio mailbox has it under "Send mail as";
   * until then emails go out from the mailbox's own address.
   */
  mail: {
    fromAddress: optional('MAIL_FROM_ADDRESS').trim().toLowerCase(),
  },

  /**
   * Email a code after signing in and keep the app closed until it is entered.
   * Each way of signing in is switched on separately. Needs migration 0039 first.
   */
  loginCode: {
    google: optional('LOGIN_CODE_GOOGLE') === 'true',
    password: optional('LOGIN_CODE_PASSWORD') === 'true',
  },
} as const;

export const isGoogleConfigured = () =>
  Boolean(env.google.clientId && env.google.clientSecret);

export const isSupabaseConfigured = () =>
  Boolean(env.supabase.url && env.supabase.anonKey && env.supabase.serviceRoleKey);

export const isAnthropicConfigured = () => Boolean(env.anthropic.apiKey);

export const isOpenAiConfigured = () => Boolean(env.openai.apiKey);

// `required` is kept for values we may enforce later; reference it so
// strict unused checks stay quiet without changing behaviour.
void required;
