/**
 * Automatic release key (Node). The same rule applies to the Python SDK and `everydeck-agent version`, so that a reported
 * repair and the observed running version can be compared:
 *   1. `EVERYDECK_RELEASE_KEY` (except "auto"): set explicitly, used unchanged
 *   2. deployment commit from the CI or hosting environment → `git:<sha12>`
 *   3. local git: `git:<sha12>`, or with local changes `git:<sha12>+dirty.<hash8>` (hash over `git diff HEAD` and new files that are not ignored)
 *   4. otherwise `unknown`: everydeck then cannot compare versions and says so.
 * No commit is needed for a changed version to show up as a new key; the value is computed at startup.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const COMMIT_ENV = ['GITHUB_SHA', 'VERCEL_GIT_COMMIT_SHA', 'RENDER_GIT_COMMIT', 'CF_PAGES_COMMIT_SHA', 'COMMIT_REF', 'SOURCE_VERSION', 'CI_COMMIT_SHA'] as const;

export function resolveReleaseKey(opts: { env?: Record<string, string | undefined>; cwd?: string } = {}): string {
  const env = opts.env ?? process.env;
  const explicit = env['EVERYDECK_RELEASE_KEY'];
  if (explicit && explicit !== 'auto') return explicit.slice(0, 128);
  for (const k of COMMIT_ENV) { const v = env[k]; if (v && /^[0-9a-f]{7,64}$/i.test(v)) return `git:${v.toLowerCase().slice(0, 12)}`; }
  const cwd = opts.cwd ?? process.cwd();
  const run = (dir: string, ...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  try {
    const top = run(cwd, 'rev-parse', '--show-toplevel').toString().trim();
    const git = (...a: string[]) => run(top, ...a);
    const head = git('rev-parse', 'HEAD').toString().trim().slice(0, 12);
    const h = createHash('sha256');
    h.update(git('diff', 'HEAD', '--binary'));
    // new files that are not ignored count too (path + content); runtime files belong in the app's ignore rules
    const untracked = git('ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean).sort();
    for (const f of untracked) { h.update(`\0${f}\0`); try { h.update(readFileSync(join(top, f))); } catch { /* removed during the computation */ } }
    const dirty = untracked.length > 0 || git('status', '--porcelain', '--untracked-files=no').toString().trim().length > 0;
    return dirty ? `git:${head}+dirty.${h.digest('hex').slice(0, 8)}` : `git:${head}`;
  } catch { return 'unknown'; }
}
