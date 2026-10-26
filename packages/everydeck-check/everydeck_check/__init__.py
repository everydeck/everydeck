"""everydeck-check: deterministic check and sync step in the customer's CI/build path.

- validate: manifest against schema 1.0-r0 and references (signals, capabilities, rules).
- drift:    places (path, symbol) must exist and contain a call `.signal("<name>", …)` (or error/log) inside the symbol.
            A lock file (`everydeck-manifest.lock.json`) records the number of call sites per (signal, symbol);
            if it drops, that is drift. A new commit is not drift, only a new revision.
- publish:  POST /api/projects/<id>/manifests with a publish token; an everydeck outage must not break the build
            (exit 0 with a warning, the artifact stays).
- change:   `everydeck-change.json` (module `change`): shape, capability/file/symbol references, binding to HEAD and the manifest digest;
            optional POST /api/projects/<id>/changes. The description comes from the coding agent; everydeck-check only checks it mechanically.
Python symbols (functions, classes, methods) are checked through the AST; other languages are not supported.
"""
from __future__ import annotations

import ast
import hashlib
import json
import re
import subprocess
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

__all__ = ["validate_manifest", "reference_errors", "digest", "check_drift", "freeze_lock", "DriftReport", "Finding", "split_proposal", "reverses_of", "every_ok", "iso_duration_seconds"]


def split_proposal(doc: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """The proposal is `{ "manifest": …, "local_check": … }` (exactly the body of POST …/proposals); a bare manifest is still allowed."""
    if isinstance(doc, dict) and isinstance(doc.get("manifest"), dict) and "schema_version" not in doc:
        lc = doc.get("local_check")
        return doc["manifest"], lc if isinstance(lc, dict) else None
    return doc, None


def coverage_of(doc: dict[str, Any]) -> Any:
    """`coverage[]` of the proposal (None for a bare manifest or without the table)."""
    if isinstance(doc, dict) and isinstance(doc.get("manifest"), dict) and "schema_version" not in doc:
        return doc.get("coverage")
    return None


def reverses_of(action: dict[str, Any]) -> list[str]:
    """B.reverses = ["A"]: B undoes A; a single value (up to 1.8-r0) or a list (from 1.9-r0)."""
    r = action.get("reverses")
    return [] if r is None else list(r) if isinstance(r, list) else [r]


def every_ok(every: str) -> bool:
    """Rhythm of a job in the manifest: a duration (15m, 1h, 1d) or a five-field cron expression. The same rule as everydeck (jobPeriodSeconds,
    through everydeck_check/rules/everydeck-rules.mjs), not rebuilt in Python."""
    from .rules import run_rule
    return run_rule("cadence", {"expressions": [str(every)]})["results"][0]["manifest_period_seconds"] is not None


_ISO_DURATION = re.compile(r"^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$")


def iso_duration_seconds(d: Any) -> int | None:
    """ISO 8601 duration (weeks, days, hours, minutes) in seconds, like `isoDurationSeconds` in everydeck's contracts; invalid or 0 → None."""
    if not isinstance(d, str) or d in ("P", "PT"):
        return None
    m = _ISO_DURATION.match(d)
    if not m:
        return None
    w, dd, h, mi = (int(x or 0) for x in m.groups())
    s = w * 604800 + dd * 86400 + h * 3600 + mi * 60
    return s if s > 0 else None


def _schema() -> dict[str, Any]:
    return json.loads(resources.files("everydeck_check").joinpath("schemas/manifest.schema.json").read_text(encoding="utf-8"))


# Adapter features that are not flow ids (server_errors = central server error path connected)
ADAPTER_FEATURES = ("server_errors", "browser_actions", "messages")   # messages = message metadata (everydeck.messageSent)


def validate_manifest(manifest: dict[str, Any]) -> list[str]:
    v = Draft202012Validator(_schema(), format_checker=FormatChecker())
    return [f"{'/'.join(str(p) for p in e.path) or '$'}: {e.message}" for e in v.iter_errors(manifest)]


LOCKED_ROLES = ("ref", "person")


def field_editable(o: dict[str, Any], f: dict[str, Any]) -> bool:
    """Effective editability (mirror of contracts fieldEdit): yes by default once the object type has a manage block; locked by role, managed_in or the agent."""
    if f.get("role") in LOCKED_ROLES or f.get("managed_in") or not o.get("manage"):
        return False
    ed = f.get("edit")
    return not (ed and not ed.get("editable"))


def description_path_errors(m: Any) -> list[str]:
    """Description texts that name a file the manifest lists as a place; the same rule as descriptionPathErrors (TS)."""
    import re as _re
    paths: list[str] = []; texts: list[tuple[str, str]] = []

    def walk(x: Any, at: str) -> None:
        if isinstance(x, list):
            for i, y in enumerate(x): walk(y, f"{at}[{i}]")
        elif isinstance(x, dict):
            for k, v in x.items():
                here = f"{at}.{k}" if at else k
                if k == "path" and isinstance(v, str) and v != "database" and len(v) > 3:
                    if v not in paths: paths.append(v)
                elif k == "description" and isinstance(v, str): texts.append((here, v))
                else: walk(v, here)
    walk(m, "")
    errs: list[str] = []
    for at, text in texts:
        for p in paths:
            i = text.find(p)
            if i >= 0 and not _re.match(r"[\w./-]", text[i - 1] if i > 0 else "") and not _re.match(r"[\w-]", text[i + len(p)] if i + len(p) < len(text) else ""):
                errs.append(f"{at} names the file {p}; places belong in evidence"); break
    return errs


def reference_errors(m: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    caps = [c["id"] for c in m.get("capabilities", [])]
    if len(caps) != len(set(caps)):
        errs.append("duplicate capability id")
    sig = {}
    for s in m.get("signals", []):
        if s["name"] in sig:
            errs.append(f"duplicate signal {s['name']}")
        if s["capability_id"] not in caps:
            errs.append(f"signal {s['name']}: unknown capability {s['capability_id']}")
        sig[s["name"]] = s["capability_id"]
    rules = set()
    for r in m.get("rules", []):
        if r["id"] in rules:
            errs.append(f"duplicate rule {r['id']}")
        rules.add(r["id"])
        if r["capability_id"] not in caps:
            errs.append(f"rule {r['id']}: unknown capability {r['capability_id']}")
        if r["trigger"] == r["expect"]:
            errs.append(f"rule {r['id']}: trigger equals expect")
        for name in (r["trigger"], r["expect"]):
            if name not in sig:
                errs.append(f"rule {r['id']}: unknown signal {name}")
            elif sig[name] != r["capability_id"]:
                errs.append(f"rule {r['id']}: signal {name} belongs to {sig[name]}")
    # 1.1-r0: steps and successors (only within the same flow), components (flows and dependencies resolvable); as in the contracts
    for c in m.get("capabilities", []):
        steps = c.get("steps") or []
        ids = [st["id"] for st in steps]
        if len(ids) != len(set(ids)):
            errs.append(f"capability {c['id']}: duplicate step id")
        used: set[str] = set()
        for st in steps:
            sname = st.get("signal")
            if sname is not None:
                if sname not in sig:
                    errs.append(f"capability {c['id']}: step {st['id']} references unknown signal {sname}")
                elif sig[sname] != c["id"]:
                    errs.append(f"capability {c['id']}: step {st['id']} references signal {sname} of {sig[sname]}")
                if sname in used:
                    errs.append(f"capability {c['id']}: signal {sname} used by two steps")
                used.add(sname)
            for n in st.get("next") or []:
                if n == st["id"]:
                    errs.append(f"capability {c['id']}: step {st['id']} points to itself")
                elif n not in ids:
                    errs.append(f"capability {c['id']}: step {st['id']} references unknown next step {n}")
    comps = [k["id"] for k in m.get("components") or []]
    if len(comps) != len(set(comps)):
        errs.append("duplicate component id")
    for k in m.get("components") or []:
        for cid in k.get("capabilities") or []:
            if cid not in caps:
                errs.append(f"component {k['id']}: unknown capability {cid}")
        for d in k.get("depends_on") or []:
            if d == k["id"]:
                errs.append(f"component {k['id']} depends on itself")
            elif d not in comps:
                errs.append(f"component {k['id']}: unknown dependency {d}")
    if m.get("schema_version") == "1.0-r0" and (m.get("people") or m.get("app") or m.get("components") or any(c.get("steps") or c.get("description") for c in m.get("capabilities", []))):
        errs.append("1.1-r0 fields (app, people, components, description, steps) require schema_version 1.1-r0")
    # 1.2-r0: object types and adapters unique, adapters only on known flows, matching version
    seen_obj: set[str] = set()
    for o in m.get("objects", []) or []:
        if o["type"] in seen_obj:
            errs.append(f"duplicate object type {o['type']}")
        seen_obj.add(o["type"])
        seen_status: set[str] = set()
        for st in o.get("statuses", []):
            if st["value"] in seen_status:
                errs.append(f"object {o['type']}: duplicate status {st['value']}")
            seen_status.add(st["value"])
    seen_ad: set[str] = set()
    for a in m.get("adapters", []) or []:
        if a["id"] in seen_ad:
            errs.append(f"duplicate adapter {a['id']}")
        seen_ad.add(a["id"])
        for cid in a.get("capabilities", []) or []:
            if cid not in caps and cid not in ADAPTER_FEATURES:
                errs.append(f"adapter {a['id']}: unknown capability {cid}")
    versions = list(_schema()["properties"]["schema_version"]["enum"])   # one source: the shipped schema
    def at_least(v: str) -> bool:
        have = m.get("schema_version")
        return have in versions and versions.index(have) >= versions.index(v)
    if m.get("objects") and not at_least("1.2-r0"):
        errs.append("objects require schema_version 1.2-r0")
    if m.get("adapters") and not at_least("1.2-r0"):
        errs.append("adapters require schema_version 1.2-r0")
    if (m.get("people") or {}).get("source") == "read_bridge" and not at_least("1.2-r0"):
        errs.append("people.source read_bridge requires schema_version 1.2-r0")
    # 1.4-r0: analytics and actions only on declared objects, fields, statuses, flows (mirror of contracts)
    objs = {o.get("type"): o for o in m.get("objects", []) or []}
    cap_ids = {c.get("id") for c in m.get("capabilities", [])}
    def field_kind(o, f):
        if f == "status":
            return "status"
        return next((x.get("kind") for x in o.get("fields", []) or [] if x.get("name") == f), None)
    seen_an = set()
    for a in m.get("analytics", []) or []:
        aid = a.get("id")
        if aid in seen_an:
            errs.append(f"duplicate analytic {aid}")
        seen_an.add(aid)
        kind, src = a.get("kind"), a.get("source", {}) or {}
        if kind in ("inventory_count", "inventory_breakdown"):
            o = objs.get(src.get("object_type"))
            if not o:
                errs.append(f"analytic {aid}: unknown object type {src.get('object_type') or '(none)'}")
                continue
            for fl in a.get("filter", []) or []:
                k = field_kind(o, fl.get("field"))
                if not k:
                    errs.append(f"analytic {aid}: unknown field {fl.get('field')}")
                    continue
                if fl.get("op") in ("is_true", "is_false") and k != "boolean":
                    errs.append(f"analytic {aid}: {fl.get('op')} needs a boolean field ({fl.get('field')})")
                if k == "status":
                    vals = fl.get("value") if isinstance(fl.get("value"), list) else [fl.get("value")]
                    for v in vals:
                        if not any(x.get("value") == v for x in o.get("statuses", [])):
                            errs.append(f"analytic {aid}: unknown status {v}")
            if kind == "inventory_breakdown" and (not a.get("group_by") or not field_kind(o, a.get("group_by")) or field_kind(o, a.get("group_by")) == "date"):
                errs.append(f"analytic {aid}: group_by must be status or a declared non-date field")
            if a.get("created_field") and field_kind(o, a.get("created_field")) != "date":
                errs.append(f"analytic {aid}: created_field must be a declared date field")
        else:
            if kind == "run_count" and src.get("capability_id") not in cap_ids:
                errs.append(f"analytic {aid}: unknown capability {src.get('capability_id') or '(none)'}")
            if kind == "people_count" and src.get("with") == "errors" and (a.get("window_days") or 7) > 7:
                errs.append(f"analytic {aid}: error events are kept 7 days; window_days must be <= 7")
            if not a.get("window_days"):
                errs.append(f"analytic {aid}: {kind} needs window_days")
    ac_ids = {x.get("id") for x in m.get("actions", []) or []}
    for x in m.get("actions", []) or []:
        t = x.get("target", {}) or {}
        if t.get("kind") == "object":
            o = objs.get(t.get("object_type"))
            if not o:
                errs.append(f"action {x.get('id')}: unknown object type {t.get('object_type')}")
                continue
            if not str(x.get("capability", "")).startswith(f"object.{t.get('object_type')}."):
                errs.append(f"action {x.get('id')}: capability must be object.{t.get('object_type')}.<name>")
            for st in (x.get("from_statuses") or []) + ([x["to_status"]] if x.get("to_status") else []):
                if not any(v.get("value") == st for v in o.get("statuses", [])):
                    errs.append(f"action {x.get('id')}: unknown status {st}")
        else:
            cap = str(x.get("capability", ""))
            if not cap.startswith("access.") and not cap.startswith("person."):
                errs.append(f"action {x.get('id')}: person actions use access.* or person.* capabilities")
            if cap.startswith("person.") and not at_least("1.9-r0"):
                errs.append(f"action {x.get('id')}: person.* actions require schema_version 1.9-r0")
            if x.get("from_statuses") or x.get("to_status"):
                errs.append(f"action {x.get('id')}: person actions have no object statuses")
        for r in reverses_of(x):
            if r not in ac_ids:
                errs.append(f"action {x.get('id')}: reverses unknown action {r}")
            elif r == x.get("id"):
                errs.append(f"action {x.get('id')}: reverses itself")
        if isinstance(x.get("reverses"), list) and not at_least("1.9-r0"):
            errs.append(f"action {x.get('id')}: reverses as a list requires schema_version 1.9-r0")
    if (m.get("analytics") or m.get("actions")) and not at_least("1.4-r0"):
        errs.append("analytics/actions require schema_version 1.4-r0")
    # 1.5-r0: status lifecycle group
    if any(st.get("lifecycle") for o in m.get("objects", []) or [] for st in o.get("statuses", []) or []) and not at_least("1.5-r0"):
        errs.append("status lifecycle requires schema_version 1.5-r0")
    # 1.6-r0: display hint for the icon of the object type
    if any(o.get("icon") for o in m.get("objects", []) or []) and not at_least("1.6-r0"):
        errs.append("object icon requires schema_version 1.6-r0")
    # 1.7-r0: risk level and undo window of actions
    actions = m.get("actions", []) or []
    if any(a.get("risk") or "undo_seconds" in a for a in actions) and not at_least("1.7-r0"):
        errs.append("action risk/undo_seconds require schema_version 1.7-r0")
    for a in actions:
        if "undo_seconds" in a and (a.get("risk") or "amber") != "amber":
            errs.append(f"action {a.get('id')}: undo_seconds only applies to amber actions")
    # 1.9-r0: jobs: unique id, readable rhythm, known component (mirror of contracts)
    jobs = m.get("jobs", []) or []
    if jobs and not at_least("1.9-r0"):
        errs.append("jobs require schema_version 1.9-r0")
    comp_ids = {c.get("id") for c in m.get("components", []) or []}
    seen_jobs: set[str] = set()
    for j in jobs:
        if j.get("id") in seen_jobs:
            errs.append(f"duplicate job {j.get('id')}")
        seen_jobs.add(j.get("id"))
        try: readable = every_ok(str(j.get("every", "")))
        except RuntimeError as e: errs.append(f"job {j.get('id')}: everydeck rules: {e}"); continue
        if not readable:
            errs.append(f"job {j.get('id')}: every \"{j.get('every')}\" is neither a duration (15m, 1h, 1d) nor a five-field cron expression")
        if j.get("component") and j.get("component") not in comp_ids:
            errs.append(f"job {j.get('id')}: unknown component {j.get('component')}")
    # 1.9-r0: more object types, report reasons, person actions, long flows, browser failures (mirror of contracts)
    objects = m.get("objects", []) or []
    if len(objects) > 10 and not at_least("1.9-r0"):
        errs.append("more than 10 object types require schema_version 1.9-r0")
    if any(str(a.get("capability", "")).startswith("person.") for a in actions) and any(o.get("type") == "person" for o in objects):
        errs.append('object type "person" is reserved when person.* actions are declared')
    # 1.12-r0: no limit of 20 object types / 24 fields any more (guard 200 / 100 in the schema); link tables as relations[] (mirror of contracts)
    if len(objects) > 20 and not at_least("1.12-r0"):
        errs.append("more than 20 object types require schema_version 1.12-r0")
    for o in objects:
        if len(o.get("fields", []) or []) > 24 and not at_least("1.12-r0"):
            errs.append(f"object {o['type']}: more than 24 fields require schema_version 1.12-r0")
    relations = m.get("relations", []) or []
    if relations and not at_least("1.12-r0"):
        errs.append("relations require schema_version 1.12-r0")
    if any(o.get("technical") for o in objects) and not at_least("1.12-r0"):
        errs.append("object technical requires schema_version 1.12-r0")
    seen_rel: set[str] = set()
    for r in relations:
        rid = r.get("id")
        if rid in seen_rel:
            errs.append(f"duplicate relation {rid}")
        seen_rel.add(rid)
        if rid in objs:
            errs.append(f"relation {rid}: id collides with an object type")
        sides = r.get("sides", []) or []
        if len(sides) == 2 and sides[0].get("field") == sides[1].get("field"):
            errs.append(f"relation {rid}: both sides name the same field")
        for sd in sides:
            if sd.get("object_type") == "person":
                if not m.get("people"):
                    errs.append(f"relation {rid}: side {sd.get('field')} names person, but the manifest has no people block")
            elif sd.get("object_type") not in objs:
                errs.append(f"relation {rid}: side {sd.get('field')} names unknown object type {sd.get('object_type')}")
    for o in objects:
        for f in o.get("fields", []) or []:
            reasons = f.get("reasons")
            if reasons is not None:
                if f.get("role") != "moderation.signal":
                    errs.append(f"object {o['type']}: field {f['name']} has reasons without role moderation.signal")
                if not at_least("1.9-r0"):
                    errs.append(f"object {o['type']}: field {f['name']} reasons require schema_version 1.9-r0")
                values = [r.get("value") for r in reasons]
                if len(values) != len(set(values)):
                    errs.append(f"object {o['type']}: field {f['name']} has duplicate reason values")
            if any(g not in ("duplicate", "fraud", "other") for g in (f.get("signals") or {}).values()) and not at_least("1.9-r0"):
                errs.append(f"object {o['type']}: field {f['name']} signal groups beyond duplicate/fraud/other require schema_version 1.9-r0")
    for s in m.get("signals", []):   # ES1: the browser key may send this signal (the result of a flow in browser code)
        if s.get("allowed_source") == "browser" and not at_least("1.12-r0"):
            errs.append(f"signal {s['name']}: allowed_source browser requires schema_version 1.12-r0")
    browser_errors: set[str] = set()
    for c in m.get("capabilities", []):
        if "expected_duration" in c:
            if not at_least("1.9-r0"):
                errs.append(f"capability {c['id']}: expected_duration requires schema_version 1.9-r0")
            if iso_duration_seconds(c.get("expected_duration")) is None:
                errs.append(f"capability {c['id']}: expected_duration {c.get('expected_duration')} is not an ISO 8601 duration")
        for st in c.get("steps", []) or []:
            be = st.get("browser_error")
            if be is None:
                continue
            if not at_least("1.9-r0"):
                errs.append(f"capability {c['id']}: step {st['id']} browser_error requires schema_version 1.9-r0")
            if st.get("role") != "failure" or st.get("signal"):
                errs.append(f"capability {c['id']}: browser_error only on a failure step without a server signal ({st['id']})")
            if be in browser_errors:
                errs.append(f"browser_error {be} used by two steps")
            browser_errors.add(be)
    # 1.11-r0: field kinds, rules, editability, manage block (mirror of contracts)
    v111 = at_least("1.11-r0")
    locked_roles = LOCKED_ROLES
    for o in objects:
        field_names = {f.get("name") for f in o.get("fields", []) or []}
        status_values = {st.get("value") for st in o.get("statuses", []) or []}
        editable = {f.get("name") for f in o.get("fields", []) or [] if field_editable(o, f)}   # editable by default; locked by role, managed_in, a missing manage block or the agent
        for f in o.get("fields", []) or []:
            at = f"object {o.get('type')}: field {f.get('name')}"
            kind = f.get("kind")
            if kind not in ("string", "number", "boolean", "date") and not v111:
                errs.append(f"{at}: kind {kind} requires schema_version 1.11-r0")
            if kind == "enum" and not f.get("values"):
                errs.append(f"{at}: kind enum needs values from the code")
            if kind != "enum" and f.get("values") is not None:
                errs.append(f"{at}: values only with kind enum")
            if f.get("values") and len({v.get("value") for v in f["values"]}) != len(f["values"]):
                errs.append(f"{at}: duplicate enum value")
            if kind == "money" and not f.get("currency") and not f.get("currency_field"):
                errs.append(f"{at}: kind money needs currency (ISO 4217) or currency_field")
            if kind != "money" and (f.get("currency") or f.get("currency_field")):
                errs.append(f"{at}: currency only with kind money")
            if f.get("currency") and f.get("currency_field"):
                errs.append(f"{at}: currency or currency_field, not both")
            if f.get("currency_field") and f["currency_field"] not in field_names:
                errs.append(f"{at}: currency_field {f['currency_field']} is not a declared field")
            if (f.get("edit") or f.get("managed_in")) and not v111:
                errs.append(f"{at}: edit/managed_in require schema_version 1.11-r0")
            ed = f.get("edit") or {}
            if ed.get("editable") and f.get("role") in locked_roles:
                errs.append(f"{at}: a field with role {f.get('role')} is never editable (identifiers, references and owners)")
            if ed.get("editable") and f.get("managed_in"):
                errs.append(f"{at}: managed_in and editable exclude each other")
            if ed.get("editable") and not o.get("manage"):
                errs.append(f"{at}: editable needs objects[].manage (the door the change goes through)")
            if ed and not ed.get("editable") and not ed.get("reason"):
                errs.append(f"{at}: locking a field (editable: false) needs a reason")
        mg = o.get("manage")
        if not mg:
            continue
        if not v111:
            errs.append(f"object {o.get('type')}: manage requires schema_version 1.11-r0")

        def names(what: str, lst, allowed: set, noun: str) -> None:
            for n in lst or []:
                if n not in allowed:
                    errs.append(f"object {o.get('type')}: manage.{what} names {noun} {n} that is not declared")
        names("create.fields", (mg.get("create") or {}).get("fields"), field_names, "field")
        names("bulk.fields", (mg.get("bulk") or {}).get("fields"), editable, "editable field")
        names("bulk.statuses", (mg.get("bulk") or {}).get("statuses"), status_values, "status")
        names("export.fields", (mg.get("export") or {}).get("fields"), field_names, "field")
        names("import.fields", (mg.get("import") or {}).get("fields"), field_names, "field")
        if mg.get("archive") and mg["archive"].get("to_status") not in status_values:
            errs.append(f"object {o.get('type')}: manage.archive.to_status {mg['archive'].get('to_status')} is not a declared status")
        if mg.get("bulk") and not mg["bulk"].get("fields") and not mg["bulk"].get("statuses"):
            errs.append(f"object {o.get('type')}: manage.bulk needs fields or statuses it may set")
        if mg.get("create") and not editable and not mg["create"].get("fields"):
            errs.append(f"object {o.get('type')}: manage.create needs editable fields or create.fields")
        for k, op in mg.items():
            if k != "door" and isinstance(op, dict) and (op.get("door") or {}).get("kind") == "built" and not op["door"].get("test"):
                errs.append(f"object {o.get('type')}: manage.{k} door built needs a test in the app")
        if (mg.get("door") or {}).get("kind") == "built" and not mg["door"].get("test"):
            errs.append(f"object {o.get('type')}: manage.door built needs a test in the app (test.path)")
    pm = (m.get("people") or {}).get("manage")
    if pm:
        if not v111:
            errs.append("people.manage requires schema_version 1.11-r0")
        pfields = (m.get("people") or {}).get("fields") or []
        efields = (pm.get("edit") or {}).get("fields") or []
        for f in efields:
            if f not in pfields:
                errs.append(f"people.manage.edit names field {f} that is not declared")
            if f in ("provider_user_id", "email", "login_method"):
                errs.append(f"people.manage.edit: {f} is login data; never editable directly (email only through support.change_email)")
        for f in (pm.get("bulk") or {}).get("fields") or []:
            if f not in efields:
                errs.append(f"people.manage.bulk names field {f} that is not editable")
        if (pm.get("door") or {}).get("kind") == "built" and not pm["door"].get("test"):
            errs.append("people.manage.door built needs a test in the app (test.path)")
        if pm.get("support") and (m.get("people") or {}).get("provider") != "supabase_auth" and not (m.get("people") or {}).get("note"):
            errs.append("people.manage.support needs provider supabase_auth or a note naming the login provider that offers these actions")
    # 1.10-r0: platforms unique; flows and actions name only declared platforms (mirror of contracts)
    platforms = m.get("platforms", []) or []
    declared_pl = {p.get("id") for p in platforms}
    if platforms and not at_least("1.10-r0"):
        errs.append("platforms require schema_version 1.10-r0")
    if len(declared_pl) != len(platforms):
        errs.append("duplicate platform")
    for p in platforms:
        if p.get("store_status") and p.get("id") not in ("ios", "android", "desktop", "extension"):
            errs.append(f"platform {p.get('id')}: store_status only for app stores (ios, android, desktop, extension)")
    for what, lst in [(f"capability {c.get('id')}", c.get("platforms")) for c in m.get("capabilities", [])] + [(f"action {a.get('id')}", a.get("platforms")) for a in actions]:
        if lst is None:
            continue
        if not at_least("1.10-r0"):
            errs.append(f"{what}: platforms require schema_version 1.10-r0")
        for pl in lst:
            if pl not in declared_pl:
                errs.append(f"{what}: platform {pl} is not declared in platforms")
    # 1.10-r0: API patterns unique per method, parameters unique per pattern (mirror of contracts)
    api_routes = m.get("api_routes", []) or []
    if api_routes and not at_least("1.10-r0"):
        errs.append("api_routes require schema_version 1.10-r0")
    seen_api: set[str] = set()
    for r in api_routes:
        k = f"{r.get('method') or '*'} {r.get('pattern', '')}"
        if k in seen_api:
            errs.append(f"duplicate api route {k}")
        seen_api.add(k)
        params = [x for x in r.get("pattern", "").split("/") if x.startswith(":")]
        if len(set(params)) != len(params):
            errs.append(f"api route {r.get('pattern')}: a parameter name appears twice")
    # 1.10-r0: screen patterns unique, parameters unique per pattern, platforms declared (mirror of contracts)
    screens = m.get("screens", []) or []
    if screens and not at_least("1.10-r0"):
        errs.append("screens require schema_version 1.10-r0")
    seen_screens: set[str] = set()
    for sc in screens:
        pat = sc.get("pattern", "")
        if pat in seen_screens:
            errs.append(f"duplicate screen {pat}")
        seen_screens.add(pat)
        params = [x for x in pat.split("/") if x.startswith(":")]
        if len(set(params)) != len(params):
            errs.append(f"screen {pat}: a parameter name appears twice")
        for pl in sc.get("platforms", []) or []:
            if pl not in declared_pl:
                errs.append(f"screen {pat}: platform {pl} is not declared in platforms")
    # 1.3-r0: declared alternative outcome; needs a server signal
    for c in m.get("capabilities", []):
        for st in c.get("steps", []) or []:
            if st.get("role") != "alternative":
                continue
            if not at_least("1.3-r0"):
                errs.append(f"capability {c.get('id')}: step role alternative requires schema_version 1.3-r0")
            if not st.get("signal"):
                errs.append(f"capability {c.get('id')}: alternative step {st.get('id')} needs a server signal")
    errs += description_path_errors(m)   # like descriptionPathErrors in the contracts
    return errs


def canonical(v: Any) -> str:
    """Canonical form like `canonicalJson` in everydeck's contracts: sorted keys, no whitespace, Unicode unchanged
    (JSON.stringify does not escape non-ASCII characters, hence `ensure_ascii=False`; otherwise the digest differs from the server)."""
    if isinstance(v, list):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical(v[k]) for k in sorted(v)) + "}"
    return json.dumps(v, ensure_ascii=False)


def digest(manifest: dict[str, Any]) -> str:
    """SHA-256 over the canonical JSON form; identical to `canonicalJson` in everydeck's contracts."""
    return hashlib.sha256(canonical(manifest).encode("utf-8")).hexdigest()


@dataclass
class Finding:
    kind: str          # missing_file | missing_symbol | signal_not_in_symbol | call_sites_decreased | new_build | job_not_in_heartbeat | screen_not_in_code | api_route_not_in_code
    signal: str
    where: str


@dataclass
class DriftReport:
    head: str | None
    findings: list[Finding] = field(default_factory=list)
    call_sites: dict[str, int] = field(default_factory=dict)

    @property
    def status(self) -> str:
        if not self.findings:
            return "ok"
        if all(f.kind == "new_build" for f in self.findings):
            return "revision_only"
        return "drift"


def _find_symbol(tree: ast.AST, symbol: str) -> ast.AST | None:
    node: ast.AST = tree
    for part in symbol.split("."):
        found = None
        children = ast.walk(node) if node is tree else ast.iter_child_nodes(node)
        for child in children:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and child.name == part:
                found = child
                break
        if found is None:
            return None
        node = found
    return node


def _symbol_in_text(text: str, symbol: str) -> bool:
    import re as _re
    for part in symbol.split("."):
        if not _re.search(r"(?<![A-Za-z0-9_])" + _re.escape(part) + r"(?![A-Za-z0-9_])", text):
            return False
    return True


def _count_calls(fn: ast.AST, name: str) -> int:
    n = 0
    for x in ast.walk(fn):
        if isinstance(x, ast.Call) and isinstance(x.func, ast.Attribute) and x.func.attr in ("signal", "error", "log") and x.args:
            a = x.args[0]
            if isinstance(a, ast.Constant) and a.value == name:
                n += 1
    return n


def git_head(repo: Path) -> str | None:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return None


def check_drift(repo: Path, manifest: dict[str, Any], lock: dict[str, int] | None = None) -> DriftReport:
    rep = DriftReport(head=git_head(repo))
    for s in manifest.get("signals", []):
        loc = s["location"]
        key = f"{s['name']}@{loc['path']}::{loc['symbol']}"
        f = repo / loc["path"]
        if not f.exists():
            rep.findings.append(Finding("missing_file", s["name"], loc["path"]))
            continue
        if f.suffix != ".py":
            # Language-independent check for other files (TypeScript, SQL, Deno): the symbol exists as a word, the signal name as a
            # literal in the file; call sites = occurrences of the literal. Less precise than the Python AST path, but mechanical drift
            # (file gone, symbol renamed, signal removed) is detected.
            text = f.read_text(encoding="utf-8", errors="replace")
            if not _symbol_in_text(text, loc["symbol"]):
                rep.findings.append(Finding("missing_symbol", s["name"], f"{loc['path']}::{loc['symbol']}"))
                continue
            n = text.count(f"'{s['name']}'") + text.count(f'"{s["name"]}"') + text.count(f"`{s['name']}`")
            rep.call_sites[key] = n
            if n == 0:
                rep.findings.append(Finding("signal_not_in_symbol", s["name"], f"{loc['path']}::{loc['symbol']}"))
                continue
            if lock is not None and key in lock and n < lock[key]:
                rep.findings.append(Finding("call_sites_decreased", s["name"], f"{loc['path']}::{loc['symbol']} {lock[key]}→{n}"))
            if rep.head and loc["commit"] != rep.head:
                rep.findings.append(Finding("new_build", s["name"], f"manifest@{loc['commit'][:7]} repo@{rep.head[:7]}"))
            continue
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"))
        except SyntaxError as e:
            rep.findings.append(Finding("missing_symbol", s["name"], f"{loc['path']}: syntax error {e.lineno}"))
            continue
        node = _find_symbol(tree, loc["symbol"])
        if node is None:
            rep.findings.append(Finding("missing_symbol", s["name"], f"{loc['path']}::{loc['symbol']}"))
            continue
        n = _count_calls(node, s["name"])
        rep.call_sites[key] = n
        if n == 0:
            rep.findings.append(Finding("signal_not_in_symbol", s["name"], f"{loc['path']}::{loc['symbol']}"))
            continue
        if lock is not None and key in lock and n < lock[key]:
            rep.findings.append(Finding("call_sites_decreased", s["name"], f"{loc['path']}::{loc['symbol']} {lock[key]}→{n}"))
        if rep.head and loc["commit"] != rep.head:
            rep.findings.append(Finding("new_build", s["name"], f"manifest@{loc['commit'][:7]} repo@{rep.head[:7]}"))
    check_jobs(repo, manifest, rep)
    check_screens(repo, manifest, rep)
    return rep


_RELAY_CALL = re.compile(r"(?:relayOnce|createRelayHandler)\s*\(")
# The SDK command for plain PostgreSQL (`npx everydeck-outbox-relay`) in a start file of the app, not a name inside a path
_RELAY_COMMAND = re.compile(r"(?<![\w/.-])everydeck-outbox-relay(?![\w/.-])")
_START_FILES = {"package.json", "Procfile", "Dockerfile"}


def _relay_in_text(path: Path, text: str) -> bool:
    """A relay of the app: relayOnce( (older copied relay) or createRelayHandler( (Supabase function from @everydeck/sdk/outbox), or the command
    `everydeck-outbox-relay` in a start file (package.json, Procfile, Dockerfile, *.yml/*.yaml/*.toml)."""
    if path.suffix in {".mjs", ".js", ".ts"} and _RELAY_CALL.search(text): return True
    return (path.name in _START_FILES or path.suffix in {".yml", ".yaml", ".toml"}) and bool(_RELAY_COMMAND.search(text))


def _relay_in_repo(repo: Path) -> bool:
    """A relay of the app anywhere in the repository; not in the bundle under vendor/, not in node_modules."""
    skip = {".git", "node_modules", "vendor", "dist", "build", ".next", "__pycache__", ".venv"}
    for f in repo.rglob("*"):
        if not f.is_file() or any(p in skip for p in f.relative_to(repo).parts): continue
        if f.suffix not in {".mjs", ".js", ".ts", ".yml", ".yaml", ".toml"} and f.name not in _START_FILES: continue
        try:
            if _relay_in_text(f, f.read_text(encoding="utf-8", errors="replace")): return True
        except OSError:
            continue
    return False


def check_jobs(repo: Path, manifest: dict[str, Any], rep: DriftReport) -> None:
    """Every place of a job must contain a heartbeat call with exactly this job id (all languages, text check). A schedule in SQL beats through the
    outbox (everydeck_outbox.run_job('<id>', …) or everydeck_outbox.job_heartbeat('<id>')), a run outside the app with a check-in step that calls
    …/v1/jobs/<id>/check-in."""
    import re as _re
    for j in manifest.get("jobs", []) or []:
        jid = j.get("id", "")
        call = _re.compile(r"(?:heartbeat\w*|run_job)\s*\([^)]*?[\"'`]" + _re.escape(jid) + r"[\"'`]", _re.S)
        checkin = _re.compile(r"/v1/jobs/" + _re.escape(jid) + r"/check-in(?![\w-])")
        for ev in j.get("evidence", []) or []:
            f = repo / ev["path"]
            if not f.exists():
                rep.findings.append(Finding("missing_file", f"job:{jid}", ev["path"]))
                continue
            text = f.read_text(encoding="utf-8", errors="replace")
            if ev.get("symbol") and not _symbol_in_text(text, ev["symbol"]):
                rep.findings.append(Finding("missing_symbol", f"job:{jid}", f"{ev['path']}::{ev['symbol']}"))
                continue
            # The outbox relay sends the beat in relayOnce (default id everydeck_outbox_relay or job: '<id>')
            relay = _relay_in_text(f, text) and (jid == "everydeck_outbox_relay" or _re.search(r"job\s*:\s*[\"'`]" + _re.escape(jid) + r"[\"'`]", text))
            # The place of the relay job is often the schedule (pg_cron → Edge Function); the beat is then in the app's relay
            if not relay and jid == "everydeck_outbox_relay": relay = _relay_in_repo(repo)
            if not call.search(text) and not relay and not checkin.search(text):
                rep.findings.append(Finding("job_not_in_heartbeat", f"job:{jid}", ev["path"]))


_SCREEN_SKIP = {".git", "node_modules", "vendor", "dist", "build", ".next", ".expo", "everydeck", "coverage", "__pycache__", ".venv"}
_SCREEN_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".dart", ".json", ".py", ".html"}


def check_screens(repo: Path, manifest: dict[str, Any], rep: DriftReport) -> None:
    """Every declared screen and API pattern appears literally in the app's code, where it is passed to the browser SDK
    (`initEverydeckBrowser({ screens, apiRoutes })`). If it is missing, the SDK maps these addresses only to their first segment: no leak, but an
    imprecise path before the error or imprecise requests. API patterns of an app without the browser SDK are used only by everydeck on receipt; no check."""
    wanted = [("screen", s.get("pattern", "")) for s in manifest.get("screens", []) or []] + [("api", r.get("pattern", "")) for r in manifest.get("api_routes", []) or []]
    if not wanted:
        return
    found: set[str] = set(); browser = False
    for f in repo.rglob("*"):
        if any(part in _SCREEN_SKIP for part in f.relative_to(repo).parts) or not f.is_file() or f.suffix not in _SCREEN_EXT:
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        browser = browser or "initEverydeckBrowser" in text
        for _, p in wanted:
            if p not in found and (f"'{p}'" in text or f'"{p}"' in text or f"`{p}`" in text):
                found.add(p)
    for kind, p in wanted:
        if p in found or (kind == "api" and not browser):
            continue
        rep.findings.append(Finding("screen_not_in_code" if kind == "screen" else "api_route_not_in_code", f"{kind}:{p}",
                                    f"not passed to the SDK (initEverydeckBrowser({{ {'screens' if kind == 'screen' else 'apiRoutes'} }}))"))


def freeze_lock(report: DriftReport) -> dict[str, Any]:
    return {"version": 1, "head": report.head, "call_sites": dict(sorted(report.call_sites.items()))}
