/**
 * B38 Punkt 1: das Icon, das die App selbst ausliefert – ein Fakt mit Fundstelle, nie geraten.
 *   1. `<link rel="apple-touch-icon" | "icon" | "shortcut icon" href>` in den HTML-Einstiegen (Vite `index.html`, `public/index.html` …),
 *   2. Icons im Web-Manifest (`icons[].src`, das größte zuerst),
 *   3. Next.js: `app/icon.*`, `app/apple-icon.*` (auch unter `src/app/`), Expo: `expo.icon` in `app.json`.
 * Die Datei kommt mit Fundstelle, Medientyp, SHA-256 und Inhalt (Base64, höchstens 96 KiB) in den Befund (`app.icon`); everydeck speichert eine Kopie
 * für die Karte "Your apps" und gibt den Inhalt nicht weiter in den gespeicherten Befund. Ohne Datei: kein Icon (die Karte zeigt den Anfangsbuchstaben).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const ICON_MAX_BYTES = 96 * 1024;
const TYPES = { '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const typeOf = (p) => TYPES[(/\.[a-z]+$/i.exec(p)?.[0] ?? '').toLowerCase()] ?? null;
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/** Kandidaten mit Rang (kleiner = besser): apple-touch-icon (groß, quadratisch), Manifest nach Größe, SVG, PNG, ICO */
export function iconCandidates(repo, files) {
  const rel = (p) => relative(repo, p);
  const out = [];
  const resolveHref = (href, fromFile) => {
    const h = String(href).split(/[?#]/)[0];
    if (!h || /^(?:[a-z]+:)?\/\//i.test(h) || h.startsWith('data:')) return null;   // fremde Adresse oder eingebettet: keine Datei im Repo
    const base = dirname(fromFile);
    const tries = h.startsWith('/') ? [join(base, 'public', h), join(repo, 'public', h), join(base, h), join(repo, h)] : [join(base, h), join(base, 'public', h)];
    return tries.find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
  };
  for (const f of files.filter((p) => /(^|\/)index\.html$|(^|\/)app\.html$/.test(rel(p)))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0]; const relAttr = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? ''; const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (!href || !/\b(icon|apple-touch-icon)\b/.test(relAttr)) continue;
      const file = resolveHref(href, f); if (!file) continue;
      const sizes = /\bsizes\s*=\s*["'](\d+)x\d+["']/i.exec(tag)?.[1];
      const rank = relAttr.includes('apple-touch-icon') ? 0 : typeOf(file) === 'image/svg+xml' ? 3 : typeOf(file) === 'image/x-icon' ? 5 : 4;
      out.push({ file, evidence: { path: rel(f), line: lineOf(src, m.index) }, rank, size: Number(sizes ?? 0) });
    }
  }
  for (const f of files.filter((p) => /(^|\/)(manifest\.json|site\.webmanifest|manifest\.webmanifest)$/.test(rel(p)))) {
    const src = readFileSync(f, 'utf8'); let j; try { j = JSON.parse(src); } catch { continue; }
    for (const ic of Array.isArray(j?.icons) ? j.icons : []) {
      if (typeof ic?.src !== 'string') continue;
      const file = resolveHref(ic.src, f); if (!file) continue;
      const at = src.indexOf(JSON.stringify(ic.src).slice(1, -1));
      out.push({ file, evidence: { path: rel(f), line: at >= 0 ? lineOf(src, at) : 1 }, rank: 1, size: Number(/^(\d+)x/.exec(String(ic.sizes ?? ''))?.[1] ?? 0) });
    }
  }
  for (const f of files.filter((p) => /^(src\/)?app\/(apple-icon|icon)\d*\.(png|svg|ico|jpg|jpeg|webp)$/.test(rel(p)))) out.push({ file: f, evidence: { path: rel(f), line: 1 }, rank: /apple-icon/.test(rel(f)) ? 0 : 2, size: 0 });
  const appJson = files.find((p) => rel(p) === 'app.json');
  if (appJson) {
    const src = readFileSync(appJson, 'utf8'); let j; try { j = JSON.parse(src); } catch { j = null; }
    const icon = j?.expo?.icon;
    if (typeof icon === 'string') { const file = resolveHref(icon, appJson); if (file) { const at = src.indexOf(icon); out.push({ file, evidence: { path: rel(appJson), line: at >= 0 ? lineOf(src, at) : 1 }, rank: 1, size: 1024 }); } }
  }
  return out.filter((c) => typeOf(c.file)).sort((a, b) => a.rank - b.rank || b.size - a.size);
}

/** Das beste Icon unter der Größengrenze, mit Inhalt – oder null */
export function findIcon(repo, files) {
  for (const c of iconCandidates(repo, files)) {
    const bytes = readFileSync(c.file);
    if (!bytes.length || bytes.length > ICON_MAX_BYTES) continue;
    return { file: relative(repo, c.file), evidence: c.evidence, media_type: typeOf(c.file), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, data: bytes.toString('base64') };
  }
  return null;
}
