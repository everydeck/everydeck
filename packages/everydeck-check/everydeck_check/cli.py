from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

from . import NOT_DRIFT, check_drift, digest, freeze_lock, reference_errors, split_proposal, coverage_of, validate_manifest
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


# an error of a place that may only have moved (everydeck_check.app_map._check_evidence and the route check)
PLACE_MOVED = re.compile(r"is not inside |does not mention |holds no request path |lines, evidence names line ")


def app_map_text(doc: dict) -> str:
    """The app map in one form, whoever writes it (validate, reanchor and the scaffold): one line per entry of each list, one line per other field. A reviewer
    skims a few hundred lines in the pull request instead of 20 000 (almost the whole pull request before), a change shows as the
    entries it changes, and the next run writes the same bytes."""
    one = lambda x: json.dumps(x, ensure_ascii=False, separators=(",", ":"))   # the same bytes as JSON.stringify in the scaffold
    rows = []
    for k, v in doc.items():
        if isinstance(v, list) and v:
            rows.append(f" {one(k)}: [\n" + ",\n".join("  " + one(x) for x in v) + "\n ]")
        else:
            rows.append(f" {one(k)}: {one(v)}")
    return "{\n" + ",\n".join(rows) + "\n}\n"


def _write_like(source: str, target: str, doc: dict) -> None:
    """Write the app map in its one form (app_map_text); validate, reanchor and the scaffold's --merge wrote their own indentation before, so every run
    rewrote every line. `source` stays for the callers."""
    Path(target).write_text(app_map_text(doc), encoding="utf-8")


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


def validate_map(raw: dict, manifest: str, repo: str | None, db: str | None, file_note: str | None, guard=None) -> tuple[dict, int]:
    """validate of an app map: inventory and generated jobs written into the file (with repo), then every check; (the answer, the exit code).
    `guard(target)` runs right before the file is written (apply: the target must still lie in the repository)."""
    from .app_map import diagnose_app_map
    # the inventory (what everydeck-check finds itself) goes into the app map; everydeck compares it with the description
    inventory = None
    jobs_written: dict = {}
    if repo:
        from .inventory import build_inventory
        from .rules import RulesUnavailable, schedule_jobs
        before = raw.get("inventory")
        inv = build_inventory(Path(repo).resolve(), raw)
        inventory = "unchanged" if before == inv else "written"
        if inventory == "written":
            raw["inventory"] = inv
        # a named schedule in SQL is a job by itself (everydeck reads its runs from cron.job): its jobs[] entry is written here, with the inventory,
        # never copied by hand; a field the agent changed stays its own
        # one more call of the rules (in the one node process of this command), only when a schedule is or was in the inventory
        had = (before or {}).get("schedules") if isinstance(before, dict) else None
        try:
            gen = schedule_jobs(raw, before if isinstance(before, dict) else None) if (inv.get("schedules") or had) else {}
            if gen.get("patch"):
                raw["jobs"] = gen["jobs"]
                jobs_written = {k: gen[k] for k in ("added", "renewed", "removed") if gen.get(k)}
        except RulesUnavailable:
            pass
        if inventory == "written" or jobs_written:
            # an old file name (everydeck-befund.json) is read, but written is only the new one
            if guard: guard(write_path(manifest))
            _write_like(manifest, write_path(manifest), raw)
    errs, stages, rules = diagnose_app_map(raw, Path(repo).resolve() if repo else None, db)
    # server code reads public.everydeck_server_config() while the repository has no migration of that function: the server would stay silent
    if repo:
        from .inventory import server_config_errors
        cfg = [e for e in server_config_errors(raw.get("inventory")) if e not in errs]
        errs += cfg; stages.append({"id": "server_config", "state": "invalid" if cfg else "valid", "count": len(cfg)})
    from .rules import open_of
    # the open parts also while errors remain: the agent sees everything in its first run; a map everydeck cannot read yet has none
    parts = open_of(rules) if "unavailable" not in rules else {"setup": None, "open": [], "still_open": 0}
    rule_open = next((x for x in rules.get("stages", []) if x.get("id") == "open_parts"), None)
    stages.append({"id": "open_parts", "state": "not_checked", "count": 0, "why": "everydeck rules unavailable"} if rule_open is None else rule_open)
    outbox = parts.get("outbox") or {}
    over = outbox.get("limit") is not None and len(outbox.get("entries") or []) > outbox["limit"]
    if outbox.get("entries"):
        stages.append({"id": "live_outbox", "state": "invalid" if over else "valid", "count": len(outbox["entries"]), "limit": outbox.get("limit")})
    nxt = (f"{len(parts['open'])} open parts nobody answered yet (diagnosis.state open; ready_for_submission once none is left): connect each (flow, channel, money entry) or record its outcome in outcomes[] (covered_by a flow that does exactly this, not_applicable with the place that shows it); deferred and unsupported stay open and the owner sees them"
           if parts["open"] else None)
    # a refusal says what comes next too, so the agent does not end its turn with a question to the owner
    if errs: nxt = ("Fix each error in everydeck/app-map.json (and the code it names) yourself with your file tools: every error names the place and what to change. "
                    "All checks ran: work through the list in order; the errors about the app map come first, a missing result signal (a change of the app's code) last. "
                    + (f"Answer the {len(parts['open'])} open parts in the same pass. " if parts.get("open") else "")
                    + "Then run validate again until diagnosis.state is ready_for_submission (exit 0 only means no errors). Nothing here is the owner's decision: do not ask the owner and do not end your turn.")
    # places moved by the agent's own edits are moved by git, not by hand (and code goes where it belongs, not to the end of a file)
    if errs and any(PLACE_MOVED.search(e) for e in errs):
        nxt += (" Places that moved because you edited a file: run `everydeck-check reanchor --worktree --write` (it moves every place of the app map to the"
                " files as they are now, from git) and validate again; do not correct line numbers by hand and do not move your code to the end of a file for it.")
    diagnosis = diagnosis_of(raw, errs, parts["open"], stages, repo=bool(repo))
    if over:
        diagnosis["live_outbox_over_limit"] = (f"the app map proves {len(outbox['entries'])} outbox entries; everydeck_live_files takes at most {outbox['limit']} in one call and refuses more."
                                                " This is a limit of everydeck, not an error of the app map: report it with everydeck_report_progress (stage remark) before you call everydeck_live_files")
    return ({"status": "ok" if not errs else "invalid", "form": "app_map", "file": manifest, **({"note": file_note} if file_note else {}), "checked_against_repo": bool(repo), "checked_against_database": bool(db), "errors": errs,
                      **({"inventory": inventory} if inventory else {"inventory": "not scanned: run with --repo ."}), **({"jobs_from_schedules": jobs_written} if jobs_written else {}),
                      **({"setup": parts["setup"]} if parts.get("setup") else {}), "open": parts["open"], **({"next": nxt} if nxt else {}),
                      # for a live app: the outbox entries the app map proves, ready for everydeck_live_files, and the flows it cannot write yet with the reason
                      **({"live_outbox": outbox["entries"]} if outbox.get("entries") else {}), **({"live_outbox_open": outbox["open"]} if outbox.get("open") else {}),
                      "counts": {"tables": len(raw.get("tables", [])), "functions": len(raw.get("functions", [])), "flows": len(raw.get("flows", [])), "present": sum(1 for c in raw.get("checklist", []) if c.get("present"))},
                      "diagnosis": diagnosis}, 0 if not errs else 2)


DIAGNOSIS_FORMAT = "everydeck.diagnosis/1"


def map_digest(doc: dict) -> str:
    """The digest everydeck takes over the stored app map (sha256 of JSON.stringify of the parsed upload): the same version locally and on submission."""
    import hashlib
    return "sha256:" + hashlib.sha256(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def diagnosis_of(doc: dict, errs: list[str], open_: list, stages: list[dict], repo: bool) -> dict:
    """One state for the whole check, the same format as everydeck's after a submission (everydeck_get_diagnosis): invalid (errors), open (no errors,
    open parts nobody answered), valid (neither, but the places were not checked: no --repo), ready_for_submission (neither, everything checked that this
    command checks; a database stage without --db does not stop it, everydeck does not check it either). The exit code stays 0 for every state without errors."""
    state = "invalid" if errs else "open" if open_ else "not_checked" if any(x["id"] in ("rules", "open_parts") and x["state"] == "not_checked" for x in stages) else "ready_for_submission" if repo else "valid"
    return {"format": DIAGNOSIS_FORMAT, "state": state, "digest": map_digest(doc), "counts": {"errors": len(errs), "open": len(open_)}, "stages": stages}


def cmd_validate(a: argparse.Namespace) -> int:
    # an app map (1.12-r0): shape, references, every place against the repo, completeness (tables, routes, provider packages)
    raw = _load(a.manifest)
    from .app_map import is_app_map
    if is_app_map(raw):
        out, code = validate_map(raw, a.manifest, getattr(a, "repo", None), getattr(a, "db", None) or os.environ.get("EVERYDECK_SCHEMA_DB_URL"), a.file_note)
        print(json.dumps(out, indent=1))
        return code
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


def _setup_plan(a: argparse.Namespace) -> tuple[dict, Path, dict | None]:
    from .app_map import is_app_map
    from .setup import load_live, plan
    repo = Path(a.repo).resolve()
    raw = _load(a.app_map) if Path(a.app_map).exists() else None
    try: map_rel = Path(a.app_map).resolve().relative_to(repo).as_posix()
    except ValueError: map_rel = Path(a.app_map).resolve().as_posix()   # outside the repository: its digest is read where it is
    live = load_live(a.live_files) if a.live_files else None
    return plan(repo, raw if raw is not None and is_app_map(raw) else None, map_rel, a.sdk, live), repo, raw


def cmd_plan(a: argparse.Namespace) -> int:
    """What apply would change (each file with its digest before and after, the app map as a JSON Patch) and what stays by hand. Writes nothing
    unless --out names the plan file, which apply --plan then applies exactly."""
    from .setup import SetupError
    try: p, _, _ = _setup_plan(a)
    except SetupError as e: print(json.dumps({"status": "invalid", "errors": [str(e)]}, indent=1)); return 2
    if a.out: Path(a.out).write_text(json.dumps(p, indent=1) + "\n", encoding="utf-8")
    shown = {**p, "changes": [{k: v for k, v in c.items() if k != "content"} for c in p["changes"]]}
    print(json.dumps({"status": "ok", **({"out": a.out} if a.out else {}), **shown}, indent=1))
    return 0


def cmd_apply(a: argparse.Namespace) -> int:
    """Everything mechanical of the setup in one run: the planned files (only while each is as planned), the app map's patch, then reanchor and
    validate --repo in the same run, so the app map on disk holds all of it. A second run changes nothing.
    Whole or not at all: a path of the plan outside the repository, the app map's own file among them (exit 2), or an app map that is not the one
    the plan read (exit 3) and nothing is written, neither a file nor the app map."""
    from .reanchor import reanchor, record_places
    from .setup import PatchFailed, SetupError, apply_changes, apply_patch, check_paths, digest, within
    map_path_ = Path(a.app_map)
    # where the app map is really written: under its new name in the same folder (write_path), also when it was read under its old one
    def map_target(t: str) -> None: within(Path(a.repo), Path(t), t, "the app map would be written")
    try:
        if a.plan:
            p = _load(a.plan); repo = Path(a.repo).resolve()
        else:
            p, repo, _ = _setup_plan(a)
        check_paths(repo, p)
        if map_path_.exists():
            try: map_target(write_path(a.app_map))
            except SetupError as e: raise SetupError(f"{e}; nothing was written") from None
    except SetupError as e:
        print(json.dumps({"status": "invalid", "errors": [str(e)]}, indent=1)); return 2
    raw = _load(a.app_map) if map_path_.exists() else None
    patch = p["app_map"]["patch"]
    if patch:
        # RFC 6902: the patch holds whole or not at all, and only on the app map the plan read; a signal someone edited since keeps its flow's id
        try: now = digest(map_path_.read_text(encoding="utf-8")) if map_path_.is_file() else None
        except (OSError, UnicodeDecodeError): now = None
        why = None
        try: apply_patch(raw, patch)
        except (PatchFailed, KeyError, IndexError, ValueError, TypeError, AttributeError) as e: why = str(e) or type(e).__name__
        if now != p["app_map"]["before"] or why:
            print(json.dumps({"status": "invalid", "errors": [
                f"{a.app_map} changed since the plan (the plan read {p['app_map']['before']}, now {now})" + (f": {why}" if why else "")
                + "; nothing was written, neither a file nor the app map. Run everydeck-check plan again (or apply without --plan)"]}, indent=1))
            return 3
    try: files = apply_changes(repo, p)
    except SetupError as e: print(json.dumps({"status": "invalid", "errors": [str(e)]}, indent=1)); return 2
    report: dict = {"files": files, "by_hand": p["by_hand"]}
    if raw is not None:
        try: map_rel = str(map_path_.resolve().relative_to(repo))
        except ValueError: map_rel = None
        # the places of the app map follow the files just changed (git, text, symbol), before the new signals, whose places are already the files of now
        ra = reanchor(raw, repo, None, worktree=True, map_rel=map_rel)
        report["reanchor"] = ({"error": ra["error"]} if ra.get("error") else {k: ra[k] for k in ("moved", "by_text", "by_symbol")} | {"unresolved": ra["unresolved"]})
        if patch:
            # held above on the app map before reanchor, which moves places only, never a flow or its id
            raw = apply_patch(raw, patch); report["app_map_changes"] = sum(1 for o in patch if o["op"] != "test")
        def again(t: str) -> None:   # resolved again right before each write of the app map (a link made in between)
            try: map_target(t)
            except SetupError as e: raise SetupError(f"{e} (since the check a moment ago); stopped before writing the app map, written before: {files['written']}") from None
        try:
            again(write_path(a.app_map)); _write_like(a.app_map, write_path(a.app_map), raw)
            if map_rel and not ra.get("error"): record_places(repo, map_rel)
            out, code = validate_map(raw, write_path(a.app_map), str(repo), getattr(a, "db", None) or os.environ.get("EVERYDECK_SCHEMA_DB_URL"), a.file_note, guard=again)
        except SetupError as e:
            print(json.dumps({"status": "invalid", "errors": [str(e)], "apply": report}, indent=1)); return 2
    else:
        out, code = {"status": "ok", "note": f"{a.app_map} does not exist yet: write it with the scaffold first, then run apply again to add the signals and check it"}, 0
    if files["changed_since_plan"] and code == 0: code = 3
    print(json.dumps({**out, "apply": report,
                      "still_yours": "The browser SDK, the signals at the results of flows, the wrappers of AI clients and payment events stay yours (step keys): each needs "
                                     "the keys and the place of its flow. Everything in apply.by_hand also stays yours, each with what to do there."}, indent=1))
    return code


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
    real = [f for f in rep.findings if f.kind not in NOT_DRIFT]   # notes (a job without heartbeat) do not stop freezing
    only_new_build = bool(real) and all(f.kind == "new_build" for f in real)
    if a.freeze and (rep.status != "drift" or only_new_build):
        lock_path.write_text(json.dumps(freeze_lock(rep), indent=1) + "\n", encoding="utf-8")
        out["lock"] = str(lock_path)
        if only_new_build: out["note"] = "the code moved on since the app map commit (new_build only); call sites frozen as of now"
    print(json.dumps(out, indent=1))
    return 0 if rep.status != "drift" or (a.freeze and only_new_build) else 2


def cmd_reanchor(a: argparse.Namespace) -> int:
    """Move places from the app map's commit to HEAD, or with --worktree to the uncommitted files (git, text, symbol). Without --out/--write only the report."""
    from .reanchor import reanchor
    b = _load(a.app_map)
    from .reanchor import record_places
    repo = Path(a.repo).resolve()
    try: map_rel = str(Path(a.app_map).resolve().relative_to(repo))
    except ValueError: map_rel = None
    rep = reanchor(b, repo, a.base, worktree=a.worktree, map_rel=map_rel)
    if not rep.get("error"):
        if isinstance(b.get("release_key"), str) and b["release_key"].startswith("git:") and rep["head"] and not a.worktree:
            b["release_key"] = f"git:{rep['head'][:12]}"   # the app map's version follows the commit (the same form as the SDK release key)
        target = a.out or (write_path(a.app_map) if a.write else None)
        if target:
            _write_like(a.app_map, target, b); rep["out"] = str(target)
            if a.worktree and map_rel: record_places(repo, map_rel)
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
    out = footprint(Path(a.repo).resolve(), a.base, fix_lock=a.fix_lock, db=a.db)
    print(json.dumps(out, indent=1))
    return 0 if out["status"] == "ok" else 2


def cmd_keys(a: argparse.Namespace) -> int:
    """The source map upload key: never under a public name, never in built code, never in a tracked file or an env file git does not ignore."""
    from .keys import key_findings
    out = key_findings(Path(a.repo), a.build)
    print(json.dumps(out, indent=1))
    return 0 if out["status"] == "ok" else 2


def cmd_restart_stack(a: argparse.Namespace) -> int:
    """The local Supabase stack of this repository restarted with the installed CLI, with a time limit; never npx, never a process by name."""
    from .stack import restart_stack
    out = restart_stack(Path(a.repo).resolve(), a.timeout)
    print(json.dumps(out, indent=1))
    return 0 if out["status"] == "ok" else 2


def cmd_local_db(a: argparse.Namespace) -> int:
    """The app's local database from supabase/config.toml or the app's environment (read here, never printed); the url only with the fixed local password."""
    from .localdb import find_local_db
    out = find_local_db(Path(a.repo))
    print(json.dumps(out, indent=1))
    return 0 if out["status"] == "found" else 2


def cmd_runtime(a: argparse.Namespace) -> int:
    """The Python and Node versions the app really uses (Dockerfile, .python-version, runtime.txt, pyproject, .nvmrc, engines), what this session has, how to check with the app's."""
    from .runtime import runtime_report
    out = runtime_report(Path(a.repo))
    print(json.dumps(out, indent=1))
    return 0 if out["status"] == "ok" else 2


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="everydeck-check")
    sub = p.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate"); v.add_argument("manifest", nargs="?", default=None, help=f"default {APP_MAP}"); v.add_argument("--repo", default=None, help="app repository: detect building blocks (dependencies, config, code hints) that must appear in coverage[]"); v.add_argument("--db", default=None, help="database URL (the read role is enough; or EVERYDECK_SCHEMA_DB_URL), or for a hosted database the structure address everydeck gives; every table of the database must be in the app map, evidence 'database' is checked against it"); v.set_defaults(fn=cmd_validate)
    d = sub.add_parser("drift"); d.add_argument("manifest", nargs="?", default=None, help=f"default {APP_MAP}"); d.add_argument("--repo", default="."); d.add_argument("--freeze", action="store_true"); d.set_defaults(fn=cmd_drift)
    ra = sub.add_parser("reanchor", help="move every place of the app map from its commit to HEAD (git diff, text, symbol); nothing guessed; unresolved places are listed")
    ra.add_argument("app_map", nargs="?", default=None, help=f"default {APP_MAP}"); ra.add_argument("--repo", default="."); ra.add_argument("--base", default=None, help="commit the places refer to (default: commit of the app map)"); ra.add_argument("--out", default=None); ra.add_argument("--write", action="store_true", help="write the re-anchored app map back to its file"); ra.add_argument("--worktree", action="store_true", help="to the files as they are now, before a commit: after your own edits during the setup (commit stays)"); ra.set_defaults(fn=cmd_reanchor)
    for name, fn, hlp in (("plan", cmd_plan, "what apply changes (files with their digest before and after, the app map as a JSON Patch) and what stays by hand"),
                          ("apply", cmd_apply, "everything mechanical of the setup in one run: the shared module and its import in each Edge Function, checked transformations, the files of everydeck_live_files with their signals, then reanchor and validate --repo")):
        sp = sub.add_parser(name, help=hlp); sp.add_argument("app_map", nargs="?", default=None, help=f"default {APP_MAP}"); sp.add_argument("--repo", default=".")
        sp.add_argument("--sdk", default=None, help="the @everydeck/sdk version of the packages line, e.g. @everydeck/sdk@0.5.20 (the shared module of the Edge Functions imports it)")
        sp.add_argument("--live-files", default=None, help="the files address everydeck_live_files gave (files_address), or a JSON file with its answer")
        if name == "plan": sp.add_argument("--out", default=None, help="write the plan here; apply --plan applies exactly it")
        else: sp.add_argument("--plan", default=None, help="a plan file of everydeck-check plan --out: only what it planned, only in files that did not change since and only inside the repository; an app map that changed since its patch was planned and nothing is written (exit 3)"); sp.add_argument("--db", default=None, help="as for validate")
        sp.set_defaults(fn=fn)
    rd = sub.add_parser("reads", help="the cross-check of display locations: every table named in a frontend string: main navigation (with access path), technical (with reason) or open"); rd.add_argument("app_map", nargs="?", default=None, help=f"default {APP_MAP}"); rd.add_argument("--repo", required=True); rd.add_argument("--markdown", action="store_true"); rd.set_defaults(fn=cmd_reads)
    pub = sub.add_parser("publish"); pub.add_argument("manifest", nargs="?", default=None, help=f"default {APP_MAP}"); pub.add_argument("--url", required=True); pub.add_argument("--project", required=True); pub.add_argument("--token", default=None, help="deprecated: visible in the process list; use EVERYDECK_PUBLISH_KEY or --token-file"); pub.add_argument("--token-file", default=None); pub.add_argument("--session", default=None, help="setup session id: an app map goes to its proposals endpoint"); pub.add_argument("--repo", default=None, help="check every place of an app map against this repository before publishing"); pub.set_defaults(fn=cmd_publish)
    fp = sub.add_parser("footprint", help="what the setup added and changed in the repository against --base (the commit before the setup); refuses a rewritten lockfile and leftovers")
    fp.add_argument("--base", required=True); fp.add_argument("--repo", default="."); fp.add_argument("--fix-lock", action="store_true", help="restore package-lock.json from --base and add only the new packages"); fp.add_argument("--db", default=None, help="local database URL: also report migrations the database applied during the setup that are not in this repository (written outside it)"); fp.set_defaults(fn=cmd_footprint)
    ks = sub.add_parser("keys", help="the source map upload key (EVERYDECK_SOURCEMAPS_KEY): refused under a public name, in built code, in a tracked file or in an env file git does not ignore")
    ks.add_argument("--repo", default="."); ks.add_argument("--build", action="append", default=[], help="another output folder of the build (relative to --repo)"); ks.set_defaults(fn=cmd_keys)
    from .stack import STACK_RESTART_TIMEOUT
    rs = sub.add_parser("restart-stack", help="restart the local Supabase stack of this repository (supabase stop, supabase start) with the installed CLI and a time limit")
    rs.add_argument("--repo", default="."); rs.add_argument("--timeout", type=int, default=STACK_RESTART_TIMEOUT, help=f"seconds per command (default {STACK_RESTART_TIMEOUT})"); rs.set_defaults(fn=cmd_restart_stack)
    ld = sub.add_parser("local-db", help="the app's local database for --db: supabase/config.toml, or a local Supabase stack or PostgreSQL the app's env files name (no value is printed)")
    ld.add_argument("--repo", default="."); ld.set_defaults(fn=cmd_local_db)
    rt = sub.add_parser("runtime", help="the Python and Node versions the app uses (Dockerfile, .python-version, runtime.txt, pyproject, .nvmrc, engines) against this session; run checks with the app's")
    rt.add_argument("--repo", default="."); rt.set_defaults(fn=cmd_runtime)
    ch = sub.add_parser("change", help="check everydeck-change.json against manifest, repo and HEAD; optionally publish it")
    ch.add_argument("change"); ch.add_argument("--manifest", required=True); ch.add_argument("--repo", default="."); ch.add_argument("--sha", default=None)
    ch.add_argument("--url"); ch.add_argument("--project"); ch.add_argument("--token"); ch.set_defaults(fn=cmd_change)
    a = p.parse_args(argv)
    a.file_note = None
    if a.cmd not in ("change", "footprint", "keys", "restart-stack", "local-db", "runtime"):
        for attr in ("manifest", "app_map"):
            if hasattr(a, attr):
                path, a.file_note = map_path(getattr(a, attr)); setattr(a, attr, path)
    # all rules of one command in one node process (started at the first rule, not at all without one)
    from .rules import session
    # and the files of the repository walked once per command, not once per scan
    from .detect import files_session
    with session(), files_session():
        return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
