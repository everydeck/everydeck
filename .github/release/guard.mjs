/**
 * Public guard: nothing internal ships in a package. It flags non-English text, internal reference numbers, internal names, local paths,
 * secrets and typographic dashes in source folders and in built packages (.tgz, .whl, .tar.gz).
 *   node .github/release/guard.mjs <folder | file | .tgz | .whl | .tar.gz> ...   prints the hits, exit 1 when there are any
 * The rules come from guard-rules.json next to this file. Words that must never be published are listed there only as salted SHA-256
 * hashes, so the list itself reveals nothing. Plain patterns are stored hex encoded so that the rule file does not flag itself.
 * The rule file is generated together with this repository; it is not edited by hand.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES = JSON.parse(readFileSync(new URL('./guard-rules.json', import.meta.url), 'utf8'));
const unhex = (h) => Buffer.from(h, 'hex').toString('utf8');
const regex = (p) => new RegExp(unhex(p.source), p.flags);
const PATTERNS = RULES.patterns.map((p) => ({ id: p.id, re: regex(p) }));
const ORDER = { id: RULES.order.id, re: regex(RULES.order) };
const ALLOW = RULES.allow.map((a) => ({ id: a.id, line: regex(a.line) }));

const memo = new Map();
const hash = (group, s) => {
  const k = `${group}\u0000${s}`;
  let h = memo.get(k);
  if (h === undefined) { if (memo.size > 500_000) memo.clear(); h = createHash('sha256').update(`${RULES.salt}:${group}:${s}`).digest('hex').slice(0, RULES.hashLength); memo.set(k, h); }
  return h;
};
const GROUPS = RULES.words.map((g) => ({
  id: g.id, caseSensitive: g.caseSensitive,
  parts: g.parts.map((p) => ({
    atWordStart: p.atWordStart, pairs: new Set(p.pairs), lengths: [...new Set(p.terms.map((t) => t.length))].sort((a, b) => a - b),
    terms: p.terms.map((t) => ({ ...t, tail: t.tail ? new RegExp(unhex(t.tail), g.caseSensitive ? 'y' : 'iy') : null })),
  })),
}));
const isWord = (c) => c !== undefined && /\w/.test(c);
const lower = (s) => { let out = ''; for (const c of s) { const l = c.toLowerCase(); out += l.length === c.length ? l : c; } return out; };

/** First hit of one part of a hashed word group in a line: { index, match } or null */
function partHit(g, p, text, line) {
  for (let i = 0; i < text.length; i++) {
    if (p.atWordStart ? !(isWord(text[i]) && !isWord(text[i - 1])) : !p.pairs.has(hash(g.id, text.slice(i, i + 2)))) continue;
    for (const L of p.lengths) {
      if (i + L > text.length) break;
      const h = hash(g.id, text.slice(i, i + L));
      for (const t of p.terms) {
        if (t.hash !== h || t.length !== L) continue;
        if (t.wordEnd && isWord(text[i + L])) continue;
        if (!t.tail) return { index: i, match: line.slice(i, i + L) };
        t.tail.lastIndex = i + L;
        const m = t.tail.exec(text);
        if (m) return { index: i, match: line.slice(i, i + L + m[0].length) };
      }
    }
  }
  return null;
}

/** First hit of a hashed word group in one line (the leftmost, as the regular expression it was made from would find) */
function wordHit(g, line) {
  const text = g.caseSensitive ? line : lower(line);
  let best = null;
  for (const p of g.parts) { const m = partHit(g, p, text, line); if (m && (!best || m.index < best.index)) best = m; }
  return best;
}

/** All checks in their order: [{ id, exec(line) → { index, match } | null }] */
const CHECKS = [
  ...PATTERNS.map((p) => ({ id: p.id, exec: (l) => { const m = p.re.exec(l); return m && { index: m.index, match: m[0] }; } })),
  ...GROUPS.map((g) => ({ id: g.id, exec: (l) => wordHit(g, l) })),
].sort((a, b) => RULES.sequence.indexOf(a.id) - RULES.sequence.indexOf(b.id));
const ORDER_CHECK = { id: ORDER.id, exec: (l) => { const m = ORDER.re.exec(l); return m && { index: m.index, match: m[0] }; } };

const TEXT = new Set(['.ts', '.mts', '.js', '.mjs', '.cjs', '.py', '.json', '.md', '.sql', '.toml', '.yml', '.yaml', '.txt', '.cfg', '.in', '']);
const NAMES = new Set(['LICENSE', 'METADATA', 'PKG-INFO', 'RECORD', 'WHEEL', 'top_level.txt', 'entry_points.txt']);
const isText = (p) => TEXT.has(extname(p)) || NAMES.has(p.split('/').pop());
const minified = (text) => text.split('\n').some((l) => l.length > 2000);

/** Strings and comments of bundled JavaScript, read with the TypeScript parser (escapes resolved) */
function stringsOf(text) {
  let ts;
  for (const from of [process.cwd() + '/', fileURLToPath(import.meta.url)]) { try { ts = createRequire(from)('typescript'); break; } catch { /* next */ } }
  if (!ts) throw new Error('the guard needs the package "typescript" to read bundled code (npm install --no-save typescript)');
  const sf = ts.createSourceFile('bundle.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || n.kind === ts.SyntaxKind.TemplateHead || n.kind === ts.SyntaxKind.TemplateMiddle || n.kind === ts.SyntaxKind.TemplateTail)
      found.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.text });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const ranges = new Map();
  const comments = (n) => { for (const r of [...(ts.getLeadingCommentRanges(text, n.pos) ?? []), ...(ts.getTrailingCommentRanges(text, n.end) ?? [])]) ranges.set(r.pos, r); ts.forEachChild(n, comments); };
  comments(sf);
  for (const r of ranges.values()) found.push({ line: sf.getLineAndCharacterOfPosition(r.pos).line + 1, text: text.slice(r.pos, r.end) });
  return found;
}

/** Hits in one text: [{ file, line, pattern, match, context }] */
export function scanText(file, text) {
  const hits = [];
  const add = (line, pattern, m, full) => hits.push({ file, line, pattern, match: m.match, context: full.slice(Math.max(0, m.index - 50), m.index + m.match.length + 50).trim() });
  const lines = text.split('\n');
  const bundle = minified(text);
  lines.forEach((l, i) => {
    for (const c of CHECKS) { const m = c.exec(l); if (m) add(i + 1, c.id, m, l); }
    if (!bundle) { const m = ORDER_CHECK.exec(l); if (m) add(i + 1, ORDER_CHECK.id, m, l); }
  });
  if (bundle) for (const s of stringsOf(text)) for (const c of [...CHECKS, ORDER_CHECK]) { const m = c.exec(s.text); if (m) add(s.line, `${c.id} (string)`, m, s.text); }
  const seen = new Set();
  return hits.filter((h) => !ALLOW.some((a) => a.id === h.pattern && a.line.test(lines[h.line - 1] ?? ''))).filter((h) => { const k = `${h.line}|${h.pattern.replace(' (string)', '')}|${h.match}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const walk = (d, base = d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  if (statSync(p).isDirectory()) return n === '.git' || n === 'node_modules' || n === '__pycache__' ? [] : walk(p, base);
  return [relative(base, p)];
});

/** Hits in a folder (every text file) */
export function scanDir(dir, label = dir) {
  return walk(dir).filter(isText).flatMap((f) => scanText(`${label}/${f}`, readFileSync(join(dir, f), 'utf8')));
}

/** Hits in a folder, a file or a built package (.tgz, .tar.gz, .whl) */
export function scanPath(p) {
  if (statSync(p).isDirectory()) return scanDir(p);
  if (/\.(tgz|tar\.gz|whl|zip)$/.test(p)) {
    const into = mkdtempSync(join(tmpdir(), 'public-guard-'));
    if (p.endsWith('.whl') || p.endsWith('.zip')) execFileSync('unzip', ['-q', p, '-d', into]);
    else execFileSync('tar', ['-xzf', p, '-C', into]);
    return scanDir(into, p.split('/').pop());
  }
  return scanText(p, readFileSync(p, 'utf8'));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!paths.length) { console.error('usage: node guard.mjs <folder | file | package> ...'); process.exit(2); }
  const hits = paths.flatMap(scanPath);
  for (const h of hits.slice(0, 200)) console.log(`${h.file}:${h.line} [${h.pattern}] ${h.context}`);
  const byPattern = {}; for (const h of hits) byPattern[h.pattern] = (byPattern[h.pattern] ?? 0) + 1;
  console.log(JSON.stringify({ checked: paths, hits: hits.length, files: new Set(hits.map((h) => h.file)).size, byPattern }));
  if (hits.length) console.log(`::error title=Public guard::${hits.length} hit(s): internal text would be published. Nothing was published.`);
  process.exit(hits.length ? 1 : 0);
}
