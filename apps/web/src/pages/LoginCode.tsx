import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BrandLogo } from '../components/BrandLogo';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';

interface SendResult {
  required: boolean;
  to: string;
  resendIn?: number;
}

/**
 * The emailed code after signing in, with Google or with a password.
 *
 * Shown in place of the app until the code is entered. The first code goes
 * out as the screen opens; the server keeps the same one if the page is
 * reloaded within a minute, so a reload does not flood the inbox.
 */
export default function LoginCode() {
  const { refresh, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Where they were going, for after the code. The Google round trip lands
  // on "/#", so that is the usual answer.
  const backTo = useRef('/');
  const [to, setTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [sending, setSending] = useState(false);
  const sentOnce = useRef(false);

  const send = async (again: boolean) => {
    setError(null);
    setNote(null);
    setSending(true);
    try {
      const r = await api<SendResult>('/login-code/send', { method: 'POST', body: '{}' });
      if (!r.required) {
        navigate(backTo.current, { replace: true });
        return void (await refresh());
      }
      setTo(r.to);
      setWait(r.resendIn ?? 60);
      if (again) setNote('A new code is on its way. Only the newest code works.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    // Its own address, and the "#" left by the Google round trip goes with it.
    if (location.pathname !== '/verify-code') {
      backTo.current = `${location.pathname}${location.search}`;
      navigate('/verify-code', { replace: true });
    }
    if (sentOnce.current) return;
    sentOnce.current = true;
    void send(false);
    // Sent once, as the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await api<{ verified: boolean }>('/login-code/verify', { method: 'POST', body: JSON.stringify({ code }) });
      navigate(backTo.current, { replace: true });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-1">
          <BrandLogo className="h-24 text-ink" />
          <div className="text-center text-[12px] text-ink-faint">Workflow System</div>
        </div>

        <form onSubmit={submit} className="card space-y-3 p-7">
          <h1 className="text-[20px] font-bold text-ink">Check your email</h1>
          <p className="!mt-1 text-[13px] text-ink-soft">
            {to ? `We sent a 6-digit code to ${to}. It expires in 10 minutes.` : 'Sending your sign-in code…'}
          </p>

          <input
            className="input w-full text-center text-[20px] tracking-[0.4em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            placeholder="000000"
            aria-label="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />

          {error && <p className="rounded-lg bg-crit/10 px-3 py-2 text-[12.5px] text-crit">{error}</p>}
          {note && <p className="rounded-lg bg-good/10 px-3 py-2 text-[12.5px] text-good">{note}</p>}

          <button type="submit" disabled={busy || code.length !== 6} className="btn-primary w-full">
            {busy ? 'Checking…' : 'Continue'}
          </button>

          <button type="button" disabled={wait > 0 || sending} onClick={() => void send(true)} className="btn-ghost btn-sm w-full">
            {sending ? 'Sending…' : wait > 0 ? `Send a new code in ${wait}s` : 'Send a new code'}
          </button>

          <button
            type="button"
            onClick={() => {
              navigate('/', { replace: true });
              void signOut();
            }}
            className="btn-ghost btn-sm w-full"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
