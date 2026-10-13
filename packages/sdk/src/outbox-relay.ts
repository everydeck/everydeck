#!/usr/bin/env node
/**
 * `npx everydeck-outbox-relay`: the outbox relay as a separate process of the app, for plain PostgreSQL without pg_cron and Edge Functions.
 * Needs the app's `pg` package. Settings come from the environment (never from code):
 *   EVERYDECK_OUTBOX_DATABASE_URL  database with outbox/everydeck_outbox.sql (a role that may read, update and delete everydeck_outbox.event)
 *   EVERYDECK_ENDPOINT, EVERYDECK_SERVER_KEY, EVERYDECK_RELEASE_KEY, EVERYDECK_MANIFEST_DIGEST
 *   EVERYDECK_OUTBOX_INTERVAL_SECONDS (default 5, keeps the delay under 10 s), EVERYDECK_OUTBOX_HEARTBEAT_SECONDS (default 60: the job heartbeat)
 * Usage: everydeck-outbox-relay [--once]
 */
import { OUTBOX_JOB, relayOnce, type RelayOptions } from './outbox.js';

type Pool = { query: (text: string, params?: unknown[]) => Promise<unknown>; end: () => Promise<void> };
const proc = (globalThis as unknown as { process: { env: Record<string, string | undefined>; argv: string[]; exit: (code: number) => never; on: (ev: string, fn: () => void) => void } }).process;
const env = (n: string, d?: string): string => { const v = proc.env[n]; if (v === undefined || v === '') { if (d !== undefined) return d; console.error(`[everydeck-outbox] ${n} is not set`); proc.exit(2); } return v as string; };
const pgName = 'pg';
const { default: pg } = await import(pgName) as { default: { Pool: new (o: { connectionString: string; max: number }) => Pool } };
const pool = new pg.Pool({ connectionString: env('EVERYDECK_OUTBOX_DATABASE_URL'), max: 1 });
const interval = Number(env('EVERYDECK_OUTBOX_INTERVAL_SECONDS', '5'));
const beatEvery = Number(env('EVERYDECK_OUTBOX_HEARTBEAT_SECONDS', '60'));
const opts: RelayOptions = { query: (text, params) => pool.query(text, params), endpoint: env('EVERYDECK_ENDPOINT'), credential: env('EVERYDECK_SERVER_KEY'), releaseKey: env('EVERYDECK_RELEASE_KEY'), manifestDigest: env('EVERYDECK_MANIFEST_DIGEST'), job: env('EVERYDECK_OUTBOX_JOB', OUTBOX_JOB), intervalSeconds: beatEvery, instanceId: env('EVERYDECK_OUTBOX_INSTANCE_ID', 'everydeck-outbox-relay') };

let lastBeat = 0;
const once = async () => {
  // deliver on every tick; the job heartbeat at most once per beatEvery
  const beat = Date.now() - lastBeat >= beatEvery * 1000;
  try { const r = await relayOnce({ ...opts, heartbeat: beat }); if (r.heartbeat) lastBeat = Date.now(); if (r.sent || r.rejected || r.heartbeat || r.status !== 'ok') console.log(JSON.stringify({ at: new Date().toISOString(), ...r })); return r; }
  catch (e) { console.error(`[everydeck-outbox] run failed: ${e instanceof Error ? e.message : String(e)}`); return null; }
};
if (proc.argv.includes('--once')) { const r = await once(); await pool.end(); proc.exit(r?.status === 'ok' ? 0 : 1); }
let stopping = false;
const stop = async () => { stopping = true; await pool.end().catch(() => {}); proc.exit(0); };
proc.on('SIGTERM', () => { void stop(); }); proc.on('SIGINT', () => { void stop(); });
while (!stopping) { await once(); await new Promise((r) => setTimeout(r, interval * 1000)); }
