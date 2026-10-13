from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from . import check_drift, digest, freeze_lock, reference_errors, split_proposal, coverage_of, validate_manifest
from .change import check_change

LOCK_NAME = "everydeck-manifest.lock.json"
APP_MAP = "everydeck/app-map.json"
OLD_NAME = "everydeck-befund.json"   # the app map's file name before; an existing setup is still read, nothing is written under it


def map_path(arg: str | None) -> tuple[str, str | None]:
    """The file to read: the given path, without one everydeck/app-map.json. If that does not exist but the same folder has the file under its
    old name (an existing setup), that one is read, with a note."""
    p = Path(arg or APP_MAP)
    if p.exists() or p.name != Path(APP_MAP).name:
        return str(p), None
    old = p.parent / OLD_NAME
    if old.exists():
        return str(old), f"read {old}, the old name of the app map; everydeck now writes and names only {p}: rename the file (git mv) in your next change"
    return str(p), None


def write_path(path: str) -> str:
    """Where a changed app map goes: never under the old name, always app-map.json in the same folder."""
    p = Path(path)
    return str(p.parent / Path(APP_MAP).name) if p.name == OLD_NAME else path


def _load(p: str) -> dict:
    return json.loads(Path(p).read_text(encoding="utf-8"))


def _load_manifest(p: str) -> tuple[dict, dict | None, str]:
    """The file is the proposal `{ manifest, local_check }` or a bare manifest; the manifest is checked.
    An app map (1.12-r0) is brought into signal form for drift/change (drift_manifest)."""
    doc = _load(p)
    from .app_map import drift_manifest, is_app_map
    if is_app_map(doc):
        return drift_manifest(doc), None, "app_map"
    m, lc = split_proposal(doc)
    return m, lc, "proposal" if m is not doc else "manifest"


def _local_check_errors(lc: dict | None) -> list[str]:
    if lc is None:
        return []
    errs: list[str] = []
    qs = lc.get("questions", []) or []
    if not isinstance(qs, list) or len(qs) > 12:
        errs.append("local_check.questions: at most 12 entries")
        return errs
    real = 0
    for q in qs:
        missing = [k for k in ("id", "topic", "finding", "recommendation", "consequence", "options", "recommended_option") if k not in q]
        if missing:
            errs.append(f"local_check.questions[{q.get('id', '?')}]: missing {', '.join(missing)}")
        elif q["recommended_option"] not in [o.get("id") for o in q.get("options", [])]:
            errs.append(f"local_check.questions[{q['id']}]: recommended_option is not one of the options")
        # decide instead of asking: without `ask` a decision (the recommended option applies, recommendation = reason); with `ask` a real question
        ask = q.get("ask")
        if ask is not None:
            if not isinstance(ask, dict) or not all(isinstance(ask.get(k), str) and 1 <= len(ask[k]) <= 300 for k in ("no_safe_default", "irreversible")):
                errs.append(f"local_check.questions[{q.get('id', '?')}]: ask needs no_safe_default and irreversible (each 1 to 300 chars); otherwise decide with the recommended option")
            real += 1
    if real > MAX_REAL_QUESTIONS:
        errs.append(f"questions: {real} real questions (ask); at most {MAX_REAL_QUESTIONS} per proposal; decide the rest with the recommended option and say why")
    return errs


MAX_REAL_QUESTIONS = 2


def question_counts(lc: dict | None) -> dict:
    """Decisions and real questions of a proposal (goal 0 questions, at most 2)."""
    qs = (lc or {}).get("questions", []) or []
    real = sum(1 for q in qs if isinstance(q, dict) and q.get("ask") is not None)
    return {"decisions": len(qs) - real, "questions": real, "max_questions": MAX_REAL_QUESTIONS}


def _coverage_errors(doc: dict, m: dict, form: str, repo: str | None) -> tuple[list[str], list[dict], list[str]]:
    """Coverage table: required in a proposal; shape, then against the manifest and the repo scan (the same messages as everydeck on
    submission). Returns (errors, detected blocks, notes)."""
    from .coverage import coverage_errors, coverage_questions, validate_coverage
    from .detect import detect_blocks
    cov = coverage_of(doc)
    if form == "proposal" and (cov is None or cov == []):
        return ["coverage[] is required in a proposal: one entry per inventory item with its outcome (guide, Step 2b)"], [], []
    if cov is None:
        return [], [], []
    entries, errs = validate_coverage(cov)
    detected = [(d.block, d.evidence) for d in detect_blocks(Path(repo).resolve())] if repo else []
    errs += coverage_errors(m, entries, detected)
    return errs, [{"block": b, "evidence": w} for b, w in detected], coverage_questions(entries)


def cmd_validate(a: argparse.Namespace) -> int:
    # an app map (1.12-r0): shape, references, every place against the repo, completeness (tables, routes, provider packages)
    raw = _load(a.manifest)
    from .app_map import is_app_map, validate_app_map
    if is_app_map(raw):
        repo = getattr(a, "repo", None)
        db = getattr(a, "db", None) or os.environ.get("EVERYDECK_SCHEMA_DB_URL")
        errs = validate_app_map(raw, Path(repo).resolve() if repo else None, db)
        print(json.dumps({"status": "ok" if not errs else "invalid", "form": "app_map", "file": a.manifest, **({"note": a.file_note} if a.file_note else {}), "checked_against_repo": bool(repo), "checked_against_database": bool(db), "errors": errs,
                          "counts": {"tables": len(raw.get("tables", [])), "functions": len(raw.get("functions", [])), "flows": len(raw.get("flows", [])), "present": sum(1 for c in raw.get("checklist", []) if c.get("present"))}}, indent=1))
        return 0 if not errs else 2
    m, lc, form = _load_manifest(a.manifest)
    doc = _load(a.manifest)
    errs = validate_manifest(m) + reference_errors(m) + _local_check_errors(lc)
    detected: list[dict] = []; notes: list[str] = []
    if not errs:
        cerrs, detected, notes = _coverage_errors(doc, m, form, getattr(a, "repo", None))
        errs += cerrs
    print(json.dumps({"status": "ok" if not errs else "invalid", "form": form, "digest": digest(m) if not errs else None, "errors": errs,
                      "detected": detected, "notes": notes, "questions": question_counts(lc)}, indent=1))
    return 0 if not errs else 2


def cmd_reads(a: argparse.Namespace) -> int:
    from .app_map import is_app_map
    from .reads import reads_markdown, reads_table
    raw = _load(a.app_map)
    if not is_app_map(raw): print(json.dumps({"status": "invalid", "errors": ["not an app map (schema_version 1.12-r0 with tables and checklist)"]})); return 2
    rows = reads_table(raw, Path(a.repo).resolve())
    open_rows = [r for r in rows if r["open"]]
    if a.markdown: print(reads_markdown(rows))
    else: print(json.dumps({"status": "ok" if not open_rows else "open", "main": sum(1 for r in rows if r["placement"] == "main"), "technical": sum(1 for r in rows if r["placement"] == "technical"), "open": [{"table": r["table"], "places": r["open"]} for r in open_rows], "rows": rows}, indent=1))
    return 0 if not open_rows else 2


def cmd_drift(a: argparse.Namespace) -> int:
    m, _, _ = _load_manifest(a.manifest)
    repo = Path(a.repo).resolve()
    lock_path = repo / LOCK_NAME
    lock = _load(str(lock_path))["call_sites"] if lock_path.exists() else None
    rep = check_drift(repo, m, lock)
    out = {"status": rep.status, "head": rep.head, "findings": [f.__dict__ for f in rep.findings], "call_sites": rep.call_sites, **({"note": a.file_note} if a.file_note else {})}
    # right after approval the code is already ahead of the app map (adapter, door); "new_build" alone does not prevent freezing;
    # the call sites as of now are recorded. Every other finding (missing signal, job without heartbeat) stays drift.
    only_new_build = bool(rep.findings) and all(f.kind == "new_build" for f in rep.findings)
    if a.freeze and (rep.status != "drift" or only_new_build):
        lock_path.write_text(json.dumps(freeze_lock(rep), indent=1) + "\n", encoding="utf-8")
        out["lock"] = str(lock_path)
        if only_new_build: out["note"] = "the code moved on since the app map commit (new_build only); call sites frozen as of now"
    print(json.dumps(out, indent=1))
    return 0 if rep.status != "drift" or (a.freeze and only_new_build) else 2


def cmd_reanchor(a: argparse.Namespace) -> int:
    """Move places from the app map's commit to HEAD (git, text, symbol). Without --out/--write only the report."""
    from .reanchor import reanchor
    b = _load(a.app_map)
    rep = reanchor(b, Path(a.repo), a.base)
    if not rep.get("error"):
        if isinstance(b.get("release_key"), str) and b["release_key"].startswith("git:") and rep["head"]:
            b["release_key"] = f"git:{rep['head'][:12]}"   # the app map's version follows the commit (the same form as the SDK release key)
        target = a.out or (write_path(a.app_map) if a.write else None)
        if target:
            Path(target).write_text(json.dumps(b, indent=1, ensure_ascii=False) + "\n", encoding="utf-8"); rep["out"] = str(target)
    print(json.dumps(rep, indent=1))
    return 0 if not rep.get("error") else 2


def cmd_publish(a: argparse.Namespace) -> int:
    # never the key on the command line (process list, history); from EVERYDECK_PUBLISH_KEY or a file (--token-file)
    if not a.token:
        a.token = os.environ.get("EVERYDECK_PUBLISH_KEY") or (Path(a.token_file).read_text(encoding="utf-8").strip() if getattr(a, "token_file", None) else None)
    if not a.token:
        print(json.dumps({"status": "invalid", "errors": ["no key: set EVERYDECK_PUBLISH_KEY or pass --token-file (a setup session key stays in the agent store; submit with everydeck-agent call … POST …/proposals --data-file instead)"]}, indent=1)); return 2
    raw = _load(a.manifest)
    from .app_map import is_app_map, validate_app_map
    if is_app_map(raw):   # the app map goes to everydeck as { app_map }; everydeck derives
        errs = validate_app_map(raw, Path(getattr(a, "repo", ".")).resolve() if getattr(a, "repo", None) else None)
        if errs:
            print(json.dumps({"status": "invalid", "errors": errs}, indent=1)); return 2
        req = urllib.request.Request(f"{a.url.rstrip('/')}/api/setup-sessions/{a.session}/proposals" if getattr(a, "session", None) else f"{a.url.rstrip('/')}/api/projects/{a.project}/manifests",
                                     data=json.dumps({"app_map": raw}).encode(), headers={"content-type": "application/json", "authorization": f"Bearer {a.token}"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = json.loads(r.read() or b"{}")
                scope = (body.get("derived") or {}).get("read_scope") or body.get("read_scope")   # the CI path returns it at the top level
                if scope:   # the read scope for the general read bridge, next to the app map
                    out = Path(a.manifest).resolve().parent / "everydeck-read-scope.json"
                    out.write_text(json.dumps(scope, indent=1) + "\n", encoding="utf-8")
                    body["derived"] = {**body["derived"], "read_scope": str(out)}
                print(json.dumps({"status": "published", "http": r.status, **{k: body.get(k) for k in ("status", "approval_required", "approval_reasons", "derived") if k in body}}, indent=1)); return 0
        except urllib.error.HTTPError as e:
            print(json.dumps({"status": "refused", "http": e.code, "body": json.loads(e.read() or b"{}")}, indent=1)); return 2
    m, _, _ = _load_manifest(a.manifest)
    errs = validate_manifest(m) + reference_errors(m)
    if errs:
        print(json.dumps({"status": "invalid", "errors": errs}, indent=1)); return 2
    req = urllib.request.Request(f"{a.url.rstrip('/')}/api/projects/{a.project}/manifests", method="POST",
                                 data=json.dumps({"manifest": m}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + a.token})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            body = json.loads(r.read() or b"{}")
            print(json.dumps({"status": "published", "http": r.status, "digest": digest(m), **{k: body.get(k) for k in ("status", "approval_required", "approval_reasons") if k in body}}, indent=1))
            return 0
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        print(json.dumps({"status": "rejected", "http": e.code, "detail": detail}, indent=1))
        return 2 if e.code in (401, 403, 409, 422) else 0
    except Exception as e:  # an everydeck outage does not block the build
        print(json.dumps({"status": "unreachable", "warning": str(e)[:200], "digest": digest(m)}, indent=1))
        return 0


def cmd_change(a: argparse.Namespace) -> int:
    """Check everydeck-change.json (shape, references, SHA/digest binding) and optionally report it to everydeck.

    Without --url/--project/--token only a local check. With all three: POST /api/projects/<id>/changes with the file content.
    Server answers are printed, never retried: 2xx stored (exit 0), 4xx rejected (exit 2),
    5xx/outage a warning (exit 0; everydeck must not break the customer's build).
    """
    change = _load(a.change)
    m, _, _ = _load_manifest(a.manifest)
    rep = check_change(change, m, Path(a.repo), expected_sha=a.sha)
    out = rep.as_dict()
    remote = (a.url, a.project, a.token)
    if any(remote) and not all(remote):
        print(json.dumps({**out, "status": "invalid", "errors": out["errors"] + ["--url, --project and --token must be given together"]}, indent=1))
        return 2
    if rep.status != "ok" or not all(remote):
        print(json.dumps(out, indent=1))
        return 0 if rep.status == "ok" else 2
    req = urllib.request.Request(f"{a.url.rstrip('/')}/api/projects/{a.project}/changes", method="POST",
                                 data=json.dumps(change).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + a.token})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read() or b"{}"
            try:
                body = json.loads(raw)
            except ValueError:
                body = {}
            extra = {k: body.get(k) for k in ("status", "change_id", "stored", "detail") if isinstance(body, dict) and k in body}
            print(json.dumps({**out, "status": "published", "http": r.status, "server": extra}, indent=1))
            return 0
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        if 400 <= e.code < 500:
            print(json.dumps({**out, "status": "rejected", "http": e.code, "detail": detail}, indent=1))
            return 2
        print(json.dumps({**out, "status": "unreachable", "http": e.code, "warning": detail[:200]}, indent=1))
        return 0
    except Exception as e:  # an everydeck outage does not block the build
        print(json.dumps({**out, "status": "unreachable", "warning": str(e)[:200]}, indent=1))
        return 0


def cmd_footprint(a: argparse.Namespace) -> int:
    """The footprint of the setup against the commit before it: new and changed files, a lockfile rewritten beyond the new packages, leftovers."""
    from .footprint import footprint
    out = footprint(Path(a.repo).resolve(), a.base, fix_lock=a.fix_lock)
    print(json.dumps(out, indent=1))
    return 0 if out["status"] == "ok" else 2


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="everydeck-check")
    sub = p.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate"); v.add_argument("manifest", nargs="?", default=None, help=f"default {APP_MAP}"); v.add_argument("--repo", default=None, help="app repository: detect building blocks (dependencies, config, code hints) that must appear in coverage[]"); v.add_argument("--db", default=None, help="database URL (the read role is enough; or EVERYDECK_SCHEMA_DB_URL); every table of the database must be in the app map, evidence 'database' is checked against it"); v.set_defaults(fn=cmd_validate)
    d = sub.add_parser("drift"); d.add_argument("manifest", nargs="?", default=None, help=f"default {APP_MAP}"); d.add_argument("--repo", default="."); d.add_argument("--freeze", action="store_true"); d.set_defaults(fn=cmd_drift)
    ra = sub.add_parser("reanchor", help="move every place of the app map from its commit to HEAD (git diff, text, symbol); nothing guessed; unresolved places are listed")
    ra.add_argument("app_map", nargs="?", default=None, help=f"default {APP_MAP}"); ra.add_argument("--repo", default="."); ra.add_argument("--base", default=None, help="commit the places refer to (default: commit of the app map)"); ra.add_argument("--out", default=None); ra.add_argument("--write", action="store_true", help="write the re-anchored app map back to its file"); ra.set_defaults(fn=cmd_reanchor)
    rd = sub.add_parser("reads", help="the cross-check of display locations: every table named in a frontend string: main navigation (with access path), technical (with reason) or open"); rd.add_argument("app_map", nargs="?", default=None, help=f"default {APP_MAP}"); rd.add_argument("--repo", required=True); rd.add_argument("--markdown", action="store_true"); rd.set_defaults(fn=cmd_reads)
    pub = sub.add_parser("publish"); pub.add_argument("manifest", nargs="?", default=None, help=f"default {APP_MAP}"); pub.add_argument("--url", required=True); pub.add_argument("--project", required=True); pub.add_argument("--token", default=None, help="deprecated: visible in the process list; use EVERYDECK_PUBLISH_KEY or --token-file"); pub.add_argument("--token-file", default=None); pub.add_argument("--session", default=None, help="setup session id: an app map goes to its proposals endpoint"); pub.add_argument("--repo", default=None, help="check every place of an app map against this repository before publishing"); pub.set_defaults(fn=cmd_publish)
    fp = sub.add_parser("footprint", help="what the setup added and changed in the repository against --base (the commit before the setup); refuses a rewritten lockfile and leftovers")
    fp.add_argument("--base", required=True); fp.add_argument("--repo", default="."); fp.add_argument("--fix-lock", action="store_true", help="restore package-lock.json from --base and add only the new packages"); fp.set_defaults(fn=cmd_footprint)
    ch = sub.add_parser("change", help="check everydeck-change.json against manifest, repo and HEAD; optionally publish it")
    ch.add_argument("change"); ch.add_argument("--manifest", required=True); ch.add_argument("--repo", default="."); ch.add_argument("--sha", default=None)
    ch.add_argument("--url"); ch.add_argument("--project"); ch.add_argument("--token"); ch.set_defaults(fn=cmd_change)
    a = p.parse_args(argv)
    a.file_note = None
    if a.cmd not in ("change", "footprint"):
        for attr in ("manifest", "app_map"):
            if hasattr(a, attr):
                path, a.file_note = map_path(getattr(a, attr)); setattr(a, attr, path)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
