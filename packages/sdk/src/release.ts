/**
 * B15/C5 – Automatische Versionskennung (Node). Dieselbe Regel gilt für das Python-SDK und `everydeck-agent version`, damit eine gemeldete
 * Reparatur und die beobachtete Laufzeitfassung verglichen werden können (docs/05 „Reparatur als belegbarer Ablauf“):
 *   1. `EVERYDECK_RELEASE_KEY` (außer „auto“) – ausdrücklich gesetzt, unverändert
 *   2. Commit der Bereitstellung aus der CI-/Hosting-Umgebung → `git:<sha12>`
 *   3. lokales Git: `git:<sha12>` bzw. mit lokalen Änderungen `git:<sha12>+dirty.<hash8>` (Hash über `git diff HEAD` und nicht ignorierte neue Dateien)
 *   4. sonst `unknown` – everydeck kann dann keine Fassungen vergleichen und sagt das.
 * Kein Commit ist nötig, damit eine geänderte Fassung als neue Kennung erscheint; der Wert wird beim Start berechnet.
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
    // neue, nicht ignorierte Dateien zählen mit (Pfad + Inhalt); Laufzeitdateien gehören in die Ignore-Regeln der App
    const untracked = git('ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean).sort();
    for (const f of untracked) { h.update(`\0${f}\0`); try { h.update(readFileSync(join(top, f))); } catch { /* entfernt während der Berechnung */ } }
    const dirty = untracked.length > 0 || git('status', '--porcelain', '--untracked-files=no').toString().trim().length > 0;
    return dirty ? `git:${head}+dirty.${h.digest('hex').slice(0, 8)}` : `git:${head}`;
  } catch { return 'unknown'; }
}
