// ============================================================
//  Shared guard for scripts/verify/*: refuse to run against the
//  PRODUCTION database. These scripts change settings and write
//  test rows, so they are for the dev Supabase project only.
//
//  Production is recognised by its project ref (from the 2026-11-04
//  backup manifest) and, if set, by PROD_SUPABASE_URL.
// ============================================================
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '../../.env') });

const PRODUCTION_REFS = ['pzvtlydcwhcjbninhpai'];

/** True when .env points at production (or nowhere). */
export function isProductionDb(): boolean {
  const url = (process.env.SUPABASE_URL ?? '').trim();
  const prodUrl = (process.env.PROD_SUPABASE_URL ?? '').trim();
  return (
    !url ||
    PRODUCTION_REFS.some((ref) => url.includes(ref)) ||
    (prodUrl !== '' && url.replace(/\/+$/, '') === prodUrl.replace(/\/+$/, ''))
  );
}

export function assertNotProduction(): void {
  if (isProductionDb()) {
    console.error('✗ Refusing to run: SUPABASE_URL is empty or points at the PRODUCTION database.');
    console.error('  Point .env at the dev Supabase project first (see docs/V2_FASTTRACK_C_D.md).');
    process.exit(1);
  }
  if ((process.env.SCHEDULER ?? '').toLowerCase() !== 'off') {
    console.warn('⚠ SCHEDULER is not "off" in .env. This script does not start the scheduler, but set SCHEDULER=off for local work.');
  }
}

let failures = 0;
export function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
export function skip(name: string, why: string): void {
  console.log(`SKIP  ${name}  — ${why}`);
}
export function failureCount(): number {
  return failures;
}
