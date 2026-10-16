import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ASSISTANT_NAME, canSupervise, type AiRoutingFeatureView, type AiRoutingView, type LlmProvider } from '@janelle/shared';
import { Page, PageHeading, Card, Pill, PasswordInput, Switch } from '../components/ui';
import {
  IconActivity,
  IconAssistant,
  IconBell,
  IconDoc,
  IconBoard,
  IconInbox,
  IconKey,
  IconMailScan,
  IconPerson,
  IconPrompt,
  IconSun,
  IconTeam,
} from '../components/icons';
import { DateRangePicker } from '../components/DateRangePicker';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { MIN_PASSWORD } from './ResetPassword';
import Team from './Team';
import Permissions from './Permissions';
import LoginHistory from './LoginHistory';
import {
  useMe,
  useConnectGoogle,
  useDisconnectGoogle,
  useAiConfig,
  usePictureConfig,
  useSetPictureEngine,
  useOpenAiConfig,
  useSetOpenAiKey,
  useClearOpenAiKey,
  useSetOpenAiModel,
  useAiRouting,
  useSetAiRoute,
  useSetGeminiTextKey,
  useClearGeminiTextKey,
  useTestAiRoute,
  useSlackConfig,
  useSetSlackToken,
  useClearSlackToken,
  useSetSlackConfig,
  useSlackTest,
  useSlackReportNow,
  useClearAiKey,
  useDisconnectGoogleService,
  useSetAiKey,
  useSetAiModel,
  useIngestSettings,
  useSetIngestSettings,
  useClaritySettings,
  useSaveClaritySettings,
  useDriveFilingSettings,
  useSaveDriveFilingSettings,
  useRevokeUsageLink,
  useRotateUsageLink,
  useUsageLink,
  useSla,
  useSaveSla,
  useMailSync,
  type MailSyncProgress,
  type MailSyncResult,
  type GoogleService,
  type Sla,
  type SlackReportChannels,
} from '../lib/queries';

const SERVICE_LABEL: Record<GoogleService | 'all', string> = { gmail: 'Gmail', drive: 'Google Drive', all: 'Google' };

/**
 * How long the studio waits before it says something.
 *
 * Written the way the studio talks about the wait rather than as field
 * names: someone tuning this is answering "we chase too early", not editing
 * `vendor_silence_days`.
 */
const SLA_DIALS: { key: keyof Sla; label: string; unit: string; hint: string; min: number; max: number }[] = [
  { key: 'vendor_silence_days', label: 'Chase a silent vendor after', unit: 'days', min: 1, max: 30,
    hint: 'An order placed but not confirmed this long.' },
  { key: 'quote_response_days', label: 'A quote is late after', unit: 'days', min: 1, max: 30,
    hint: 'Past this, the client gets an update whether or not the vendor replied.' },
  { key: 'client_approval_days', label: 'Chase a client for approval after', unit: 'days', min: 1, max: 60,
    hint: 'A project parked in the approval stage this long.' },
  { key: 'client_waiting_hours', label: 'A client left waiting is flagged after', unit: 'hours', min: 1, max: 336,
    hint: 'Nudges whoever owns the reply, not the client.' },
  { key: 'task_reminder_days', label: 'Remind an owner their task is late after', unit: 'days', min: 0, max: 30,
    hint: 'Zero nudges on the due date itself.' },
  { key: 'reminder_repeat_days', label: 'Repeat that reminder every', unit: 'days', min: 1, max: 30,
    hint: 'A cadence rather than a nightly repeat of the same nudge.' },
  { key: 'escalation_days', label: 'Escalate to the principal after', unit: 'days', min: 1, max: 30,
    hint: 'A reminded task still open this long goes up.' },
];

function ChasingCard() {
  const { data: sla, isLoading } = useSla();
  const save = useSaveSla();
  // Only what has actually been changed is sent, so two people tuning
  // different dials do not overwrite each other's.
  const [draft, setDraft] = useState<Partial<Sla>>({});

  const value = (key: keyof Sla): number | '' => {
    const pending = draft[key];
    if (pending !== undefined) return pending;
    return sla ? sla[key] : '';
  };
  const dirty = Object.keys(draft).length > 0;

  return (
    <SettingsCard
      className="lg:col-span-2"
      icon={<IconBell width={18} height={18} />}
      title="When the studio chases"
      description="When a nudge is drafted for review. Nothing is ever sent automatically."
      status={
        dirty && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => save.mutate(draft, { onSuccess: () => setDraft({}) })}
              disabled={save.isPending}
              className="btn-primary btn-sm"
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
            <button onClick={() => setDraft({})} disabled={save.isPending} className="btn-ghost btn-sm">
              Cancel
            </button>
          </div>
        )
      }
    >
      {isLoading ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {SLA_DIALS.map((d) => (
            <label
              key={d.key}
              title={d.hint}
              className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                draft[d.key] !== undefined ? 'border-brass/50 bg-brass/5' : 'border-line bg-sunk/30'
              }`}
            >
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium leading-snug text-ink">{d.label}</span>
                <span className="block truncate text-[11px] text-ink-faint">{d.hint}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <input
                  type="number"
                  min={d.min}
                  max={d.max}
                  step={1}
                  value={value(d.key)}
                  onChange={(e) => {
                    const next = e.target.value;
                    setDraft((f) => ({ ...f, [d.key]: next === '' ? d.min : Number(next) }));
                  }}
                  className="input h-8 w-16 px-2 text-center tabular-nums"
                />
                <span className="w-8 text-[11.5px] text-ink-soft">{d.unit}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <ErrorLine error={save.error as Error | null} />
    </SettingsCard>
  );
}

/**
 * Change the password, from inside the app.
 *
 * The current one is asked for and checked, which Supabase does not require
 * — `updateUser` will change the password of whoever holds the session. So
 * a laptop left open, or a stolen token, would be enough to take the
 * account away from its owner. Re-authenticating first makes the person at
 * the keyboard prove they are the person whose account it is.
 */
function PasswordCard() {
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: 'good' | 'crit' } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase || !user?.email) return;
    if (next.length < MIN_PASSWORD) return setMsg({ text: `Use at least ${MIN_PASSWORD} characters.`, tone: 'crit' });
    if (next !== confirm) return setMsg({ text: 'The two new passwords do not match.', tone: 'crit' });
    if (next === current) return setMsg({ text: 'That is already your password.', tone: 'crit' });

    setBusy(true);
    setMsg(null);
    try {
      // Proves who is at the keyboard. On success this also refreshes the
      // session, which is harmless — it is the same account either way.
      const { error: wrong } = await supabase.auth.signInWithPassword({ email: user.email, password: current });
      if (wrong) throw new Error('That is not your current password.');

      const { error: failed } = await supabase.auth.updateUser({ password: next });
      if (failed) throw failed;

      // Everywhere else is signed out — a password change should end any
      // session the person did not know about.
      try {
        await supabase.auth.signOut({ scope: 'others' });
      } catch {
        /* the new password still stands */
      }

      setCurrent('');
      setNext('');
      setConfirm('');
      setMsg({ text: 'Password changed. Any other device has been signed out.', tone: 'good' });
    } catch (err) {
      setMsg({ text: (err as Error).message, tone: 'crit' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      icon={<IconKey width={18} height={18} />}
      title="Password"
      description={user?.email ? `Signed in as ${user.email}.` : 'Change the password you sign in with.'}
    >
      <form onSubmit={submit} className="space-y-2.5">
        <PasswordInput
          required
          placeholder="Current password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
        <div className="grid gap-2.5 sm:grid-cols-2">
          <PasswordInput
            required
            minLength={MIN_PASSWORD}
            placeholder="New password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
          />
          <PasswordInput
            required
            minLength={MIN_PASSWORD}
            placeholder="Repeat it"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </div>

        {msg && (
          <p className={`rounded-lg px-3 py-2 text-[12.5px] ${msg.tone === 'crit' ? 'bg-crit/10 text-crit' : 'bg-good/10 text-good'}`}>
            {msg.text}
          </p>
        )}

        <button type="submit" disabled={busy} className="btn-primary btn-sm">
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </SettingsCard>
  );
}

function googleFlash(): { text: string; tone: 'good' | 'crit' } | null {
  const q = new URLSearchParams(window.location.search);
  const p = q.get('google');
  const svc = q.get('service');
  const name = SERVICE_LABEL[(svc === 'gmail' || svc === 'drive' ? svc : 'all') as GoogleService | 'all'];
  if (p === 'connected') return { text: `${name} connected.`, tone: 'good' };
  if (p === 'error') return { text: `${name} connection failed — try again.`, tone: 'crit' };
  return null;
}

function GmailMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#EA4335" d="M4 6.5v11A1.5 1.5 0 0 0 5.5 19H7v-8.2l5 3.7 5-3.7V19h1.5a1.5 1.5 0 0 0 1.5-1.5v-11L12 12 4 6.5Z" />
      <path fill="#4285F4" d="M18.5 5H17v5.8l3-2.2V6.5A1.5 1.5 0 0 0 18.5 5Z" />
      <path fill="#34A853" d="M7 10.8V5H5.5A1.5 1.5 0 0 0 4 6.5v2.1l3 2.2Z" />
      <path fill="#FBBC04" d="M7 5v5.8l5 3.7 5-3.7V5l-5 3.7L7 5Z" />
    </svg>
  );
}

function DriveMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#0F9D58" d="M8.2 3h7.6l6 10.4h-7.6L8.2 3Z" />
      <path fill="#F4B400" d="M8.2 3 2.2 13.4l3.8 6.6 6-10.4L8.2 3Z" />
      <path fill="#4285F4" d="M6 20h12l3.8-6.6H9.8L6 20Z" />
    </svg>
  );
}

function ServiceCard({
  service,
  title,
  blurb,
  scopes,
  connected,
  everConnected,
  Mark,
}: {
  service: GoogleService;
  title: string;
  blurb: string;
  scopes: { name: string; note?: string }[];
  connected: boolean;
  /** True when Google is linked at all — so an unused service reads as "Reconnect". */
  everConnected: boolean;
  Mark: () => JSX.Element;
}) {
  const connect = useConnectGoogle();
  const disconnect = useDisconnectGoogleService();
  const pending = connect.isPending && connect.variables === service;
  return (
    <div className="flex flex-col rounded-lg border border-line bg-sunk/30 p-3.5">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface">
          <Mark />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
            <Pill tone={connected ? 'good' : 'neutral'}>{connected ? 'Connected' : 'Not connected'}</Pill>
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-soft">{blurb}</p>
        </div>
      </div>

      <ul className="mt-2.5 space-y-0.5 text-[11.5px] text-ink-soft">
        {scopes.map((s) => (
          <li key={s.name} className="flex items-baseline gap-2">
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${connected ? 'bg-good' : 'bg-ink-faint'}`} aria-hidden="true" />
            <span className="font-medium text-ink">{s.name}</span>
            {s.note && <span className="text-ink-faint">{s.note}</span>}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-center gap-2">
        {connected ? (
          <button
            onClick={() => disconnect.mutate(service)}
            disabled={disconnect.isPending}
            className="btn-secondary btn-sm"
            title={`Stop reading ${title}. The other service keeps working.`}
          >
            {disconnect.isPending ? 'Disconnecting…' : `Disconnect ${title}`}
          </button>
        ) : (
          <button
            onClick={() => connect.mutate(service)}
            disabled={connect.isPending}
            className="btn-primary btn-sm"
          >
            {pending ? 'Redirecting…' : everConnected ? `Reconnect ${title}` : `Connect ${title}`}
          </button>
        )}
      </div>
      {connect.isError && <p className="mt-2 text-[12.5px] text-crit">{(connect.error as Error).message}</p>}
      {disconnect.isError && (
        <p className="mt-2 text-[12.5px] text-crit">{(disconnect.error as Error).message}</p>
      )}
    </div>
  );
}
/**
 * The one card shape every setting uses: an icon, a title, one line of
 * explanation and, where there is one, a status — then the controls.
 *
 * The page used to be ten cards each opening with a heading and a paragraph,
 * which made it long to scroll and hard to scan. The explanation still
 * matters, so it stays, but as a single line under the title.
 */
function SettingsCard({
  icon,
  title,
  description,
  status,
  className = '',
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  status?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Card className={`p-5 ${className}`}>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-sunk/60 text-brass">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[15px] font-semibold leading-tight text-ink">{title}</h2>
            {status}
          </div>
          {description && <p className="mt-0.5 text-[12.5px] leading-snug text-ink-soft">{description}</p>}
        </div>
      </div>
      {children && <div className="mt-4">{children}</div>}
    </Card>
  );
}

/** A small label above a control, so every field on the page reads alike. */
function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[11.5px] font-semibold uppercase tracking-wide text-ink-faint">
      {children}
    </label>
  );
}

/** The quiet line under a control. */
function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-[11.5px] leading-snug text-ink-faint">{children}</p>;
}

function Connected({ on }: { on: boolean }) {
  return <Pill tone={on ? 'good' : 'crit'}>{on ? 'Connected' : 'No key'}</Pill>;
}

/**
 * An API key: paste, save, remove.
 *
 * Three providers used to carry three copies of this. The key is never
 * shown again after saving — only where it came from and its last four.
 */
function KeyField({
  id,
  placeholder,
  view,
  onSave,
  onClear,
  saving,
  clearing,
}: {
  id: string;
  placeholder: string;
  view: { configured: boolean; source: 'studio' | 'environment' | 'none'; keyHint: string | null };
  onSave: (key: string, done: () => void) => void;
  onClear: () => void;
  saving: boolean;
  clearing: boolean;
}) {
  const [draft, setDraft] = useState('');
  return (
    <div>
      <FieldLabel htmlFor={id}>API key</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <PasswordInput
          id={id}
          label="key"
          wrapperClassName="min-w-0 flex-1"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={view.configured ? `•••• ${view.keyHint ?? ''} — paste a new key to replace it` : placeholder}
          className="w-full"
        />
        <button
          className="btn-primary btn-sm"
          disabled={saving || clearing || draft.trim().length === 0}
          onClick={() => onSave(draft.trim(), () => setDraft(''))}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {view.source === 'studio' && (
          <button className="btn-ghost btn-sm" disabled={saving || clearing} onClick={onClear}>
            {clearing ? 'Removing…' : 'Remove'}
          </button>
        )}
      </div>
      <Hint>
        {view.source === 'environment'
          ? 'Using the server’s key. A key saved here replaces it.'
          : 'Stored encrypted and never shown again.'}
      </Hint>
    </div>
  );
}

/** A labelled select, with the chosen option's note beneath it. */
function ModelSelect({
  id,
  label,
  value,
  options,
  note,
  pending,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: { id: string; label: string }[];
  note?: string;
  pending: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select id={id} className="input w-full" value={value} disabled={pending} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {(pending || note) && <Hint>{pending ? 'Saving…' : note}</Hint>}
    </div>
  );
}

function ErrorLine({ error }: { error?: Error | null }) {
  return error ? <p className="mt-3 text-[12.5px] text-crit">{error.message}</p> : null;
}

/**
 * A confirmation that goes away by itself — "saved", "switched", "sent".
 *
 * Saving used to finish silently: the button stopped saying "Saving…" and
 * nothing said it had worked, so people pressed it twice or doubted it. This
 * says what happened, in the words of what they asked for, then clears.
 */
function useFlash(ms = 5000) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const say = (text: string) => {
    setMessage(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(null), ms);
  };
  return [message, say] as const;
}

function Flash({ message, className = '' }: { message: string | null; className?: string }) {
  return message ? (
    <p role="status" className={`text-[12.5px] font-medium text-good ${className}`}>
      ✓ {message}
    </p>
  ) : null;
}

/**
 * The studio's Claude credentials. Kept here rather than in a deploy so the
 * key can be rotated by the person who owns the Anthropic account, not by
 * whoever has access to the server.
 */
function AiSetupCard() {
  const config = useAiConfig();
  const setKey = useSetAiKey();
  const clearKey = useClearAiKey();
  const setModel = useSetAiModel();

  // A 403 means "not a principal" — say nothing rather than showing an
  // error for a card this person was never meant to use.
  if (config.isError) return null;
  const data = config.data;
  const model = data?.models.find((m) => m.id === data.model);

  return (
    <SettingsCard
      className="lg:col-span-2"
      icon={<IconAssistant width={18} height={18} />}
      title={`${ASSISTANT_NAME}’s brain — Claude`}
      description={
        <>
          Reads email, raises tasks, drafts follow-ups and answers questions. Keys from{' '}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="font-medium text-brass hover:underline">
            console.anthropic.com
          </a>
          .
        </>
      }
      status={data && <Connected on={data.configured} />}
    >
      {!data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <KeyField
            id="ai-key"
            placeholder="sk-ant-…"
            view={data}
            saving={setKey.isPending}
            clearing={clearKey.isPending}
            onSave={(key, done) => setKey.mutate(key, { onSuccess: done })}
            onClear={() => clearKey.mutate(undefined)}
          />
          <ModelSelect
            id="ai-model"
            label="Model"
            value={data.model}
            options={data.models}
            note={model?.note ?? 'Used by every AI feature.'}
            pending={setModel.isPending}
            onChange={(m) => setModel.mutate(m)}
          />
        </div>
      )}
      <ErrorLine error={(setKey.error ?? clearKey.error ?? setModel.error) as Error | null} />
    </SettingsCard>
  );
}

/**
 * Who does the work — which AI handles each action.
 *
 * Every action starts on Claude. Moving one to OpenAI or Gemini is a choice
 * made here, per action, and is judged before it is made: Test runs a sample
 * email through the candidate and shows what it understood and what it cost.
 * Jenny's tool loop and anything that reads a PDF stay on Claude, and the
 * card says so rather than offering a switch that would not do anything.
 *
 * Laid out as a table — an action per line, with the AI and the model beside
 * it — so seven actions read at a glance instead of as seven forms. The three
 * providers sit above it as a status strip: which are ready, and the one key
 * that still has to be pasted.
 */
function AiRoutingCard() {
  const [flash, say] = useFlash();
  const routing = useAiRouting();
  const setGeminiKey = useSetGeminiTextKey();
  const clearGeminiKey = useClearGeminiTextKey();

  if (routing.isError) return null;
  const data = routing.data;
  const openai = data?.providers.find((p) => p.id === 'openai');
  const gemini = data?.providers.find((p) => p.id === 'gemini');
  const columns = 'lg:grid-cols-[minmax(0,1.5fr)_9rem_minmax(0,1.3fr)_11rem]';

  return (
    <SettingsCard
      icon={<IconAssistant width={18} height={18} />}
      title="Who does the work"
      description="Choose which AI handles each action. Everything runs on Claude until you change it — test a model on a sample email first, then switch."
      className="lg:col-span-2"
    >
      {!data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-medium text-ink">Claude</p>
                <Pill tone="good">Default</Pill>
              </div>
              <p className="mt-1 text-[12px] text-ink-soft">Uses the key and model under “Jenny’s brain” above.</p>
            </div>
            <div className="rounded-lg border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-medium text-ink">OpenAI</p>
                <Pill tone={openai?.configured ? 'good' : 'warn'}>{openai?.configured ? 'Ready' : 'Needs a key'}</Pill>
              </div>
              <p className="mt-1 text-[12px] text-ink-soft">
                {openai?.configured
                  ? `Uses the key under “Photos — OpenAI” (•••• ${openai.keyHint}).`
                  : 'Add the key under “Photos — OpenAI” below — one key does both.'}
              </p>
            </div>
            <div className="rounded-lg border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-medium text-ink">Gemini</p>
                <Pill tone={gemini?.configured ? 'good' : 'warn'}>{gemini?.configured ? 'Ready' : 'Needs a key'}</Pill>
              </div>
              <div className="mt-2">
                <KeyField
                  id="gemini-text-key"
                  placeholder="AIza…"
                  view={{ configured: Boolean(gemini?.configured), source: gemini?.configured ? 'studio' : 'none', keyHint: gemini?.keyHint ?? null }}
                  saving={setGeminiKey.isPending}
                  clearing={clearGeminiKey.isPending}
                  onSave={(key, done) => setGeminiKey.mutate(key, { onSuccess: () => { done(); say('Gemini key saved'); } })}
                  onClear={() => clearGeminiKey.mutate(undefined, { onSuccess: () => say('Gemini key removed — actions set to Gemini are back on Claude') })}
                />
              </div>
            </div>
          </div>
          <Flash message={flash} />

          <div className="overflow-hidden rounded-lg border border-line">
            <div className={`hidden gap-x-4 border-b border-line bg-sunk/40 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint lg:grid ${columns}`}>
              <span>Action</span>
              <span>AI</span>
              <span>Model</span>
              <span />
            </div>
            <div className="divide-y divide-line">
              {data.features.map((f) => (
                <RoutingRow key={f.id} feature={f} data={data} columns={columns} />
              ))}
            </div>
          </div>
          <p className="text-[12px] text-ink-faint">
            Always Claude: Jenny’s answers (they use Claude’s tools) and reading PDFs and pictures (Claude takes the file itself).
          </p>
        </div>
      )}
      <ErrorLine error={(setGeminiKey.error ?? clearGeminiKey.error) as Error | null} />
    </SettingsCard>
  );
}

const CUSTOM_MODEL = '__custom__';

function RoutingRow({ feature, data, columns }: { feature: AiRoutingFeatureView; data: AiRoutingView; columns: string }) {
  const [flash, say] = useFlash(8000);
  const setRoute = useSetAiRoute();
  const test = useTestAiRoute();
  const saved = feature.route;
  const savedKnown = saved ? data.presets.some((p) => p.provider === saved.provider && p.id === saved.model) : true;

  const [provider, setProvider] = useState<LlmProvider>(saved?.provider ?? 'anthropic');
  const [model, setModel] = useState<string>(saved ? (savedKnown ? saved.model : CUSTOM_MODEL) : '');
  const [custom, setCustom] = useState(saved && !savedKnown ? saved.model : '');
  const [inPrice, setInPrice] = useState(saved && !savedKnown ? String(saved.inputPer1M ?? '') : '');
  const [outPrice, setOutPrice] = useState(saved && !savedKnown ? String(saved.outputPer1M ?? '') : '');

  const presets = data.presets.filter((p) => p.provider === provider);
  const modelId = model === CUSTOM_MODEL ? custom.trim() : model;
  const prices = model === CUSTOM_MODEL ? { inputPer1M: Number(inPrice), outputPer1M: Number(outPrice) } : {};
  const ready = provider === 'anthropic' || (modelId.length > 0 && (model !== CUSTOM_MODEL || (inPrice !== '' && outPrice !== '')));
  const dirty = provider !== (saved?.provider ?? 'anthropic') || (provider !== 'anthropic' && modelId !== (saved?.model ?? ''));
  const savedLabel = saved ? data.providers.find((p) => p.id === saved.provider)?.label : null;

  const changeProvider = (next: LlmProvider) => {
    setProvider(next);
    setModel(next === 'anthropic' ? '' : (data.presets.find((p) => p.provider === next)?.id ?? ''));
    test.reset();
  };

  return (
    <div className="px-3 py-3">
      <div className={`grid items-center gap-x-4 gap-y-2 ${columns}`}>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink">
            {feature.label}
            {saved && <Pill tone="neutral">{savedLabel} · {saved.model}</Pill>}
          </p>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-soft">{feature.note}</p>
        </div>

        <select
          aria-label={`AI for ${feature.label}`}
          className="input w-full"
          value={provider}
          disabled={setRoute.isPending}
          onChange={(e) => changeProvider(e.target.value as LlmProvider)}
        >
          {data.providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.configured && p.id !== provider}>
              {p.label}
              {p.configured ? '' : ' (add key)'}
            </option>
          ))}
        </select>

        {provider === 'anthropic' ? (
          <span className="text-[12px] text-ink-faint">Model set under “Jenny’s brain”</span>
        ) : (
          <select
            aria-label={`Model for ${feature.label}`}
            className="input w-full min-w-0"
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              test.reset();
            }}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>Other model…</option>
          </select>
        )}

        <div className="flex items-center gap-2 lg:justify-end">
          {provider !== 'anthropic' && (
            <button className="btn-ghost btn-sm" disabled={!ready || test.isPending} onClick={() => test.mutate({ provider, model: modelId, ...prices })}>
              {test.isPending ? 'Testing…' : 'Test'}
            </button>
          )}
          {dirty && (
            <button
              className="btn-primary btn-sm"
              disabled={!ready || setRoute.isPending}
              onClick={() =>
                setRoute.mutate(
                  { feature: feature.id, provider, model: modelId, ...prices },
                  {
                    onSuccess: () =>
                      say(
                        provider === 'anthropic'
                          ? `${feature.label} now runs on Claude`
                          : `${feature.label} now runs on ${data.providers.find((p) => p.id === provider)?.label} · ${modelId}`,
                      ),
                  },
                )
              }
            >
              {setRoute.isPending ? 'Saving…' : provider === 'anthropic' ? 'Use Claude' : 'Switch'}
            </button>
          )}
        </div>
      </div>

      <Flash message={flash} className="mt-2" />

      {provider !== 'anthropic' && model === CUSTOM_MODEL && (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <input className="input" aria-label="Model name" placeholder="Model name" value={custom} onChange={(e) => setCustom(e.target.value)} autoComplete="off" spellCheck={false} />
          <input className="input" aria-label="Input price per million tokens" placeholder="$ per 1M tokens in" inputMode="decimal" value={inPrice} onChange={(e) => setInPrice(e.target.value)} />
          <input className="input" aria-label="Output price per million tokens" placeholder="$ per 1M tokens out" inputMode="decimal" value={outPrice} onChange={(e) => setOutPrice(e.target.value)} />
        </div>
      )}

      {provider !== 'anthropic' && model !== CUSTOM_MODEL && presets.find((p) => p.id === model) && (
        <p className="mt-1.5 text-[11.5px] text-ink-faint">
          Costs ${presets.find((p) => p.id === model)?.inputPer1M} in / ${presets.find((p) => p.id === model)?.outputPer1M} out per million tokens.
        </p>
      )}

      {test.data && (
        <div className={`mt-2 rounded-md border p-2.5 text-[12px] ${test.data.ok ? 'border-line bg-sunk/40 text-ink-soft' : 'border-crit/40 text-crit'}`}>
          {test.data.ok ? (
            <div className="grid gap-2 md:grid-cols-2">
              <div>
                <p>
                  Answered in {(test.data.latencyMs / 1000).toFixed(1)}s · {test.data.inputTokens} in / {test.data.outputTokens} out · about $
                  {test.data.costUsd.toFixed(5)} for this email
                </p>
                <p className="mt-1">
                  Right answer: class <b>quote_request</b>, vendor <b>Hartwell Fabrics</b>, project <b>Meridian Ranch</b>, action needed <b>true</b>.
                </p>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11.5px] text-ink">{JSON.stringify(test.data.sample, null, 1)}</pre>
            </div>
          ) : (
            test.data.error
          )}
        </div>
      )}
      <ErrorLine error={(setRoute.error ?? test.error) as Error | null} />
    </div>
  );
}

/**
 * Which provider draws pictures.
 *
 * One choice, with the provider's state beside it, so nobody has to open
 * another card to learn why a render came from somewhere they did not expect.
 * The chosen engine draws first; Claude sketches when it cannot.
 */
function PictureProviderCard() {
  const pictures = usePictureConfig();
  const openai = useOpenAiConfig();
  const setEngine = useSetPictureEngine();

  if (pictures.isError) return null;
  const data = pictures.data;
  const providers: { name: string; on: boolean | undefined }[] = [{ name: 'OpenAI', on: openai.data?.configured }];

  return (
    <SettingsCard
      icon={<IconBoard width={18} height={18} />}
      title="Who draws pictures"
      description="Renderings, boards and Jenny's Image mode. The one you pick draws first; Claude sketches if it fails."
    >
      {!data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="space-y-4">
          <ModelSelect
            id="picture-engine"
            label="Drawn by"
            value={data.engine}
            options={data.engines}
            note={data.engines.find((e) => e.id === data.engine)?.note}
            pending={setEngine.isPending}
            onChange={(e) => setEngine.mutate(e)}
          />
          <div className="flex flex-wrap gap-2">
            {providers.map((p) => (
              <Pill key={p.name} tone={p.on ? 'good' : 'neutral'}>
                {p.name}: {p.on === undefined ? '…' : p.on ? 'connected' : 'no key'}
              </Pill>
            ))}
          </div>
        </div>
      )}
      <ErrorLine error={setEngine.error as Error | null} />
    </SettingsCard>
  );
}

/**
 * OpenAI GPT Image — renderings, billed per image on the studio's OpenAI
 * account. Model and quality are chosen here because quality moves the price
 * more than anything else.
 */
function OpenAiSetupCard() {
  const config = useOpenAiConfig();
  const setKey = useSetOpenAiKey();
  const clearKey = useClearOpenAiKey();
  const setModel = useSetOpenAiModel();

  if (config.isError) return null;
  const data = config.data;
  const model = data?.models.find((m) => m.id === data.imageModel);

  return (
    <SettingsCard
      icon={<IconPrompt width={18} height={18} />}
      title="Photos — OpenAI"
      description={
        <>
          Photoreal renderings with GPT Image, billed per image. Keys from{' '}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="font-medium text-brass hover:underline">
            platform.openai.com
          </a>
          .
        </>
      }
      status={data && <Connected on={data.configured} />}
    >
      {!data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="space-y-4">
          <KeyField
            id="openai-key"
            placeholder="sk-…"
            view={data}
            saving={setKey.isPending}
            clearing={clearKey.isPending}
            onSave={(key, done) => setKey.mutate(key, { onSuccess: done })}
            onClear={() => clearKey.mutate(undefined)}
          />
          {data.source === 'environment' && (
            <Hint>Using OPENAI_API_KEY from the server. A key saved here replaces it.</Hint>
          )}
          <ModelSelect
            id="openai-model"
            label="Image model"
            value={data.imageModel}
            options={data.models.map((m) => ({ id: m.id, label: `${m.label} — ${m.approx ? "≈" : ""}${usdEach(m.usd[data.quality])} each` }))}
            note={model?.note}
            pending={setModel.isPending}
            onChange={(m) => setModel.mutate({ model: m })}
          />
          <ModelSelect
            id="openai-quality"
            label="Quality"
            value={data.quality}
            options={data.qualities}
            note="Price is per image at this quality; a wide or tall picture costs about half as much again."
            pending={setModel.isPending}
            onChange={(q) => setModel.mutate({ quality: q })}
          />
        </div>
      )}
      <ErrorLine error={(setKey.error ?? clearKey.error ?? setModel.error) as Error | null} />
    </SettingsCard>
  );
}

const REPORT_KINDS: { key: keyof SlackReportChannels; label: string; placeholder: string; note: string }[] = [
  { key: 'completed', label: 'Completed', placeholder: 'completed-tasks', note: 'Finished yesterday and today.' },
  { key: 'pending', label: 'Pending', placeholder: 'pending-tasks', note: 'Open and due today or tomorrow.' },
  { key: 'overdue', label: 'Overdue', placeholder: 'overdue-tasks', note: 'Open and past their due date.' },
];

function SlackSetupCard() {
  const [flash, say] = useFlash();
  const config = useSlackConfig();
  const setToken = useSetSlackToken();
  const clearToken = useClearSlackToken();
  const setConfig = useSetSlackConfig();
  const test = useSlackTest();
  const reportNow = useSlackReportNow();
  const [token, setTokenText] = useState('');
  const [channel, setChannel] = useState<string | null>(null);
  const [reports, setReports] = useState<SlackReportChannels | null>(null);

  if (config.isError) return null;
  const data = config.data;
  const channelValue = channel ?? data?.channel ?? '';
  const channelDirty = data !== undefined && channelValue.trim().replace(/^#/, '') !== data.channel;

  const clean = (c: string) => c.trim().replace(/^#/, '');
  const reportValue = reports ?? data?.reportChannels ?? { completed: '', pending: '', overdue: '' };
  const reportsDirty =
    data !== undefined &&
    REPORT_KINDS.some(({ key }) => clean(reportValue[key]) !== data.reportChannels[key]);

  return (
    <SettingsCard
      icon={<IconBell width={18} height={18} />}
      title="Slack"
      description="Task reports in Slack — completed, pending and overdue, each in its own channel — at 9am, midday and 5pm Pacific."
      status={data && <Pill tone={data.connected ? 'good' : 'crit'}>{data.connected ? 'Connected' : 'Not set up'}</Pill>}
      className="lg:col-span-2"
    >
      {!data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-4">
              <div>
                <FieldLabel htmlFor="slack-token">Bot token</FieldLabel>
                <div className="flex flex-wrap items-center gap-2">
                  <PasswordInput
                    id="slack-token"
                    label="Slack bot token"
                    wrapperClassName="min-w-0 flex-1"
                    autoComplete="off"
                    spellCheck={false}
                    value={token}
                    onChange={(e) => setTokenText(e.target.value)}
                    placeholder={data.keyHint ? `•••• ${data.keyHint} — paste to replace` : 'xoxb-…'}
                    className="w-full"
                  />
                  <button
                    className="btn-primary btn-sm"
                    disabled={setToken.isPending || !token.trim()}
                    onClick={() => setToken.mutate(token.trim(), { onSuccess: () => { setTokenText(''); say('Token saved and checked with Slack'); } })}
                  >
                    {setToken.isPending ? 'Checking…' : 'Save'}
                  </button>
                  {data.source === 'studio' && (
                    <button className="btn-ghost btn-sm" disabled={clearToken.isPending} onClick={() => clearToken.mutate(undefined, { onSuccess: () => say('Token removed') })}>
                      {clearToken.isPending ? 'Removing…' : 'Remove'}
                    </button>
                  )}
                </div>
                <Hint>
                  {data.source === 'environment'
                    ? 'Using SLACK_BOT_TOKEN from the server. A token saved here replaces it.'
                    : 'The Bot User OAuth Token (xoxb-…) of a Slack app with chat:write, chat:write.public, channels:read and groups:read. Stored encrypted.'}
                </Hint>
              </div>

              <div>
                <FieldLabel htmlFor="slack-channel">Default channel</FieldLabel>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="slack-channel"
                    className="input min-w-0 flex-1"
                    autoComplete="off"
                    spellCheck={false}
                    value={channelValue}
                    onChange={(e) => setChannel(e.target.value)}
                    placeholder="project-updates"
                  />
                  <button
                    className="btn-primary btn-sm"
                    disabled={setConfig.isPending || !channelDirty || !channelValue.trim()}
                    onClick={() => setConfig.mutate({ channel: channelValue.trim() }, { onSuccess: () => { setChannel(null); say('Default channel saved'); } })}
                  >
                    {setConfig.isPending ? 'Saving…' : 'Save'}
                  </button>
                  <button className="btn-ghost btn-sm" disabled={test.isPending || !data.connected} onClick={() => test.mutate(undefined, { onSuccess: () => say(`Test message sent to #${data.channel}`) })}>
                    {test.isPending ? 'Sending…' : 'Send a test'}
                  </button>
                </div>
                <Hint>Where the test message goes. The task reports go to their own channels, set alongside.</Hint>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-lg border border-line p-3">
                <Switch
                  checked={data.enabled}
                  disabled={setConfig.isPending}
                  label="Send task reports"
                  onChange={(next) => setConfig.mutate({ enabled: next }, { onSuccess: () => say(`Task reports turned ${next ? 'on' : 'off'}`) })}
                />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium leading-tight text-ink">Send task reports</p>
                  <p className="mt-0.5 text-[12px] leading-snug text-ink-soft">9am, midday and 5pm Pacific. Switch off to pause without losing the setup.</p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-lg border border-line p-3">
                <Switch
                  checked={data.personalReminders}
                  disabled={setConfig.isPending || !data.enabled}
                  label="Message each person directly"
                  onChange={(next) => setConfig.mutate({ personalReminders: next }, { onSuccess: () => say(`Direct messages turned ${next ? 'on' : 'off'}`) })}
                />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium leading-tight text-ink">Message each person directly</p>
                  <p className="mt-0.5 text-[12px] leading-snug text-ink-soft">
                    Their top priorities at 9am and the end-of-day check-in at 5pm as a Slack DM, and the team summary to the owner — the same as the reminder emails. Needs the users:read.email and im:write permissions on the Slack app; someone with no Slack account at their email gets the email only.
                  </p>
                </div>
              </div>

              <div>
                <FieldLabel>Report channels</FieldLabel>
                <div className="space-y-2">
                  {REPORT_KINDS.map(({ key, label, placeholder, note }) => (
                    <div key={key} className="grid grid-cols-[96px_1fr] items-center gap-2">
                      <label htmlFor={`slack-report-${key}`} className="text-[13px] font-medium text-ink">{label}</label>
                      <div>
                        <input
                          id={`slack-report-${key}`}
                          className="input w-full"
                          autoComplete="off"
                          spellCheck={false}
                          value={reportValue[key]}
                          onChange={(e) => setReports({ ...reportValue, [key]: e.target.value })}
                          placeholder={placeholder}
                        />
                        <p className="mt-0.5 text-[11.5px] text-ink-faint">{note}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    className="btn-primary btn-sm"
                    disabled={setConfig.isPending || !reportsDirty}
                    onClick={() =>
                      setConfig.mutate(
                        { reportChannels: { completed: clean(reportValue.completed), pending: clean(reportValue.pending), overdue: clean(reportValue.overdue) } },
                        { onSuccess: () => { setReports(null); say('Report channels saved'); } },
                      )
                    }
                  >
                    {setConfig.isPending ? 'Saving…' : 'Save channels'}
                  </button>
                  <button
                    className="btn-ghost btn-sm"
                    disabled={reportNow.isPending || reportsDirty || !data.keyHint || !REPORT_KINDS.some(({ key }) => data.reportChannels[key])}
                    onClick={() =>
                      reportNow.mutate(undefined, {
                        onSuccess: (r) =>
                          say(
                            r.skipped
                              ? `Nothing sent (${r.skipped.replace(/_/g, ' ')})`
                              : r.reports
                                  .map((x) => `#${x.channel}: ${x.error ? `failed — ${x.error}` : x.posted ? `${x.tasks} task${x.tasks === 1 ? '' : 's'}` : 'nothing to report'}`)
                                  .join(' · '),
                          ),
                        onError: (e) => say((e as Error).message),
                      })
                    }
                  >
                    {reportNow.isPending ? 'Sending…' : 'Send reports now'}
                  </button>
                </div>
                <Hint>Leave a channel blank to skip that report. A report with nothing in it is not posted. Invite the bot to private channels with /invite @your-bot.</Hint>
              </div>
            </div>
          </div>

          <Flash message={flash} />
          {data.lastError && <p className="text-[12.5px] text-crit">{data.lastError}</p>}
        </div>
      )}
      <ErrorLine error={(setToken.error ?? clearToken.error ?? setConfig.error ?? test.error ?? reportNow.error) as Error | null} />
    </SettingsCard>
  );
}

/** Cents when small, dollars when not — a price people read at a glance. */
function usdEach(n: number): string {
  return n < 1 ? `${Math.round(n * 100)}c` : `$${n.toFixed(2)}`;
}

/**
 * How often the studio looks for new mail, and whether Claude reads it —
 * the two dials that actually move the bill, in front of the person paying.
 */
function EmailReadingCard() {
  const settings = useIngestSettings();
  const save = useSetIngestSettings();

  if (settings.isError) return null;
  const data = settings.data;

  return (
    <SettingsCard
      className="lg:col-span-2"
      icon={<IconMailScan width={18} height={18} />}
      title="Reading email"
      description="How often Gmail and Drive are checked, whether Claude reads what arrives, and how often finished tasks are closed."
    >
      {!data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <FieldLabel htmlFor="ingest-every">Check for new email</FieldLabel>
            <select
              id="ingest-every"
              className="input w-full"
              value={data.intervalMinutes}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ intervalMinutes: Number(e.target.value) })}
            >
              {data.intervals.map((i) => (
                <option key={i.minutes} value={i.minutes}>
                  {i.label}
                </option>
              ))}
            </select>
            <Hint>
              {data.intervalMinutes === 0
                ? 'Nothing is read on a schedule — use “Read Gmail & Drive” on the dashboard.'
                : 'Checking more often costs more: each new email is read by Claude.'}
            </Hint>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-line bg-sunk/40 p-3">
            <Switch
              checked={data.useAi}
              disabled={save.isPending}
              label="Let Claude read incoming email"
              onChange={(next) => save.mutate({ useAi: next })}
            />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">Let {ASSISTANT_NAME} read what arrives</div>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-soft">
                {data.useAi
                  ? 'Classified, linked to a project, turned into tasks and drafts. Most of the cost is here.'
                  : 'Fetched and filed only — no tasks, no drafts, nothing spent.'}
              </p>
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="task-review-every">Close finished tasks</FieldLabel>
            <select
              id="task-review-every"
              className="input w-full"
              value={data.taskReviewMinutes}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ taskReviewMinutes: Number(e.target.value) })}
            >
              {data.taskReviewIntervals.map((i) => (
                <option key={i.minutes} value={i.minutes}>
                  {i.label}
                </option>
              ))}
            </select>
            <Hint>
              {data.taskReviewMinutes === 0
                ? 'Open tasks are never checked on a schedule — they close when someone marks them done.'
                : 'Open tasks are checked against the mail since they were raised. Only tasks with new mail cost a Claude call.'}
            </Hint>
          </div>
        </div>
      )}
      <ErrorLine error={save.error as Error | null} />
    </SettingsCard>
  );
}

/**
 * The AI usage page has no menu entry and no sign-in: the link is the
 * credential. That is what makes it shareable with someone who has no
 * account — an accountant, a partner — so minting and revoking it is a
 * deliberate act, kept with the other things only a principal may change.
 */
function AiUsageLinkCard() {
  const link = useUsageLink();
  const rotate = useRotateUsageLink();
  const revoke = useRevokeUsageLink();
  const [copied, setCopied] = useState(false);

  if (link.isError) return null;
  const url = link.data?.path ? `${window.location.origin}${link.data.path}` : null;

  return (
    <SettingsCard
      icon={<IconActivity width={18} height={18} />}
      title="AI usage link"
      description="A read-only spend page anyone with the link can open without signing in. Share it deliberately."
      status={<Pill tone={url ? 'good' : 'neutral'}>{url ? 'Live' : 'Off'}</Pill>}
    >
      {url ? (
        <>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-sunk px-3 py-2 text-[12px] text-ink-soft">{url}</code>
            <button
              className="btn-secondary btn-sm"
              onClick={() => {
                navigator.clipboard?.writeText(url).then(
                  () => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2000);
                  },
                  () => setCopied(false),
                );
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <a href={url} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">Open</a>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <button className="btn-ghost btn-sm" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
              {rotate.isPending ? 'Replacing…' : 'Replace link'}
            </button>
            <button className="btn-ghost btn-sm text-crit hover:text-crit" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
              {revoke.isPending ? 'Turning off…' : 'Turn off'}
            </button>
            <span className="text-[11.5px] text-ink-faint">The old link stops working immediately.</span>
          </div>
        </>
      ) : (
        <button className="btn-primary btn-sm" disabled={rotate.isPending || link.isLoading} onClick={() => rotate.mutate()}>
          {rotate.isPending ? 'Creating…' : 'Create a link'}
        </button>
      )}
      <ErrorLine error={(rotate.error ?? revoke.error) as Error | null} />
    </SettingsCard>
  );
}

/**
 * Microsoft Clarity — session replays and heatmaps of the team's own use of
 * the app, for whoever runs the studio. Admin-only: this card is only reached
 * from the Studio tab, which answers 403 to anyone who cannot change settings.
 * To the people being recorded there is no sign of it; the tag loads silently
 * once an id is set and left on.
 */
function ClarityCard() {
  const settings = useClaritySettings();
  const save = useSaveClaritySettings();
  const [draft, setDraft] = useState<string | null>(null);

  if (settings.isError) return null;
  const data = settings.data;
  const projectId = draft ?? data?.projectId ?? '';
  const dirty = draft !== null && draft.trim() !== (data?.projectId ?? '');
  const on = Boolean(data?.enabled && data?.projectId);

  return (
    <SettingsCard
      className="lg:col-span-2"
      icon={<IconActivity width={18} height={18} />}
      title="Session recording"
      description="Microsoft Clarity records how the team moves through the app — replays and heatmaps, in your Clarity dashboard. It is not shown to anyone being recorded."
      status={<Pill tone={on ? 'good' : 'neutral'}>{on ? 'Recording' : 'Off'}</Pill>}
    >
      {!data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <FieldLabel htmlFor="clarity-project">Clarity project ID</FieldLabel>
            <div className="flex items-center gap-2">
              <input
                id="clarity-project"
                className="input w-full"
                placeholder="e.g. abcd1234ef"
                autoComplete="off"
                spellCheck={false}
                value={projectId}
                disabled={save.isPending}
                onChange={(e) => setDraft(e.target.value)}
              />
              {dirty && (
                <button
                  className="btn-primary btn-sm shrink-0"
                  disabled={save.isPending}
                  onClick={() =>
                    save.mutate(
                      { projectId: (draft ?? '').trim() },
                      { onSuccess: () => setDraft(null) },
                    )
                  }
                >
                  {save.isPending ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
            <Hint>
              From clarity.microsoft.com → your project → Settings → Overview. Session data is stored by Microsoft, not in this app.
            </Hint>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-line bg-sunk/40 p-3">
            <Switch
              checked={on}
              disabled={save.isPending || !data.projectId}
              label="Record sessions"
              onChange={(next) => save.mutate({ enabled: next })}
            />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">Record sessions</div>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-soft">
                {!data.projectId
                  ? 'Add a project ID first.'
                  : on
                    ? 'Every signed-in session is recorded and labelled with who it is.'
                    : 'Switched off — nothing loads, the ID is kept.'}
              </p>
            </div>
          </div>
        </div>
      )}
      <ErrorLine error={save.error as Error | null} />
    </SettingsCard>
  );
}

function DriveFilingCard() {
  const settings = useDriveFilingSettings();
  const save = useSaveDriveFilingSettings();
  const [draft, setDraft] = useState<string | null>(null);

  if (settings.isError) return null;
  const data = settings.data;
  const sendersText = (list: string[]) => list.join(', ');
  const senders = draft ?? (data ? sendersText(data.senders) : '');
  const dirty = draft !== null && draft.trim() !== (data ? sendersText(data.senders) : '');
  const canWrite = Boolean(data?.canWrite);
  const on = Boolean(data?.enabled);

  const saveSenders = () =>
    save.mutate(
      { senders: (draft ?? '').split(',').map((s) => s.trim()).filter(Boolean) },
      { onSuccess: () => setDraft(null) },
    );

  return (
    <SettingsCard
      className="lg:col-span-2"
      icon={<IconDoc width={18} height={18} />}
      title="Document filing"
      description="Files PDF attachments from the people you choose into a tidy Google Drive tree — Purchasing and Accounting, by project — named by vendor, PO and date. It only touches folders it creates; your existing Drive is never changed."
      status={<Pill tone={on ? 'good' : 'neutral'}>{on ? 'Filing' : 'Off'}</Pill>}
    >
      {!data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <FieldLabel htmlFor="filing-senders">Whose attachments to file</FieldLabel>
            <div className="flex items-center gap-2">
              <input
                id="filing-senders"
                className="input w-full"
                placeholder="adeleigh@…, carissa@…"
                autoComplete="off"
                spellCheck={false}
                value={senders}
                disabled={save.isPending}
                onChange={(e) => setDraft(e.target.value)}
              />
              {dirty && (
                <button className="btn-primary btn-sm shrink-0" disabled={save.isPending} onClick={saveSenders}>
                  {save.isPending ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
            <Hint>Email addresses, comma-separated. Only attachments from these senders are filed.</Hint>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-line bg-sunk/40 p-3">
            <Switch
              checked={on}
              disabled={save.isPending || !canWrite}
              label="File documents"
              onChange={(next) => save.mutate({ enabled: next })}
            />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">File documents</div>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-soft">
                {!canWrite
                  ? 'Reconnect Google to grant Drive filing access first — Settings → Integrations → reconnect Drive. Until then nothing is written.'
                  : on
                    ? 'New attachment PDFs are filed into Drive at the end of each email pass.'
                    : 'Switched off — nothing is written to Drive.'}
              </p>
            </div>
          </div>
        </div>
      )}
      <ErrorLine error={save.error as Error | null} />
    </SettingsCard>
  );
}

type SyncPreset = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

const SYNC_PRESETS: { id: SyncPreset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'Last 7 days' },
  { id: 'month', label: 'Last month' },
  { id: 'custom', label: 'Custom range' },
];

/** Matches the server's limit on one sync. */
const MAX_SYNC_DAYS = 92;

const midnight = (d: Date, plusDays = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays);

/** `yyyy-mm-dd` in local time, as a date input reads and writes it. */
function dateValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A date input's value as local midnight — `new Date('yyyy-mm-dd')` is UTC. */
function parseDateValue(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

type SyncWindow = { since: Date; until: Date };

/** The window a choice stands for, or why it cannot be synced. */
function syncWindow(preset: SyncPreset, from: string, to: string): SyncWindow | { error: string } {
  const now = new Date();
  const today = midnight(now);
  switch (preset) {
    case 'today':
      return { since: today, until: now };
    case 'yesterday':
      return { since: midnight(now, -1), until: today };
    case 'week':
      return { since: midnight(now, -6), until: now };
    case 'month':
      return { since: midnight(now, -29), until: now };
    case 'custom': {
      const start = parseDateValue(from);
      const end = parseDateValue(to);
      if (!start || !end) return { error: 'Choose a start and an end date.' };
      if (start > end) return { error: 'The start date must be on or before the end date.' };
      if (start > today) return { error: 'The start date cannot be in the future.' };
      // Inclusive of the end day, and never past this moment.
      const until = midnight(end, 1) > now ? now : midnight(end, 1);
      if (until.getTime() - start.getTime() > MAX_SYNC_DAYS * 86_400_000) {
        return { error: `Choose ${MAX_SYNC_DAYS} days or fewer.` };
      }
      return { since: start, until };
    }
  }
}

function describeWindow(w: SyncWindow): string {
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const lastDay = new Date(w.until.getTime() - 1);
  return fmt(w.since) === fmt(lastDay) ? fmt(w.since) : `${fmt(w.since)} – ${fmt(lastDay)}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function syncSummary(r: MailSyncResult): string {
  const parts = [plural(r.emails, 'new email')];
  if (r.tasks) parts.push(plural(r.tasks, 'task'));
  if (r.replies) parts.push(plural(r.replies, 'draft'));
  if (r.documents) parts.push(plural(r.documents, 'document'));
  const read = parts.join(', ');
  if (r.stopped) return `Stopped. ${read} so far — sync again to carry on; nothing is read twice.`;
  if (!r.complete) {
    return `${read}. ${plural(r.unfinishedDays, 'day')} had more mail than one sync reads — run it again to finish.`;
  }
  if (!r.emails) return 'Up to date — nothing new in that period.';
  return `Done — ${read}.`;
}

/**
 * Pull in one's own mail for a chosen period.
 *
 * For everybody, not only a principal: it reads the caller's own Gmail
 * alone. Useful after connecting, after time away, or when a message is
 * known to have arrived and is not in the Inbox yet. Mail already stored is
 * skipped without being read again, so repeating a range is harmless.
 */
function MailSyncCard() {
  const me = useMe();
  const sync = useMailSync();
  const [preset, setPreset] = useState<SyncPreset>('today');
  const today = dateValue(new Date());
  const [from, setFrom] = useState(() => dateValue(midnight(new Date(), -6)));
  const [to, setTo] = useState(today);
  const [progress, setProgress] = useState<MailSyncProgress | null>(null);
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);

  const gmail = me.data?.google?.services?.gmail ?? false;
  const chosen = syncWindow(preset, from, to);
  const invalid = 'error' in chosen ? chosen.error : null;
  const running = sync.isPending;

  const start = () => {
    if ('error' in chosen) return;
    stopRef.current = false;
    setStopping(false);
    setProgress(null);
    sync.mutate(
      { ...chosen, onProgress: setProgress, shouldStop: () => stopRef.current },
      {
        onSettled: () => {
          setProgress(null);
          setStopping(false);
        },
      },
    );
  };

  return (
    <SettingsCard
      className="lg:col-span-2"
      icon={<IconInbox width={18} height={18} />}
      title="Sync my email"
      description="Bring your own Gmail into the studio for a chosen period. Mail already here is skipped, so syncing a period twice is harmless."
      status={<Pill tone={gmail ? 'good' : 'neutral'}>{gmail ? 'Gmail connected' : 'Gmail not connected'}</Pill>}
    >
      {!me.data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : !gmail ? (
        <p className="text-[13px] text-ink-soft">Connect Gmail above, then choose a period to sync.</p>
      ) : (
        <>
          <div role="radiogroup" aria-label="Period to sync" className="flex flex-wrap gap-1.5">
            {SYNC_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={preset === p.id}
                disabled={running}
                onClick={() => setPreset(p.id)}
                className={`focusable rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-60 ${
                  preset === p.id
                    ? 'border-brass/50 bg-brass/15 text-ink'
                    : 'border-line text-ink-soft hover:bg-sunk hover:text-ink'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {preset === 'custom' && (
            <div className="mt-3">
              <FieldLabel htmlFor="sync-range">Dates</FieldLabel>
              <DateRangePicker
                id="sync-range"
                value={{ from: parseDateValue(from), to: parseDateValue(to) }}
                max={new Date()}
                maxDays={MAX_SYNC_DAYS}
                disabled={running}
                defaultOpen
                onChange={(r) => {
                  setFrom(dateValue(r.from));
                  setTo(dateValue(r.to));
                }}
              />
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {running ? (
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={stopping}
                onClick={() => {
                  stopRef.current = true;
                  setStopping(true);
                }}
              >
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            ) : (
              <button type="button" className="btn-primary btn-sm" disabled={Boolean(invalid)} onClick={start}>
                Sync email
              </button>
            )}
            <span className={`text-[12px] ${invalid ? 'text-crit' : 'text-ink-faint'}`}>
              {invalid ?? describeWindow(chosen as SyncWindow)}
            </span>
          </div>

          {running && (
            <p className="mt-2 text-[12.5px] text-ink-soft" aria-live="polite">
              {progress
                ? `Reading ${progress.current.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` +
                  (progress.days > 1 ? ` (day ${progress.day} of ${progress.days})` : '') +
                  ` · ${progress.emails} new so far`
                : 'Starting…'}
            </p>
          )}
          {!running && sync.data && (
            <p className="mt-2 text-[12.5px] text-ink-soft" aria-live="polite">
              {syncSummary(sync.data)}
            </p>
          )}
          <Hint>Only your own mailbox is read. Longer periods take a few minutes — keep this page open until it finishes.</Hint>
        </>
      )}
      {!running && <ErrorLine error={sync.error as Error | null} />}
    </SettingsCard>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.2c0-.6-.1-1.3-.2-1.9H12v3.6h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.2Z" />
      <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14Z" />
      <path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1Z" />
    </svg>
  );
}

function GoogleCard() {
  const me = useMe();
  const connectAll = useConnectGoogle();
  const disconnect = useDisconnectGoogle();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const google = me.data?.google;
  const gmail = google?.services?.gmail ?? false;
  const drive = google?.services?.drive ?? false;
  const anyConnected = gmail || drive;
  // Connected on paper, but Google has REFUSED the grant — reading has stopped
  // and no "Connected" badge should pretend otherwise. This is why the card
  // read "Fully connected" while Jenny said the opposite: the badge followed
  // the stored status, not whether Google still accepts the grant.
  const refused = Boolean(google?.needs_reconnect);

  return (
    <SettingsCard
      className="lg:col-span-2"
      icon={<GoogleMark />}
      title="Google Workspace"
      description="Gmail and Drive, together or separately. Read-only, plus drafts in Gmail. Revocable any time."
      status={
        refused ? (
          <Pill tone="crit">Needs reconnecting</Pill>
        ) : (
          <Pill tone={gmail && drive ? 'good' : anyConnected ? 'warn' : 'neutral'}>
            {gmail && drive ? 'Fully connected' : anyConnected ? 'Partially connected' : 'Not connected'}
          </Pill>
        )
      }
    >
      {refused && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-crit/30 bg-crit/10 px-3 py-2.5">
          <span className="text-[12.5px] leading-snug text-crit">
            Google has stopped accepting this connection, so nothing new is being read. Reconnect to start it again.
          </span>
          <button
            onClick={() => connectAll.mutate('all')}
            disabled={connectAll.isPending}
            className="btn-primary btn-sm shrink-0"
          >
            {connectAll.isPending && connectAll.variables === 'all' ? 'Redirecting…' : 'Reconnect Google'}
          </button>
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <ServiceCard
          service="gmail"
          title="Gmail"
          blurb="Reads project mail, classifies it, writes reply drafts."
          connected={gmail}
          everConnected={anyConnected}
          Mark={GmailMark}
          scopes={[
            { name: 'gmail.readonly', note: 'read messages' },
            { name: 'gmail.compose', note: 'drafts only — never sends' },
          ]}
        />
        <ServiceCard
          service="drive"
          title="Google Drive"
          blurb="Finds PDF quotes and order confirmations."
          connected={drive}
          everConnected={anyConnected}
          Mark={DriveMark}
          scopes={[
            { name: 'drive.readonly', note: 'list and download files' },
            { name: 'drive.file', note: 'create & manage only files Jenny makes' },
          ]}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3">
        <span className="text-[12px] text-ink-faint">
          {google?.connected_at
            ? `Last connected ${new Date(google.connected_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
            : 'Nothing connected yet.'}
        </span>
        <div className="flex items-center gap-1.5">
          {!(gmail && drive) && (
            <button onClick={() => connectAll.mutate('all')} disabled={connectAll.isPending} className="btn-secondary btn-sm">
              {connectAll.isPending && connectAll.variables === 'all' ? 'Redirecting…' : 'Connect both'}
            </button>
          )}
          {anyConnected && !confirmDisconnect && (
            <button onClick={() => setConfirmDisconnect(true)} className="btn-ghost btn-sm text-crit hover:text-crit">
              Disconnect Google
            </button>
          )}
          {anyConnected && confirmDisconnect && (
            <div className="flex items-center gap-2 rounded-lg border border-crit/30 bg-crit/10 px-2.5 py-1">
              <span className="text-[12px] text-crit">Revoke Gmail and Drive?</span>
              <button
                onClick={() => disconnect.mutate(undefined, { onSettled: () => setConfirmDisconnect(false) })}
                disabled={disconnect.isPending}
                className="btn btn-sm bg-crit text-white hover:opacity-90"
              >
                {disconnect.isPending ? 'Revoking…' : 'Disconnect'}
              </button>
              <button onClick={() => setConfirmDisconnect(false)} className="btn-ghost btn-sm">
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
      <ErrorLine error={disconnect.error as Error | null} />
    </SettingsCard>
  );
}

function AppearanceCard() {
  const { theme, setTheme } = useTheme();
  return (
    <SettingsCard icon={<IconSun width={18} height={18} />} title="Appearance" description="A theme, or follow your system.">
      <div className="flex rounded-lg bg-sunk p-1">
        {(['system', 'light', 'dark'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTheme(t)}
            className={`focusable flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium capitalize transition-colors ${
              theme === t ? 'bg-surface text-ink shadow-card' : 'text-ink-soft hover:text-ink'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
    </SettingsCard>
  );
}

type SettingsTab = 'connections' | 'slack' | 'ai' | 'studio' | 'team' | 'permissions' | 'logins' | 'account';

/**
 * Who sees a tab. `settings` — the principal-only sections, whose cards answer
 * 403 to anybody else. `team` — Team & roles, for whoever may change the roster
 * (the same test the menu used before it moved here). `owner` — Permissions,
 * the principal's alone whatever the matrix says: it is the module that grants
 * every other one. `audit` — Login history, on the same supervisor test the
 * audit trail uses: it carries addresses and devices.
 */
type TabAccess = 'everyone' | 'settings' | 'team' | 'owner' | 'audit';

const TABS: { id: SettingsTab; label: string; Icon: (p: { width?: number; height?: number }) => JSX.Element; access: TabAccess }[] = [
  { id: 'connections', label: 'Connections', Icon: IconInbox, access: 'everyone' },
  { id: 'slack', label: 'Slack', Icon: IconBell, access: 'settings' },
  { id: 'ai', label: 'AI', Icon: IconAssistant, access: 'settings' },
  { id: 'studio', label: 'Studio', Icon: IconBell, access: 'settings' },
  { id: 'team', label: 'Team & Roles', Icon: IconTeam, access: 'team' },
  { id: 'permissions', label: 'Permissions', Icon: IconKey, access: 'owner' },
  { id: 'logins', label: 'Login history', Icon: IconActivity, access: 'audit' },
  { id: 'account', label: 'Account', Icon: IconPerson, access: 'everyone' },
];

export default function Settings() {
  const { may, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const flash = googleFlash();
  const queryClient = useQueryClient();

  // Coming back from Google consent, the cards read `me.google`, which the
  // query already holds from before the round trip. A same-tab return from
  // the OAuth redirect is sometimes served without a fresh fetch (bfcache, or
  // the popup's opener keeping its in-memory cache), so the banner said
  // "connected" while the cards still read "Not connected". Re-read `me` the
  // moment we land back with a Google result so the cards reflect the truth.
  const googleResult = params.get('google');
  useEffect(() => {
    if (!googleResult) return;
    // The connection pills read `me`; the Document-filing toggle reads
    // `drive-filing-settings` (its `canWrite` flips only once Drive is
    // reconnected with the `drive.file` scope). Refetch both so a reconnect
    // is reflected without a hard refresh.
    void queryClient.invalidateQueries({ queryKey: ['me'] });
    void queryClient.invalidateQueries({ queryKey: ['drive-filing-settings'] });
  }, [googleResult, queryClient]);

  // Sections a person cannot use are hidden rather than shown empty.
  const allowed: Record<TabAccess, boolean> = {
    everyone: true,
    settings: may('settings', 'update'),
    team: may('team', 'update'),
    owner: user?.role === 'principal',
    audit: canSupervise(user?.role ?? null),
  };
  const tabs = TABS.filter((t) => allowed[t.access]);
  const asked = params.get('tab') as SettingsTab | null;
  // Coming back from Google always lands on Connections, where the result is.
  const tab: SettingsTab =
    params.get('google') ? 'connections' : tabs.some((t) => t.id === asked) ? (asked as SettingsTab) : 'connections';

  const choose = (next: SettingsTab) => {
    const p = new URLSearchParams(params);
    p.set('tab', next);
    p.delete('google');
    p.delete('service');
    setParams(p, { replace: true });
  };

  return (
    <Page>
      <PageHeading title="Settings" />

      {flash && (
        <div
          className={`rounded-lg border px-4 py-2.5 text-[13px] ${
            flash.tone === 'good' ? 'border-good/30 bg-good/10 text-good' : 'border-crit/30 bg-crit/10 text-crit'
          }`}
        >
          {flash.text}
        </div>
      )}

      <div role="tablist" aria-label="Settings sections" className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => choose(id)}
            className={`focusable flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors ${
              tab === id ? 'bg-brass/15 text-ink shadow-card' : 'text-ink-soft hover:bg-sunk hover:text-ink'
            }`}
          >
            <Icon width={16} height={16} />
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {tab === 'connections' && (
          <>
            <GoogleCard />
            <MailSyncCard />
            <EmailReadingCard />
          </>
        )}

        {tab === 'slack' && <SlackSetupCard />}

        {tab === 'ai' && (
          <>
            <AiSetupCard />
            <AiRoutingCard />
            <PictureProviderCard />
            <OpenAiSetupCard />
          </>
        )}

        {tab === 'studio' && (
          <>
            <ChasingCard />
            <AiUsageLinkCard />
            <ClarityCard />
            <DriveFilingCard />
          </>
        )}

        {tab === 'account' && (
          <>
            <AppearanceCard />
            <PasswordCard />
          </>
        )}
      </div>

      {/* Full width, below the card grid: both are whole screens of their own. */}
      {tab === 'team' && <Team />}
      {tab === 'permissions' && <Permissions />}
      {tab === 'logins' && <LoginHistory />}
    </Page>
  );
}
