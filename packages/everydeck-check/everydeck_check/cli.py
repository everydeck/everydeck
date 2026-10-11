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


def _load(p: str) -> dict:
    return json.loads(Path(p).read_text(encoding="utf-8"))


def _load_manifest(p: str) -> tuple[dict, dict | None, str]:
    """B20: Datei ist der Vorschlag `{ manifest, local_check }` oder ein nacktes Manifest; geprüft wird das Manifest.
    B29: ein Befund (1.12-r0) wird für drift/change in die Signalform gebracht (drift_manifest)."""
    doc = _load(p)
    from .befund import drift_manifest, is_befund
    if is_befund(doc):
        return drift_manifest(doc), None, "befund"
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
        # Entscheiden statt fragen: ohne `ask` eine Entscheidung (empfohlene Option gilt, recommendation = Grund); mit `ask` eine echte Frage
        ask = q.get("ask")
        if ask is not None:
            if not isinstance(ask, dict) or not all(isinstance(ask.get(k), str) and 1 <= len(ask[k]) <= 300 for k in ("no_safe_default", "irreversible")):
                errs.append(f"local_check.questions[{q.get('id', '?')}]: ask needs no_safe_default and irreversible (each 1–300 chars) – otherwise decide with the recommended option")
            real += 1
    if real > MAX_REAL_QUESTIONS:
        errs.append(f"questions: {real} real questions (ask) – at most {MAX_REAL_QUESTIONS} per proposal; decide the rest with the recommended option and say why")
    return errs


MAX_REAL_QUESTIONS = 2


def question_counts(lc: dict | None) -> dict:
    """Entscheidungen und echte Fragen eines Vorschlags (Ziel 0 Fragen, höchstens 2 – Abnahmebedingung B28)."""
    qs = (lc or {}).get("questions", []) or []
    real = sum(1 for q in qs if isinstance(q, dict) and q.get("ask") is not None)
    return {"decisions": len(qs) - real, "questions": real, "max_questions": MAX_REAL_QUESTIONS}


def _coverage_errors(doc: dict, m: dict, form: str, repo: str | None) -> tuple[list[str], list[dict], list[str]]:
    """B22: Abdeckungstabelle – Pflicht im Vorschlag; Form, dann gegen das Manifest und den Repo-Scan (dieselben Meldungen wie everydeck beim
    Einreichen). Liefert (Fehler, erkannte Bausteine, Hinweise)."""
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
    # B29: ein Befund (1.12-r0) – Form, Verweise, jede Fundstelle gegen das Repo, Vollständigkeit (Tabellen, Routen, Anbieterpakete)
    raw = _load(a.manifest)
    from .befund import is_befund, validate_befund
    if is_befund(raw):
        repo = getattr(a, "repo", None)
        db = getattr(a, "db", None) or os.environ.get("EVERYDECK_SCHEMA_DB_URL")
        errs = validate_befund(raw, Path(repo).resolve() if repo else None, db)
        print(json.dumps({"status": "ok" if not errs else "invalid", "form": "befund", "checked_against_repo": bool(repo), "checked_against_database": bool(db), "errors": errs,
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
    from .befund import is_befund
    from .reads import reads_markdown, reads_table
    raw = _load(a.befund)
    if not is_befund(raw): print(json.dumps({"status": "invalid", "errors": ["not a Befund (schema_version 1.12-r0 with tables and checklist)"]})); return 2
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
    out = {"status": rep.status, "head": rep.head, "findings": [f.__dict__ for f in rep.findings], "call_sites": rep.call_sites}
    # B31: direkt nach der Freigabe ist der Code schon weiter als der Befund (Adapter, Tür) – „new_build“ allein hindert das Einfrieren nicht;
    # festgehalten werden die Aufrufstellen von jetzt. Jeder andere Befund (fehlendes Signal, Job ohne Herzschlag) bleibt Drift.
    only_new_build = bool(rep.findings) and all(f.kind == "new_build" for f in rep.findings)
    if a.freeze and (rep.status != "drift" or only_new_build):
        lock_path.write_text(json.dumps(freeze_lock(rep), indent=1) + "\n", encoding="utf-8")
        out["lock"] = str(lock_path)
        if only_new_build: out["note"] = "the code moved on since the Befund commit (new_build only) – call sites frozen as of now"
    print(json.dumps(out, indent=1))
    return 0 if rep.status != "drift" or (a.freeze and only_new_build) else 2


def cmd_reanchor(a: argparse.Namespace) -> int:
    """B37 Baustein 2: Fundstellen vom Commit des Befunds auf HEAD umziehen (git, Text, Symbol). Ohne --out/--write nur der Bericht."""
    from .reanchor import reanchor
    b = _load(a.befund)
    rep = reanchor(b, Path(a.repo), a.base)
    if not rep.get("error"):
        if isinstance(b.get("release_key"), str) and b["release_key"].startswith("git:") and rep["head"]:
            b["release_key"] = f"git:{rep['head'][:12]}"   # die Fassung des Befunds folgt dem Commit (dieselbe Form wie der Release-Key des SDK)
        target = a.out or (a.befund if a.write else None)
        if target:
            Path(target).write_text(json.dumps(b, indent=1, ensure_ascii=False) + "\n", encoding="utf-8"); rep["out"] = str(target)
    print(json.dumps(rep, indent=1))
    return 0 if not rep.get("error") else 2


def cmd_publish(a: argparse.Namespace) -> int:
    # B31: der Schlüssel nie auf der Kommandozeile (Prozessliste, Verlauf) – aus EVERYDECK_PUBLISH_KEY oder einer Datei (--token-file)
    if not a.token:
        a.token = os.environ.get("EVERYDECK_PUBLISH_KEY") or (Path(a.token_file).read_text(encoding="utf-8").strip() if getattr(a, "token_file", None) else None)
    if not a.token:
        print(json.dumps({"status": "invalid", "errors": ["no key: set EVERYDECK_PUBLISH_KEY or pass --token-file (a setup session key stays in the agent store – submit with everydeck-agent call … POST …/proposals --data-file instead)"]}, indent=1)); return 2
    raw = _load(a.manifest)
    from .befund import is_befund, validate_befund
    if is_befund(raw):   # B29: der Befund geht als { befund } an everydeck; everydeck leitet ab
        errs = validate_befund(raw, Path(getattr(a, "repo", ".")).resolve() if getattr(a, "repo", None) else None)
        if errs:
            print(json.dumps({"status": "invalid", "errors": errs}, indent=1)); return 2
        req = urllib.request.Request(f"{a.url.rstrip('/')}/api/setup-sessions/{a.session}/proposals" if getattr(a, "session", None) else f"{a.url.rstrip('/')}/api/projects/{a.project}/manifests",
                                     data=json.dumps({"befund": raw}).encode(), headers={"content-type": "application/json", "authorization": f"Bearer {a.token}"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = json.loads(r.read() or b"{}")
                scope = (body.get("derived") or {}).get("read_scope") or body.get("read_scope")   # B31: der CI-Weg liefert ihn oben
                if scope:   # B29 Abnahme: der Lese-Umfang für die allgemeine Lese-Brücke, neben dem Befund
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
    except Exception as e:  # Netzausfall von everydeck blockiert den Build nicht (docs/02)
        print(json.dumps({"status": "unreachable", "warning": str(e)[:200], "digest": digest(m)}, indent=1))
        return 0


def cmd_change(a: argparse.Namespace) -> int:
    """B9: everydeck-change.json prüfen (Form, Referenzen, SHA-/Digest-Bindung) und optional an everydeck melden.

    Ohne --url/--project/--token nur lokale Prüfung. Mit allen dreien: POST /api/projects/<id>/changes mit dem Dateiinhalt.
    Server-Antworten werden gedruckt, nie wiederholt: 2xx gespeichert (Exit 0), 4xx abgelehnt (Exit 2),
    5xx/Netzausfall Warnung (Exit 0 – everydeck darf den Build des Kunden nicht brechen).
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
    except Exception as e:  # Netzausfall von everydeck blockiert den Build nicht (docs/02)
        print(json.dumps({**out, "status": "unreachable", "warning": str(e)[:200]}, indent=1))
        return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="everydeck-check")
    sub = p.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate"); v.add_argument("manifest"); v.add_argument("--repo", default=None, help="app repository: detect building blocks (dependencies, config, code hints) that must appear in coverage[]"); v.add_argument("--db", default=None, help="B31: database URL (the read role is enough; or EVERYDECK_SCHEMA_DB_URL) – every table of the database must be in the Befund, evidence 'database' is checked against it"); v.set_defaults(fn=cmd_validate)
    d = sub.add_parser("drift"); d.add_argument("manifest"); d.add_argument("--repo", default="."); d.add_argument("--freeze", action="store_true"); d.set_defaults(fn=cmd_drift)
    ra = sub.add_parser("reanchor", help="B37: move every place of the Befund from its commit to HEAD (git diff, text, symbol) – nothing guessed; unresolved places are listed")
    ra.add_argument("befund"); ra.add_argument("--repo", default="."); ra.add_argument("--base", default=None, help="commit the places refer to (default: commit of the Befund)"); ra.add_argument("--out", default=None); ra.add_argument("--write", action="store_true", help="write the re-anchored Befund back to its file"); ra.set_defaults(fn=cmd_reanchor)
    rd = sub.add_parser("reads", help="B29: the cross-check of display locations – every table named in a frontend string: main navigation (with access path), technical (with reason) or open"); rd.add_argument("befund"); rd.add_argument("--repo", required=True); rd.add_argument("--markdown", action="store_true"); rd.set_defaults(fn=cmd_reads)
    pub = sub.add_parser("publish"); pub.add_argument("manifest"); pub.add_argument("--url", required=True); pub.add_argument("--project", required=True); pub.add_argument("--token", default=None, help="deprecated: visible in the process list – use EVERYDECK_PUBLISH_KEY or --token-file"); pub.add_argument("--token-file", default=None); pub.add_argument("--session", default=None, help="setup session id: a Befund goes to its proposals endpoint"); pub.add_argument("--repo", default=None, help="check every place of a Befund against this repository before publishing"); pub.set_defaults(fn=cmd_publish)
    ch = sub.add_parser("change", help="check everydeck-change.json against manifest, repo and HEAD; optionally publish it")
    ch.add_argument("change"); ch.add_argument("--manifest", required=True); ch.add_argument("--repo", default="."); ch.add_argument("--sha", default=None)
    ch.add_argument("--url"); ch.add_argument("--project"); ch.add_argument("--token"); ch.set_defaults(fn=cmd_change)
    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
