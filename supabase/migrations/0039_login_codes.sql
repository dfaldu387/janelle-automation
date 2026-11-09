-- Sign-in codes for Google sign-ins.
--
-- After "Continue with Google" the API emails a 6-digit code, and the app
-- stays closed until it is entered. Asked of Google sign-ins only, by the
-- studio's choice; password sign-ins are not asked. Switched on with
-- LOGIN_CODE_GOOGLE=true on the API, so this migration can run first and
-- change nothing until then.
--
-- Proof is per session. Supabase gives every sign-in its own session_id
-- (carried in the access token), so a new sign-in on any device is a new
-- session and needs a new code.
--
-- Only the API's service key touches these tables: RLS is on with no
-- policies, so no browser can read a code hash or mark itself verified.

create table if not exists login_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  session_id  uuid not null,
  -- HMAC of the session and the code. The code itself is never stored.
  code_hash   text not null,
  attempts    integer not null default 0,
  expires_at  timestamptz not null,
  -- Set when the code is accepted, or when a newer code replaces it.
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists idx_login_codes_session
  on login_codes(session_id, created_at desc);

create table if not exists verified_sessions (
  session_id  uuid primary key,
  user_id     uuid not null references profiles(id) on delete cascade,
  verified_at timestamptz not null default now()
);

alter table login_codes enable row level security;
alter table verified_sessions enable row level security;
