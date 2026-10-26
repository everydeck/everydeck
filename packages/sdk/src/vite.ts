/**
 * @everydeck/sdk/vite: source maps for browser errors in a Vite build, a thin wrapper around `@everydeck/sdk/sourcemaps` (the same code as
 * `everydeck-agent sourcemaps inject|upload`), like Sentry's Vite plugin.
 *
 *   import { everydeckSourceMaps } from '@everydeck/sdk/vite';
 *   export default defineConfig({ plugins: [react(), everydeckSourceMaps()] });
 *
 * In `vite build` it turns on source maps without the `sourceMappingURL` comment (`build.sourcemap: 'hidden'`, unless the config sets them),
 * gives every built file a debug id, uploads the maps with the key that can only upload source maps and removes them from the output folder, also
 * without a key or when the upload failed: the maps are never public. The build itself never fails because of everydeck. `vite dev` is unchanged.
 *
 *   everydeckSourceMaps({ url: 'https://everydeck.example' })
 *
 * The key only from `EVERYDECK_SOURCEMAPS_KEY`, in the build's environment or the app's env files the way Vite reads them (envDir, mode); never
 * with a public prefix: when it stands under `VITE_` (or the config's envPrefix, `NEXT_PUBLIC_`, `PUBLIC_`, `EXPO_PUBLIC_`, `REACT_APP_`), nothing is
 * uploaded. The address: `url`, else `EVERYDECK_URL`.
 */
import { resolve } from 'node:path';
import { injectDebugIds, removeSourceMaps, uploadSourceMaps, uploadTarget, type UploadResult, type UploadTarget } from './sourcemaps.js';

export interface EverydeckSourceMapsOptions {
  /** the everydeck address (public); default `EVERYDECK_URL` */
  url?: string;
  /** address and key given directly (tests); default: `url` and `EVERYDECK_SOURCEMAPS_KEY` */
  target?: UploadTarget | null;
  /** passed to the upload (tests) */
  fetch?: typeof fetch;
  /** called with the result of each upload (default: one line on the console) */
  onResult?: (r: UploadResult & { injected: number }) => void;
}
interface ViteConfigLike { build?: { sourcemap?: boolean | 'inline' | 'hidden'; ssr?: unknown; outDir?: string } }
interface ResolvedConfigLike { root: string; mode?: string; envDir?: string | false; envPrefix?: string | string[]; build: { outDir: string; ssr?: unknown } }

export function everydeckSourceMaps(o: EverydeckSourceMapsOptions = {}) {
  let outDir: string | null = null; let envAt = { cwd: process.cwd(), mode: 'production', prefixes: [] as string[] };
  const report = o.onResult ?? ((r: UploadResult & { injected: number }) => {
    const line = r.ok ? `[everydeck] ${r.uploaded.length} source map(s) uploaded (build ${r.build}), ${r.removed.length} removed from the output`
      : `[everydeck] source maps not uploaded: ${r.reason ?? r.failed.map((f) => `${f.file}: ${f.status ?? ''} ${f.error}`).join('; ')}; ${r.removed.length} removed from the output`;
    process.stderr.write(`${line}\n`);
  });
  return {
    name: 'everydeck-sourcemaps',
    apply: 'build' as const,
    enforce: 'post' as const,
    config(c: ViteConfigLike) { return c.build?.sourcemap || c.build?.ssr ? undefined : { build: { sourcemap: 'hidden' as const } }; },
    configResolved(c: ResolvedConfigLike) {
      outDir = c.build.ssr ? null : resolve(c.root, c.build.outDir);
      envAt = { cwd: c.envDir === false ? c.root : resolve(c.root, c.envDir ?? '.'), mode: c.mode ?? 'production', prefixes: c.envPrefix === undefined ? [] : Array.isArray(c.envPrefix) ? c.envPrefix : [c.envPrefix] };
    },
    async closeBundle() {
      if (!outDir) return;
      try {
        const inj = injectDebugIds(outDir);
        const target = o.target !== undefined ? o.target : uploadTarget(process.env, { url: o.url, cwd: envAt.cwd, mode: envAt.mode, publicPrefixes: envAt.prefixes });
        const r = await uploadSourceMaps(outDir, target, o.fetch ? { fetch: o.fetch } : {});
        report({ ...r, injected: inj.injected.length });
      } catch (e) {
        // never public, also when something above failed
        let removed = 0; try { removed = removeSourceMaps(outDir).length; } catch { /* nothing to remove */ }
        process.stderr.write(`[everydeck] source maps not uploaded: ${(e as Error).message}; ${removed} removed from the output\n`);
      }
    },
  };
}
