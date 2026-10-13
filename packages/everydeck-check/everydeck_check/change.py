"""everydeck-check change: the understanding of a change comes from the coding agent, CI checks it mechanically.

The customer maintains an `everydeck-change.json` per relevant commit (schema `schemas/change.schema.json`). Checked are:
- shape (JSON Schema 2020-12, no extra fields),
- references: every `capability_id` is in the manifest, every evidence `path` is a file in the repo, a `symbol` appears
  as text in that file (plain text search with word boundaries; for `Class.method` it is enough that each part appears),
- binding: `sha` is `git rev-parse HEAD` of the repo (or the SHA passed explicitly), an optional `manifest_digest`
  is the digest of the given manifest.
What a diff check cannot do (detect new features on its own), it does not do here either: the
description comes from the agent, everydeck-check only makes sure it matches the revision, the build and the code.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from . import digest, git_head, reference_errors, validate_manifest

__all__ = ["validate_change", "check_change", "ChangeReport", "CHANGE_SCHEMA_VERSION"]

CHANGE_SCHEMA_VERSION = "1.0-r0"
_IDENT = r"[A-Za-z0-9_]"


def _schema() -> dict[str, Any]:
    return json.loads(resources.files("everydeck_check").joinpath("schemas/change.schema.json").read_text(encoding="utf-8"))


def validate_change(change: Any) -> list[str]:
    """Shape check against change.schema.json; error paths as in `validate_manifest` (`$` for the root)."""
    v = Draft202012Validator(_schema(), format_checker=FormatChecker())
    return [f"{'/'.join(str(p) for p in e.path) or '$'}: {e.message}" for e in v.iter_errors(change)]


def _symbol_in_text(text: str, symbol: str) -> bool:
    def word(s: str) -> bool:
        return re.search(rf"(?<!{_IDENT}){re.escape(s)}(?!{_IDENT})", text) is not None

    if word(symbol):
        return True
    parts = [p for p in symbol.split(".") if p]
    return len(parts) > 1 and all(word(p) for p in parts)


def _sha_matches(claimed: str, reference: str) -> bool:
    c, r = claimed.lower(), reference.lower()
    return len(c) >= 7 and r.startswith(c)


@dataclass
class ChangeReport:
    sha: str | None                      # SHA checked against (HEAD of the repo or --sha)
    digest_of_manifest: str | None
    errors: list[str] = field(default_factory=list)

    @property
    def status(self) -> str:
        return "ok" if not self.errors else "invalid"

    def as_dict(self) -> dict[str, Any]:
        return {"status": self.status, "errors": self.errors, "digest_of_manifest": self.digest_of_manifest, "sha": self.sha}


def check_change(change: Any, manifest: dict[str, Any], repo: Path, expected_sha: str | None = None) -> ChangeReport:
    """Full check of a change description against manifest and repo.

    `expected_sha` (CLI `--sha`) replaces `git rev-parse HEAD`; without either, the binding cannot be checked and is an error.
    """
    repo = Path(repo).resolve()
    reference_sha = expected_sha.strip() if expected_sha else git_head(repo)
    rep = ChangeReport(sha=reference_sha, digest_of_manifest=None)

    m_errs = validate_manifest(manifest) + reference_errors(manifest)
    if m_errs:
        rep.errors.extend(f"manifest: {e}" for e in m_errs)
    else:
        rep.digest_of_manifest = digest(manifest)

    schema_errs = validate_change(change)
    if schema_errs:
        rep.errors.extend(schema_errs)
        return rep  # structure unclear; reference checks would be noise

    caps = {c["id"] for c in manifest.get("capabilities", []) if isinstance(c, dict) and "id" in c}
    seen: set[str] = set()
    for i, a in enumerate(change["affected"]):
        cid = a["capability_id"]
        if cid not in caps:
            rep.errors.append(f"affected/{i}: unknown capability {cid} (not in manifest)")
        if cid in seen:
            rep.errors.append(f"affected/{i}: capability {cid} listed twice")
        seen.add(cid)
        for j, ev in enumerate(a["evidence"]):
            f = repo / ev["path"]
            if not f.is_file():
                rep.errors.append(f"affected/{i}/evidence/{j}: missing file {ev['path']}")
                continue
            sym = ev.get("symbol")
            if sym is None:
                continue
            try:
                text = f.read_text(encoding="utf-8", errors="replace")
            except OSError as e:
                rep.errors.append(f"affected/{i}/evidence/{j}: cannot read {ev['path']}: {e}")
                continue
            if not _symbol_in_text(text, sym):
                rep.errors.append(f"affected/{i}/evidence/{j}: symbol {sym} not found in {ev['path']}")

    if reference_sha is None:
        rep.errors.append(f"sha: cannot determine HEAD of {repo} (not a git checkout?); pass --sha explicitly")
    elif not _sha_matches(change["sha"], reference_sha):
        origin = "--sha" if expected_sha else "git rev-parse HEAD"
        rep.errors.append(f"sha: {change['sha']} does not match {origin} {reference_sha}")

    md = change.get("manifest_digest")
    if md is not None and rep.digest_of_manifest is not None and md != rep.digest_of_manifest:
        rep.errors.append(f"manifest_digest: {md} does not match digest of manifest {rep.digest_of_manifest}")
    return rep
