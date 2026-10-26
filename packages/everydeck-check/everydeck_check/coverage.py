"""Coverage table of the proposal (mirror of everydeck's coverage rules).

`coverage[]` in the proposal `{ manifest, local_check, coverage }`: every feature, object type, admin function and flow from the
inventory with its building block and exactly one outcome (managed, measured, hint, not_everydeck with a reason, later with a reason, false_positive with a reason and place: no such block) and a place. A detected
block with outcome managed/measured needs its required declaration in the manifest. The same messages as everydeck, so the agent sees them before
submitting.
"""
from __future__ import annotations

import re
from typing import Any

BLOCK_IDS = ("login", "people_roles", "organizations", "content_status", "moderation", "chats", "uploads", "search", "payments", "email",
             "push", "ai", "jobs", "imports", "bookings", "settings", "platforms")
COVERAGE_KINDS = ("feature", "object", "admin_function", "flow")
COVERAGE_OUTCOMES = ("managed", "measured", "hint", "not_everydeck", "later", "false_positive")   # false_positive: the hit is no such block; reason with a place
PUSH_REGISTER_CAPABILITY = "push.register_device"
MESSAGES_FEATURE = "messages"
_ID = re.compile(r"^[a-z][a-z0-9_.-]{0,95}$")


def validate_coverage(v: Any) -> tuple[list[dict[str, Any]], list[str]]:
    """Shape: returns (valid entries, errors)."""
    if v is None:
        return [], []
    if not isinstance(v, list) or len(v) > 400:
        return [], ["coverage must be an array of at most 400 entries"]
    errors: list[str] = []
    out: list[dict[str, Any]] = []
    ids: set[str] = set()
    for i, e in enumerate(v):
        o = e if isinstance(e, dict) else {}
        at = f"coverage {i}"
        mine: list[str] = []

        def s(k: str, mx: int) -> bool:
            return isinstance(o.get(k), str) and 1 <= len(o[k]) <= mx

        if not s("id", 96) or not _ID.match(o["id"]):
            mine.append(f"{at}: id missing or invalid")
        elif o["id"] in ids:
            mine.append(f"{at}: duplicate id {o['id']}")
        else:
            ids.add(o["id"])
        if o.get("kind") not in COVERAGE_KINDS:
            mine.append(f"{at}: kind must be one of {', '.join(COVERAGE_KINDS)}")
        if not s("label", 120):
            mine.append(f"{at}: label missing (max 120 chars)")
        if o.get("block") not in BLOCK_IDS:
            mine.append(f"{at}: block must be one of {', '.join(BLOCK_IDS)}")
        outcome = o.get("outcome")
        if outcome not in COVERAGE_OUTCOMES:
            mine.append(f"{at}: outcome must be one of {', '.join(COVERAGE_OUTCOMES)}; nothing is left without one")
        if outcome in ("not_everydeck", "later") and not s("reason", 600):
            mine.append(f"{at}: {outcome} needs a reason (max 600 chars)")
        if outcome == "false_positive" and not s("reason", 600):
            mine.append(f"{at}: false_positive needs a reason with the place in the code that shows why this is not {o.get('block')} (max 600 chars)")
        if o.get("kind") == "admin_function" and outcome != "managed" and not s("reason", 600):
            mine.append(f"{at}: an admin function of the app is either declared as an action (managed) or justified with a reason")
        for k in ("object_type", "capability_id", "action_id", "job_id"):
            if k in o and not (isinstance(o[k], str) and _ID.match(o[k])):
                mine.append(f"{at}: {k} invalid")
        ev = o.get("evidence")
        if not isinstance(ev, list) or len(ev) > 20 or not all(isinstance(x, dict) and isinstance(x.get("path"), str) and len(x["path"]) <= 512 and isinstance(x.get("commit"), str) and len(x["commit"]) >= 7 for x in ev):
            mine.append(f"{at}: evidence must be a list of {{ path, symbol?, commit }}")
        errors += mine
        if not mine:
            out.append(o)
    return out, errors


_COMPONENT_BLOCK = {"auth": "login", "mail": "email", "payments": "payments", "storage": "uploads", "queue": "jobs", "worker": "jobs"}
CORE_BLOCKS = ("login", "payments", "chats", "push", "platforms", "ai")


def manifest_blocks(m: dict[str, Any]) -> list[tuple[str, str]]:
    """Blocks the manifest itself reveals (mirror of manifestBlocks): (block, because)."""
    out: dict[str, str] = {}

    def add(b: str | None, why: str) -> None:
        if b and b not in out:
            out[b] = why

    for c in m.get("components", []) or []:
        add(_COMPONENT_BLOCK.get(c.get("kind")), f"component {c.get('id')} ({c.get('kind')})")
        text = f"{c.get('id')} {c.get('label', '')}"
        if re.search(r"push|fcm|apns", text, re.I):
            add("push", f"component {c.get('id')}")
        if c.get("kind") == "other" and re.search(r"\b(ai|llm|openai|anthropic|gemini|model)\b", text, re.I):
            add("ai", f"component {c.get('id')}")
    for c in m.get("capabilities", []) or []:
        k = c.get("kind"); cid = c.get("id", "")
        if k == "identity": add("login", f"flow {cid} (identity)")
        if k == "mail": add("email", f"flow {cid} (mail)")
        if k == "billing": add("payments", f"flow {cid} (billing)")
        if cid == PUSH_REGISTER_CAPABILITY or cid.startswith("push."): add("push", f"flow {cid}")
    if m.get("people"):
        add("people_roles", "people (identity source)")
    for o in m.get("objects", []) or []:
        roles = {f.get("role") for f in (o.get("fields") or [])}
        if "moderation.signal" in roles: add("moderation", f"object {o.get('type')} (moderation.signal)")
        if "person" in roles and "ref" in roles: add("chats", f"object {o.get('type')} (person + ref)")
        if o.get("area") == "revenue": add("payments", f"object {o.get('type')} (area revenue)")
        if "images" in roles: add("uploads", f"object {o.get('type')} (images)")
        if o.get("statuses"): add("content_status", f"object {o.get('type')} (statuses)")
    if m.get("jobs"): add("jobs", "jobs[]")
    if any(p.get("id") not in ("web", "server") for p in (m.get("platforms") or [])): add("platforms", "platforms[]")
    if any(MESSAGES_FEATURE in (a.get("capabilities") or []) for a in (m.get("adapters") or [])): add("chats", f"adapter feature {MESSAGES_FEATURE}")
    return list(out.items())


def coverage_questions(entries: list[dict[str, Any]]) -> list[str]:
    """Core blocks with later/not_everydeck: no question to the operator (decide instead of asking); everydeck shows the operator a visible
    hint with a prompt for the agent. Returned here as a note so the agent knows what the operator sees. false_positive shows nothing."""
    return [f"coverage {e['id']}: {e['block']} left out ({e['outcome']}); the owner sees a visible hint with a prompt for you, no question; your reason: {e.get('reason', '')}"
            for e in entries if e["outcome"] in ("later", "not_everydeck") and e["block"] in CORE_BLOCKS]


def coverage_errors(m: dict[str, Any], entries: list[dict[str, Any]], detected: list[tuple[str, str]] | None = None) -> list[str]:
    """Coverage against the manifest: independently detected blocks (manifest, repo scan) need an entry; references; required declarations (managed/measured)."""
    errs: list[str] = []
    covered = {e["block"] for e in entries}
    for b, why in manifest_blocks(m):
        if b not in covered:
            errs.append(f"coverage: block {b} is visible in the manifest ({why}) but has no entry; add one with its outcome")
    for b, where in (detected or []):
        if b not in covered:
            errs.append(f"coverage: block {b} was detected in the repository ({where}) but has no entry; add one with its outcome")
    objects = m.get("objects", []) or []
    caps = m.get("capabilities", []) or []
    actions = m.get("actions", []) or []
    jobs = m.get("jobs", []) or []

    def obj(t: str) -> dict[str, Any] | None:
        return next((o for o in objects if o.get("type") == t), None)

    def has_role(t: str, role: str) -> bool:
        o = obj(t)
        return bool(o) and any(f.get("role") == role for f in (o.get("fields") or []))

    for e in entries:
        at = f"coverage {e['id']}"
        if e.get("object_type") and not obj(e["object_type"]):
            errs.append(f"{at}: object_type {e['object_type']} is not declared in objects")
        if e.get("capability_id") and not any(c.get("id") == e["capability_id"] for c in caps):
            errs.append(f"{at}: capability_id {e['capability_id']} is not declared in capabilities")
        if e.get("action_id") and not any(a.get("id") == e["action_id"] for a in actions):
            errs.append(f"{at}: action_id {e['action_id']} is not declared in actions")
        if e.get("job_id") and not any(j.get("id") == e["job_id"] for j in jobs):
            errs.append(f"{at}: job_id {e['job_id']} is not declared in jobs")
        live = e["outcome"] in ("managed", "measured")
        if e["kind"] == "admin_function" and e["outcome"] == "managed" and not e.get("action_id"):
            errs.append(f"{at}: a managed admin function names its action_id")
        if e["kind"] == "object" and live and not e.get("object_type"):
            errs.append(f"{at}: an object entry names its object_type")
        if e["kind"] == "flow" and e["outcome"] == "measured" and not e.get("capability_id"):
            errs.append(f"{at}: a measured flow names its capability_id")
        if not live:
            continue
        b = e["block"]
        if b == "chats":
            if not any(MESSAGES_FEATURE in (a.get("capabilities") or []) for a in (m.get("adapters") or [])):
                errs.append(f"{at}: chats need message metadata: an adapter with feature `{MESSAGES_FEATURE}` (everydeck.messageSent in the app)")
            if e.get("object_type") and not (has_role(e["object_type"], "person") and has_role(e["object_type"], "ref")):
                errs.append(f"{at}: a conversation object needs fields with role person (the other party) and ref (what it is about)")
        elif b == "moderation":
            if e.get("object_type") and not has_role(e["object_type"], "moderation.signal"):
                errs.append(f"{at}: a moderation object needs a field with role moderation.signal (reports: the reason; duplicate flags: group duplicate)")
        elif b == "push":
            reg = next((c for c in caps if c.get("id") == PUSH_REGISTER_CAPABILITY), None)
            if not reg:
                errs.append(f"{at}: push needs the flow `{PUSH_REGISTER_CAPABILITY}` (register a device, with a result step); without it everydeck cannot verify a push repair")
            elif not any(s.get("role") == "result" and s.get("signal") for s in (reg.get("steps") or [])):
                errs.append(f"{at}: flow `{PUSH_REGISTER_CAPABILITY}` needs a result step with a server signal")
        elif b == "payments" and e["kind"] != "flow":   # a measured payment flow is no revenue claim
            # money outside the area too (a subscription on the organization), never the price list; the amount also from the price list
            rev = [o for o in objects if (o.get("area") == "revenue" or o.get("money")) and (o.get("money") or {}).get("holds") != "prices"]
            if not any((any(f.get("role") == "amount" for f in (o.get("fields") or [])) or (o.get("money") or {}).get("price")) and any(s.get("revenue") == "paying" for s in (o.get("statuses") or [])) for o in rev):
                errs.append(f"{at}: payments measured need a revenue object with role amount and a status with revenue paying, or outcome hint (then everydeck shows the revenue prompt)")
        elif b == "email":
            if not any(c.get("kind") == "mail" for c in caps):
                errs.append(f"{at}: e-mail needs a flow with kind mail (requested → handed over / failed)")
        elif b == "jobs":
            if not jobs:
                errs.append(f"{at}: jobs need `jobs[]` with their rhythm")
        elif b == "platforms":
            found = next((w for bb, w in (detected or []) if bb == "platforms"), None)
            if found and not any(p.get("id") not in ("web", "server") for p in (m.get("platforms") or [])):
                errs.append(f"{at}: an app platform was detected ({found}) but platforms[] declares none beyond web/server")
        elif b == "login":
            if not m.get("people") and not any(c.get("kind") == "identity" for c in caps):
                errs.append(f"{at}: login needs `people` (identity source) or a flow with kind identity")
        elif b == "people_roles":
            if not m.get("people"):
                errs.append(f"{at}: people need `people` with source and fields")
        elif b == "search":
            if e.get("object_type") and not has_role(e["object_type"], "group"):
                errs.append(f"{at}: search needs at least one field with role group on the searched object (what everydeck.search groups by)")
    return errs
