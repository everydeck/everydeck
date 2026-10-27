/**
 * Release step 3: the package test. It installs the built package into an empty folder (npm) or a fresh virtual environment (PyPI), outside
 * this repository, and uses it the way an app does. Only the files that would be published are tested.
 *   node .github/release/smoke.mjs <sdk | check | py | py-check> <folder with the built package>
 * sdk: every entry point loads, an event reaches a local receiver. check: everydeck-scaffold reads a small app into an app map.
 * py: an event from the Python SDK reaches a local receiver. py-check: everydeck-check validates an app map with the bundled rules.
 * check and py-check also test the pair (a scaffold and a check published apart must not disagree on a single place): the scaffold reads an app
 * with a backend route and a request path with a parameter, and everydeck-check checks every place it wrote; the other half comes from this repository
 * (packages/everydeck-check, packages/check; EVERYDECK_PAIR_SOURCE overrides the folder).
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const [key, dist] = process.argv.slice(2);
if (!key || !dist) { console.error('usage: node smoke.mjs <sdk | check | py | py-check> <folder with the built package>'); process.exit(2); }
const fail = (msg) => { console.log(`::error title=Package test::${msg}`); process.exit(1); };
const one = (re) => { const f = readdirSync(dist).filter((n) => re.test(n)); if (f.length !== 1) fail(`expected one file like ${re} in ${dist}, found ${f.length}`); return resolve(dist, f[0]); };
const sh = (cmd, args, cwd, env = {}) => { console.log(`$ ${cmd} ${args.join(' ').slice(0, 160)}`); const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] }); if (out.trim()) console.log(out.trim().split('\n').slice(-3).join('\n')); return out; };
const shAsync = async (cmd, args, cwd) => { console.log(`$ ${cmd} ${args.join(' ').slice(0, 100)}`); const { stdout } = await promisify(execFile)(cmd, args, { cwd, encoding: 'utf8' }); process.stdout.write(stdout); return stdout; };
const PYTHON = process.env.PYTHON ?? 'python3';

/** A receiver that stands in for everydeck and keeps the names of the events it gets */
async function receiver() {
  const names = [];
  const srv = createServer((req, res) => {
    const parts = []; req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(parts);
      try { const body = JSON.parse((req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString()); for (const e of body.events ?? []) names.push(e.name); } catch { /* not an event batch */ }
      res.statusCode = 202; res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, names, close: () => srv.close() };
}

/** The pair. A small app (FastAPI route with a parameter, React page that PATCHes it with a template path), the scaffold's app map, and every place
 * of it checked by everydeck-check (app_map.evidence_errors): a place the scaffold writes and the check refuses fails the release of either package. */
function pairApp() {
  const app = mkdtempSync(join(tmpdir(), 'smoke-pair-'));
  for (const d of ['backend', 'frontend/src']) mkdirSync(join(app, d), { recursive: true });
  writeFileSync(join(app, 'backend/requirements.txt'), 'fastapi==0.115.0\nsupabase==2.9.0\n');
  writeFileSync(join(app, 'backend/schema.sql'), 'create table public.jobs (id uuid primary key, title text not null, status text not null default \'open\');\n');
  writeFileSync(join(app, 'backend/main.py'), 'from fastapi import FastAPI\nfrom supabase import create_client\n\napp = FastAPI()\nsupabase = create_client("http://127.0.0.1:54321", "anon")\n\n\n@app.get("/jobs/{job_id}")\ndef get_job(job_id: str):\n    return supabase.table("jobs").select("*").eq("id", job_id).single().execute().data\n\n\n@app.patch("/jobs/{job_id}/status")\ndef set_status(job_id: str, body: dict):\n    supabase.table("jobs").update({"status": body["status"]}).eq("id", job_id).execute()\n    return {"ok": True}\n');
  writeFileSync(join(app, 'frontend/package.json'), JSON.stringify({ name: 'pair-app', private: true, dependencies: { react: '18.3.1', 'react-dom': '18.3.1' } }));
  writeFileSync(join(app, 'frontend/index.html'), '<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n');
  writeFileSync(join(app, 'frontend/src/main.tsx'), "import { createRoot } from 'react-dom/client';\nimport { Job } from './Job';\ncreateRoot(document.getElementById('root')!).render(<Job />);\n");
  writeFileSync(join(app, 'frontend/src/Job.tsx'), ["import { useEffect, useState } from 'react';", "const API = import.meta.env.VITE_API_URL ?? '';", 'export function Job() {', '  const [job, setJob] = useState<{ id: string; title: string; status: string } | null>(null);',
    "  useEffect(() => { fetch(`${API}/jobs/${location.hash.slice(1)}`).then((r) => r.json()).then(setJob); }, []);", '  const close = async () => {', '    if (!job) return;', "    await fetch(`${API}/jobs/${job.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'closed' }) });", '  };',
    '  return job ? <h1 onClick={close}>{job.title} {job.status}</h1> : null;', '}', ''].join('\n'));
  sh('git', ['init', '-q'], app); sh('git', ['-c', 'user.name=release', '-c', 'user.email=release@example.com', 'add', '.'], app); sh('git', ['-c', 'user.name=release', '-c', 'user.email=release@example.com', 'commit', '-q', '-m', 'app'], app);
  return app;
}
function pair(scaffoldBin, python, nodePath) {
  const app = pairApp(); const map = join(app, 'everydeck/app-map.json');
  sh(scaffoldBin, [app, '--out', map], app, nodePath ? { NODE_PATH: nodePath } : {});
  const b = JSON.parse(readFileSync(map, 'utf8'));
  if (!(b.flow_candidates ?? []).some((c) => /\/jobs\/:\w+\/status/.test(c.id))) fail('pair: the scaffold found no write request to /jobs/{job_id}/status');
  const out = JSON.parse(sh(python, ['-c', "import json, re, sys\nfrom pathlib import Path\nfrom everydeck_check.app_map import evidence_errors\nb = json.load(open(sys.argv[1]))\nplace = re.compile(r'is not inside |does not mention |holds no request path |lines, evidence names line |does not exist')\nprint(json.dumps([e for e in evidence_errors(b, Path(sys.argv[2])) if place.search(e)]))", map, app], app));
  console.log(`pair: ${(b.flow_candidates ?? []).length} candidate(s), ${b.tables.length} table(s); places the check refuses: ${out.length}`);
  if (out.length) fail(`pair: everydeck-check refuses ${out.length} place(s) the scaffold wrote: ${out.slice(0, 3).join(' | ')}`);
}
const PAIR_SOURCE = (fallback) => resolve(process.env.EVERYDECK_PAIR_SOURCE ?? fallback);

const venv = (into) => { sh(PYTHON, ['-m', 'venv', join(into, 'venv')], into); return { python: join(into, 'venv/bin/python'), bin: (n) => join(into, 'venv/bin', n) }; };

if (key === 'sdk') {
  const tgz = one(/^everydeck-sdk-.*\.tgz$/);
  const app = mkdtempSync(join(tmpdir(), 'smoke-sdk-'));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  sh('npm', ['install', '--no-audit', '--no-fund', tgz], app);
  const pkg = JSON.parse(readFileSync(join(app, 'node_modules/@everydeck/sdk/package.json'), 'utf8'));
  for (const entry of Object.keys(pkg.exports)) {
    const spec = entry === '.' ? '@everydeck/sdk' : `@everydeck/sdk/${entry.slice(2)}`;
    sh(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(spec)}); console.log('loads ${spec}')`], app);
  }
  for (const bin of Object.keys(pkg.bin ?? {})) if (!readdirSync(join(app, 'node_modules/.bin')).includes(bin)) fail(`program ${bin} is not installed`);
  const r = await receiver();
  writeFileSync(join(app, 'app.mjs'), `import { createEverydeck } from '@everydeck/sdk';
const e = createEverydeck({ endpoint: ${JSON.stringify(r.url)}, credential: 'k', releaseKey: 'release-test', manifestDigest: 'a'.repeat(64) });
e.signal('release.sdk.works', 'op-1'); console.log('flushed', await e.flush(5000));`);
  await shAsync(process.execPath, ['app.mjs'], app);
  r.close();
  if (!r.names.includes('release.sdk.works')) fail(`the receiver got no event from the SDK (got: ${r.names.join(', ') || 'nothing'})`);
} else if (key === 'check') {
  const tgz = one(/^everydeck-check-.*\.tgz$/);
  const tool = mkdtempSync(join(tmpdir(), 'smoke-check-'));
  writeFileSync(join(tool, 'package.json'), JSON.stringify({ private: true }));
  sh('npm', ['install', '--no-audit', '--no-fund', tgz, 'typescript@5.9.3'], tool);
  const app = mkdtempSync(join(tmpdir(), 'smoke-app-'));
  mkdirSync(join(app, 'supabase/migrations'), { recursive: true }); mkdirSync(join(app, 'src'));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'notes-app', private: true, dependencies: { '@supabase/supabase-js': '2.45.0', react: '18.3.1', 'react-router-dom': '6.26.0' } }));
  writeFileSync(join(app, 'supabase/migrations/0001_notes.sql'), 'create table public.notes (id uuid primary key default gen_random_uuid(), body text not null, created_at timestamptz not null default now());\n');
  writeFileSync(join(app, 'src/App.tsx'), "import { createBrowserRouter } from 'react-router-dom';\nimport { supabase } from './supabase';\nexport function Notes() { return supabase.from('notes').select('*'); }\nexport const router = createBrowserRouter([{ path: '/notes', element: null }]);\n");
  sh('git', ['init', '-q'], app); sh('git', ['-c', 'user.name=release', '-c', 'user.email=release@example.com', 'add', '.'], app); sh('git', ['-c', 'user.name=release', '-c', 'user.email=release@example.com', 'commit', '-q', '-m', 'app'], app);
  sh(join(tool, 'node_modules/.bin/everydeck-scaffold'), [app, '--out', join(app, 'everydeck/app-map.json')], app, { NODE_PATH: join(tool, 'node_modules') });
  const map = JSON.parse(readFileSync(join(app, 'everydeck/app-map.json'), 'utf8'));
  console.log(`app map: ${map.tables.length} table(s), ${map.screens.length} page(s)`);
  if (!map.tables.some((t) => t.name === 'notes')) fail('everydeck-scaffold did not read the table notes');
  const env = venv(tool);
  sh(env.python, ['-m', 'pip', 'install', '--quiet', PAIR_SOURCE('packages/everydeck-check')], tool);
  pair(join(tool, 'node_modules/.bin/everydeck-scaffold'), env.python, join(tool, 'node_modules'));
} else if (key === 'py') {
  const whl = one(/^everydeck-[\d.]+[^/]*-py3-none-any\.whl$/);
  const env = venv(mkdtempSync(join(tmpdir(), 'smoke-py-')));
  sh(env.python, ['-m', 'pip', 'install', '--quiet', whl], tmpdir());
  const r = await receiver();
  await shAsync(env.python, ['-c', `from everydeck import Everydeck\ne = Everydeck(${JSON.stringify(r.url)}, 'k', release_key='release-test', manifest_digest='a'*64)\ne.signal('release.python.works', 'op-2')\nprint('flushed', e.flush(5))`], tmpdir());
  r.close();
  if (!r.names.includes('release.python.works')) fail(`the receiver got no event from the Python SDK (got: ${r.names.join(', ') || 'nothing'})`);
} else if (key === 'py-check') {
  const whl = one(/^everydeck_check-.*-py3-none-any\.whl$/);
  const dir = mkdtempSync(join(tmpdir(), 'smoke-py-check-'));
  const env = venv(dir);
  sh(env.python, ['-m', 'pip', 'install', '--quiet', whl], dir);
  // a skeleton of a small app is not a complete app map yet: the bundled rules (run with node) reject it with reasons, which shows that they run
  const version = JSON.parse(sh(env.python, ['-c', "import json\nfrom importlib import resources\nprint(json.dumps(json.loads(resources.files('everydeck_check').joinpath('schemas/manifest.schema.json').read_text())['properties']['schema_version']['enum'][-1]))"], dir));
  const at = (path, line) => ({ path, line });
  writeFileSync(join(dir, 'app-map.json'), JSON.stringify({
    schema_version: version, release_key: 'git:000000000000', commit: '0'.repeat(40),
    components: [{ id: 'supabase-supabase-js', package: '@supabase/supabase-js', evidence: at('package.json', 1) }],
    platforms: [{ id: 'web', runtime: 'browser', evidence: at('package.json', 1) }],
    screens: [{ pattern: '/notes', evidence: at('src/App.tsx', 4) }], api_routes: [], identity: null,
    tables: [{ name: 'notes', kind: 'table', defined: { ...at('supabase/migrations/0001_notes.sql', 1), symbol: 'notes' }, columns: [{ name: 'id', type: 'uuid', pk: true }, { name: 'body', type: 'text' }], shown: [{ ...at('src/App.tsx', 3), element: 'data', symbol: 'notes', via: 'from' }] }],
    functions: [], flows: [], money: null, checklist: [],
  }));
  const rule = JSON.parse(sh(env.python, ['-c', "import json, sys\nfrom everydeck_check.rules import run_rule\nprint(json.dumps(run_rule('app_map', {'input': json.load(open(sys.argv[1]))})))", join(dir, 'app-map.json')], dir));
  console.log(`bundled rules: ${rule.errors.length} reason(s): ${rule.errors[0]?.slice(0, 80)}`);
  if (!Array.isArray(rule.errors) || !rule.errors.length) fail('the bundled rules did not reject an incomplete app map');
  const v = spawnSync(env.bin('everydeck-check'), ['validate', join(dir, 'app-map.json')], { cwd: dir, encoding: 'utf8' });
  let out; try { out = JSON.parse(v.stdout); } catch { process.stdout.write(v.stdout); process.stderr.write(v.stderr); fail(`everydeck-check validate gave no result (exit ${v.status})`); }
  console.log(`everydeck-check validate: exit ${v.status}, form ${out.form}, status ${out.status}, ${out.errors.length} reason(s)`);
  if (out.form !== 'app_map' || out.status !== 'invalid' || !out.errors.length || out.errors.some((e) => /everydeck rules:/.test(e))) fail('everydeck-check validate did not check the app map with the bundled rules');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true }));
  sh('npm', ['install', '--no-audit', '--no-fund', PAIR_SOURCE('packages/check'), 'typescript@5.9.3'], dir);
  pair(join(dir, 'node_modules/.bin/everydeck-scaffold'), env.python, join(dir, 'node_modules'));
} else fail(`unknown package ${key}`);
console.log(`package test passed: ${key}`);
