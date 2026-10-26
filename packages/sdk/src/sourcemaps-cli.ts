#!/usr/bin/env node
/**
 * everydeck-sourcemaps: the two commands after a build with any bundler other than Vite (Next.js, webpack, esbuild, Rollup, Parcel), the same code as
 * the Vite plugin and `everydeck-agent sourcemaps`:
 *
 *   npx everydeck-sourcemaps inject <output folder>   gives every built .js file with a source map a debug id
 *   npx everydeck-sourcemaps upload <output folder> [--url <everydeck address>] [--mode <mode>]
 *                                                     uploads the maps with the key that can only upload source maps (EVERYDECK_SOURCEMAPS_KEY in
 *                                                     the build's environment or the app's env files .env, .env.local, .env.<mode>, .env.<mode>.local
 *                                                     in the current folder; mode production by default), then removes every .js source map from
 *                                                     the folder. The address: --url, else EVERYDECK_URL. With the key under a public name (VITE_,
 *                                                     NEXT_PUBLIC_, PUBLIC_, EXPO_PUBLIC_, REACT_APP_) nothing is uploaded.
 *
 * Like the Vite plugin it never fails the build because of everydeck: without a key, or when the upload failed, it prints why and exits 0 (the maps
 * are removed all the same). Exit 2 only for a wrong command. Output is one JSON line on stdout.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { injectDebugIds, removeSourceMaps, uploadSourceMaps, uploadTarget } from './sourcemaps.js';

export async function sourceMapsCli(argv: string[], env: Record<string, string | undefined> = process.env, o: { fetch?: typeof fetch; cwd?: string } = {}): Promise<{ code: number; out: Record<string, unknown> }> {
  const flags: Record<string, string> = {}; const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i]!; if (a === '--url' || a === '--mode') { const v = argv[++i]; if (!v) return { code: 2, out: { ok: false, error: `${a} needs a value` } }; flags[a.slice(2)] = v; } else pos.push(a); }
  const [sub, dir] = pos;
  if ((sub !== 'inject' && sub !== 'upload') || !dir) return { code: 2, out: { ok: false, error: 'usage: everydeck-sourcemaps inject|upload <output folder> [--url <everydeck address>] [--mode <mode>]' } };
  if (flags['url'] !== undefined && !/^https?:\/\/[^\s]+$/.test(flags['url'])) return { code: 2, out: { ok: false, error: '--url must be the everydeck address (http or https)' } };
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) return { code: 2, out: { ok: false, error: `${root} is not a folder` } };
  if (sub === 'inject') { const r = injectDebugIds(root); return { code: 0, out: { ok: true, injected: r.injected, skipped: r.skipped } }; }
  try { const r = await uploadSourceMaps(root, uploadTarget(env, { url: flags['url'], mode: flags['mode'], cwd: o.cwd ?? process.cwd() }), o.fetch ? { fetch: o.fetch } : {}); return { code: 0, out: { ...r } }; }
  catch (e) { let removed: string[] = []; try { removed = removeSourceMaps(root); } catch { /* nothing to remove */ } return { code: 0, out: { ok: false, reason: (e as Error).message, removed } }; }   // never public
}

if (process.argv[1] && /everydeck-sourcemaps|sourcemaps-cli\.js$/.test(process.argv[1])) {
  sourceMapsCli(process.argv.slice(2)).then(({ code, out }) => { process.stdout.write(`${JSON.stringify(out)}\n`); process.exitCode = code; },
    (e: unknown) => { process.stdout.write(`${JSON.stringify({ ok: false, error: (e as Error).message })}\n`); process.exitCode = 0; });
}
