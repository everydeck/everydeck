/**
 * Release step 1: which package a release tag means, and whether it may be published.
 *   node .github/release/prepare.mjs <tag>
 * Tags: sdk-v<version> (@everydeck/sdk), check-v<version> (@everydeck/check), py-v<version> (everydeck on PyPI),
 * py-check-v<version> (everydeck-check on PyPI). Stops when the tag names no package, when the version in the tag is not the version in the
 * package, or when that version is already in the registry. Writes the outputs for the next steps to GITHUB_OUTPUT.
 */
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGES = {
  sdk: { dir: 'packages/sdk', registry: 'npm' },
  check: { dir: 'packages/check', registry: 'npm' },
  py: { dir: 'packages/sdk-python', registry: 'pypi' },
  'py-check': { dir: 'packages/everydeck-check', registry: 'pypi' },
};
const TAG = /^(sdk|check|py-check|py)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Name and version written in the package folder */
export function packageOf(root, key) {
  const { dir, registry } = PACKAGES[key];
  if (registry === 'npm') { const p = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')); return { name: p.name, version: p.version }; }
  const toml = readFileSync(join(root, dir, 'pyproject.toml'), 'utf8');
  const project = /^\[project\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? '';
  return { name: /^name\s*=\s*"([^"]+)"/m.exec(project)?.[1], version: /^version\s*=\s*"([^"]+)"/m.exec(project)?.[1] };
}

/** Is this version already in the registry? true, false, or throws when the registry cannot be asked */
export async function published(registry, name, version, fetchImpl = fetch) {
  const url = registry === 'npm' ? `https://registry.npmjs.org/${name.replace('/', '%2F')}/${encodeURIComponent(version)}` : `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`could not ask ${registry} whether ${name} ${version} exists (HTTP ${res.status}); try again later`);
}

/** The whole check: { key, dir, registry, name, version, npmTag } or throws with a sentence that says what to do */
export async function prepare(tag, { root = process.cwd(), fetchImpl = fetch } = {}) {
  const m = TAG.exec(String(tag ?? '').trim());
  if (!m) throw new Error(`The tag "${tag}" names no package. Use sdk-v<version>, check-v<version>, py-v<version> or py-check-v<version>, for example sdk-v0.5.2.`);
  const [, key, tagVersion] = m;
  const { dir, registry } = PACKAGES[key];
  const { name, version } = packageOf(root, key);
  if (!name || !version) throw new Error(`${dir} has no package name or version.`);
  if (version !== tagVersion) throw new Error(`The tag says ${tagVersion}, but ${dir} is ${name} ${version}. Nothing was published. Use the tag ${key}-v${version}, or bring this repository to ${tagVersion} first.`);
  if (await published(registry, name, version, fetchImpl)) throw new Error(`${name} ${version} is already on ${registry === 'npm' ? 'npm' : 'PyPI'}. Nothing was published. A new release needs a new version.`);
  return { key, dir, registry, name, version, npmTag: version.includes('-') ? 'next' : 'latest' };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = await prepare(process.argv[2]);
    const out = { package: r.key, dir: r.dir, registry: r.registry, name: r.name, version: r.version, npm_tag: r.npmTag };
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(''));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${r.name} ${r.version}\n\nFolder \`${r.dir}\`, registry ${r.registry}. Tag and version match; this version is not published yet.\n`);
    console.log(JSON.stringify(out));
  } catch (e) {
    console.log(`::error title=Release stopped::${e.message}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Release stopped\n\n${e.message}\n`);
    process.exit(1);
  }
}
