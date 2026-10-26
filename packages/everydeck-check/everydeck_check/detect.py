"""Independent detection of building blocks in the app's repository.

Instead of trusting the agent's list, everydeck-check reads dependencies and unambiguous code hints: package.json (also in subfolders such as
functions/ or apps/*), requirements*.txt and pyproject.toml, pubspec.yaml, Podfile and build.gradle, Expo and Capacitor configuration,
extension manifests; plus a few unambiguous imports in the code (firebase/messaging, firebase/auth, firebase/storage, supabase.auth, storage
clients). Every block detected this way must appear in the coverage table (with whatever outcome), otherwise `validate --repo` rejects.
Only what is unambiguous is detected; a hit is a hint with a place, not a verdict.

Schema detection: chats and moderation rarely live in a library, but almost always in the schema. So
everydeck-check reads table and collection names from SQL migrations (CREATE TABLE), Prisma (model, @@map), Drizzle (pgTable/mysqlTable/sqliteTable),
Supabase types (Database.public.Tables), SQLAlchemy (__tablename__), Firestore rules (match /name/{id}) and Firestore calls (collection('name'))
and maps the names word by word to blocks (SCHEMA_WORDS): messages/chats/conversations → chats, reports/flags/moderation → moderation,
bookings/reservations → bookings, subscriptions/invoices/payments → payments, push/device_tokens → push, organizations/teams/memberships →
organizations, settings/config → settings, uploads/files/attachments → uploads, users/accounts/sessions → login (own login with a session table),
people/members/roles → people_roles (compound names such as team_members count by their first word: organizations). Plus libraries and calls
for passwords and tokens (bcrypt, argon2, scrypt/pbkdf2, passlib, jsonwebtoken, jose, iron-session, lucia, passport) → login.
For a false hit the agent writes an entry not_everydeck with a reason.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

# limits of the scan (everydeck lists them with the other limits): what the scan does not read; the inventory names skipped files, never "not there"
CODE_FILE_MAX = 400_000      # code hints: larger source files are skipped
SCHEMA_FILE_MAX = 2_000_000  # schema detection: larger files are skipped
PACKAGE_DEPTH = 3            # package.json, requirements, pubspec: folders deeper than this are not read
SKIP_DIRS = {".git", "node_modules", "vendor", "dist", "build", ".next", ".expo", "coverage", "__pycache__", ".venv", "venv", "Pods", ".everydeck", "everydeck"}

# dependency → block (npm). Prefix match with "*".
NPM: dict[str, str] = {
    "stripe": "payments", "@stripe/*": "payments", "@paddle/*": "payments", "@lemonsqueezy/*": "payments", "@paypal/*": "payments", "razorpay": "payments", "@mollie/*": "payments",
    "openai": "ai", "@anthropic-ai/*": "ai", "@google/generative-ai": "ai", "@google/genai": "ai", "ai": "ai", "@ai-sdk/*": "ai", "langchain": "ai", "@langchain/*": "ai", "cohere-ai": "ai", "@mistralai/*": "ai", "replicate": "ai", "groq-sdk": "ai",
    "expo-notifications": "push", "@capacitor/push-notifications": "push", "@capacitor-firebase/messaging": "push", "@react-native-firebase/messaging": "push", "web-push": "push", "@onesignal/*": "push", "react-native-onesignal": "push", "react-native-push-notification": "push",
    "resend": "email", "postmark": "email", "nodemailer": "email", "@sendgrid/mail": "email", "mailgun.js": "email", "mailgun-js": "email", "@aws-sdk/client-ses": "email", "@getbrevo/*": "email", "node-mailjet": "email",
    "next-auth": "login", "@auth/*": "login", "@supabase/ssr": "login", "@supabase/auth-helpers-*": "login", "@clerk/*": "login", "passport": "login", "lucia": "login", "@workos-inc/*": "login", "auth0": "login", "@auth0/*": "login", "better-auth": "login", "firebase-admin": "login",
    "bcrypt": "login", "bcryptjs": "login", "@node-rs/bcrypt": "login", "argon2": "login", "@node-rs/argon2": "login", "scrypt-js": "login", "jsonwebtoken": "login", "jose": "login", "iron-session": "login", "@oslojs/*": "login", "oslo": "login", "express-session": "login", "@fastify/session": "login", "@fastify/jwt": "login", "@fastify/secure-session": "login",
    "@aws-sdk/client-s3": "uploads", "multer": "uploads", "@supabase/storage-js": "uploads", "cloudinary": "uploads", "uploadthing": "uploads", "@uploadthing/*": "uploads", "formidable": "uploads", "busboy": "uploads", "@vercel/blob": "uploads", "sharp": "uploads",
    "node-cron": "jobs", "cron": "jobs", "bull": "jobs", "bullmq": "jobs", "agenda": "jobs", "@temporalio/*": "jobs", "pg-boss": "jobs",
    "algoliasearch": "search", "meilisearch": "search", "typesense": "search", "@elastic/elasticsearch": "search",
    "socket.io": "chats", "pusher": "chats", "pusher-js": "chats", "ably": "chats", "stream-chat": "chats", "@stream-io/*": "chats", "sendbird": "chats", "@sendbird/*": "chats",
    "@capacitor/core": "platforms", "expo": "platforms", "react-native": "platforms", "electron": "platforms", "@tauri-apps/*": "platforms",
}
PY: dict[str, str] = {
    "stripe": "payments", "paddle": "payments", "openai": "ai", "anthropic": "ai", "google-generativeai": "ai", "google-genai": "ai", "cohere": "ai", "langchain": "ai", "mistralai": "ai",
    "resend": "email", "postmarker": "email", "sendgrid": "email", "python-postmark": "email", "mailjet-rest": "email", "brevo-python": "email",
    "supabase": "login", "firebase-admin": "login", "authlib": "login", "python-jose": "login", "pyjwt": "login", "passlib": "login", "bcrypt": "login", "argon2-cffi": "login", "flask-login": "login", "django-allauth": "login", "fastapi-users": "login",
    "boto3": "uploads", "cloudinary": "uploads", "pillow": "uploads",
    "celery": "jobs", "apscheduler": "jobs", "rq": "jobs", "dramatiq": "jobs", "arq": "jobs",
    "elasticsearch": "search", "meilisearch": "search", "algoliasearch": "search",
    "pyfcm": "push", "exponent-server-sdk": "push",
}
PUB: dict[str, str] = {"firebase_messaging": "push", "flutter_local_notifications": "push", "onesignal_flutter": "push", "firebase_auth": "login", "flutter_stripe": "payments", "stripe_flutter": "payments", "image_picker": "uploads", "firebase_storage": "uploads", "google_generative_ai": "ai", "flutter": "platforms"}
NATIVE: list[tuple[str, str]] = [("FirebaseMessaging", "push"), ("firebase-messaging", "push"), ("OneSignal", "push")]
# unambiguous imports/calls in the code
CODE: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"""['"]firebase/messaging['"]|getMessaging\("""), "push", "firebase/messaging"),
    (re.compile(r"""['"]firebase/auth['"]|firebase-admin/auth|signInWithEmailAndPassword\(|signInWithPopup\("""), "login", "firebase/auth"),
    (re.compile(r"""\.auth\.(signInWith|signUp|getUser|getSession|admin)\w*\("""), "login", "auth client (.auth.signIn/.getUser)"),
    (re.compile(r"""\b(?:scrypt|scryptSync|pbkdf2|pbkdf2Sync|hashpw|checkpw|hash_password|verify_password|PasswordHasher)\(|\bargon2\.(?:hash|verify)\(|\bbcrypt\.(?:hash|compare)\w*\("""), "login", "password hashing (scrypt/pbkdf2/bcrypt/argon2)"),
    (re.compile(r"""\bjwt\.(?:sign|verify|encode|decode)\(|\bSignJWT\(|\bjwtVerify\("""), "login", "jwt sign/verify"),
    (re.compile(r"""['"]firebase/storage['"]|\.storage\.from\(|\.storage\.from_\(|getStorage\(|S3Client\("""), "uploads", "storage client (.storage.from / S3Client)"),
    (re.compile(r"""stripe\.Webhook\.construct_event|stripe\.webhooks\.constructEvent|/webhooks?/stripe|/stripe/webhooks?|stripe-signature"""), "payments", "stripe webhook"),
]
CODE_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".dart", ".vue", ".svelte"}
# packages imported by URL or with a runtime prefix (Deno, Supabase Edge Functions): npm:x, jsr:x, https://esm.sh/x, skypack, esm.run, jsdelivr, unpkg.
# An Edge Function that imports its mail provider as https://esm.sh/resend@4.0.0 has no package.json that names it.
URL_IMPORT = re.compile(r"""['"](?:npm:|jsr:|https?://(?:esm\.sh|cdn\.skypack\.dev|esm\.run|cdn\.jsdelivr\.net/npm|unpkg\.com)/)(@[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+)""")
# a provider called over HTTP without its package (for example push sent with fetch to fcm.googleapis.com): host → block, provider
HOSTS: list[tuple[str, str, str]] = [
    ("api.resend.com", "email", "resend"), ("api.sendgrid.com", "email", "sendgrid"), ("api.postmarkapp.com", "email", "postmark"), ("api.mailgun.net", "email", "mailgun"), ("api.brevo.com", "email", "brevo"), ("api.mailjet.com", "email", "mailjet"),
    ("fcm.googleapis.com", "push", "fcm"), ("onesignal.com/api", "push", "onesignal"), ("exp.host/--/api/v2/push", "push", "expo push"),
    ("api.stripe.com", "payments", "stripe"), ("api.paddle.com", "payments", "paddle"), ("api.lemonsqueezy.com", "payments", "lemonsqueezy"), ("api.midtrans.com", "payments", "midtrans"), ("api.xendit.co", "payments", "xendit"),
    ("api.openai.com", "ai", "openai"), ("api.anthropic.com", "ai", "anthropic"), ("generativelanguage.googleapis.com", "ai", "google ai"),
]


def url_imports(text: str) -> list[str]:
    """Package names a file imports by URL or with npm:/jsr: (version and subpath dropped)."""
    return list(dict.fromkeys(m.group(1).split("@")[0] if not m.group(1).startswith("@") else m.group(1) for m in URL_IMPORT.finditer(text)))
# schema: word in the table/collection name (split at _ and CamelCase, singular and plural) → block
SCHEMA_WORDS: dict[str, str] = {
    "message": "chats", "messages": "chats", "chat": "chats", "chats": "chats", "conversation": "chats", "conversations": "chats",
    "report": "moderation", "reports": "moderation", "reporting": "moderation", "reportings": "moderation", "flag": "moderation", "flags": "moderation", "moderation": "moderation",
    "booking": "bookings", "bookings": "bookings", "reservation": "bookings", "reservations": "bookings",
    "subscription": "payments", "subscriptions": "payments", "invoice": "payments", "invoices": "payments", "payment": "payments", "payments": "payments",
    "push": "push",
    "organization": "organizations", "organizations": "organizations", "organisation": "organizations", "organisations": "organizations", "team": "organizations", "teams": "organizations", "member": "organizations", "members": "organizations", "membership": "organizations", "memberships": "organizations", "workspace": "organizations", "workspaces": "organizations",
    "setting": "settings", "settings": "settings", "config": "settings", "configs": "settings", "configuration": "settings", "configurations": "settings",
    "upload": "uploads", "uploads": "uploads", "file": "uploads", "files": "uploads", "attachment": "uploads", "attachments": "uploads",
    "user": "login", "users": "login", "account": "login", "accounts": "login", "session": "login", "sessions": "login",
    "people": "people_roles", "person": "people_roles", "persons": "people_roles", "member": "people_roles", "members": "people_roles", "role": "people_roles", "roles": "people_roles",
}
SCHEMA_NAMES: dict[str, str] = {"device_tokens": "push", "devices_tokens": "push", "fcm_tokens": "push", "apns_tokens": "push"}   # whole names
SQL_CREATE = re.compile(r"""create\s+table\s+(?:if\s+not\s+exists\s+)?(?:(?:"?[A-Za-z_][\w]*"?)\.)?"?([A-Za-z_][\w]*)"?""", re.I)
SQL_DROP = re.compile(r"""drop\s+table\s+(?:if\s+exists\s+)?(?:(?:"?[A-Za-z_][\w]*"?)\.)?"?([A-Za-z_][\w]*)"?""", re.I)
# ALTER TABLE x RENAME TO y: in the final state the table is named y (like DROP TABLE, in file order)
SQL_RENAME = re.compile(r"""alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:(?:"?[A-Za-z_][\w]*"?)\.)?"?([A-Za-z_][\w]*)"?\s+rename\s+to\s+"?([A-Za-z_][\w]*)"?""", re.I)
PRISMA_MODEL = re.compile(r"(?m)^\s*model\s+([A-Za-z_]\w*)\s*\{|@@map\(\s*['\"]([A-Za-z_]\w*)['\"]\s*\)")
DRIZZLE_TABLE = re.compile(r"""\b(?:pgTable|mysqlTable|sqliteTable)\(\s*['"]([A-Za-z_]\w*)['"]""")
SQLALCHEMY_TABLE = re.compile(r"""__tablename__\s*=\s*['"]([A-Za-z_]\w*)['"]""")
FIRESTORE_RULE = re.compile(r"match\s+/([A-Za-z_]\w*)/\{")
FIRESTORE_CALL = re.compile(r"""\bcollection\(\s*(?:[A-Za-z_]\w*\s*,\s*)?['"]([A-Za-z_]\w*)['"]""")


@dataclass
class Detected:
    block: str
    evidence: str


def _match(name: str, table: dict[str, str]) -> str | None:
    if name in table:
        return table[name]
    for k, v in table.items():
        if k.endswith("*") and name.startswith(k[:-1]):
            return v
    return None


def _walk(repo: Path, names: set[str], max_depth: int = PACKAGE_DEPTH):
    for p in repo.rglob("*"):
        rel = p.relative_to(repo)
        if any(part in SKIP_DIRS for part in rel.parts) or len(rel.parts) > max_depth or not p.is_file():
            continue
        if p.name in names:
            yield p, rel


def schema_block(name: str) -> str | None:
    """Block for a table/collection name; only by whole words, never by substrings (profiles is not files)."""
    low = name.lower()
    if low in SCHEMA_NAMES:
        return SCHEMA_NAMES[low]
    words = [w.lower() for w in re.findall(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])", name.replace("_", " "))]
    for w in words:
        if w in SCHEMA_WORDS:
            return SCHEMA_WORDS[w]
    return None


def _supabase_tables(text: str) -> list[str]:
    """Keys directly under `Tables: {` in generated Supabase types (Database.public.Tables); not Views, not Functions, no columns."""
    out: list[str] = []
    for m in re.finditer(r"Tables:\s*\{", text):
        depth = 0
        for line in text[m.end():].splitlines():
            if depth == 0 and (k := re.match(r"\s*([A-Za-z_]\w*)\s*:\s*\{", line)):
                out.append(k.group(1))
            depth += line.count("{") - line.count("}")
            if depth < 0:
                break
    return out


def detect_schema(repo: Path) -> list[tuple[str, str]]:
    """(block, place) from table and collection names; the first place per block."""
    found: dict[str, str] = {}

    def add(name: str, kind: str, rel: Path) -> None:
        b = schema_block(name)
        if b and b not in found:
            found[b] = f"{kind} {name} in {rel}"

    for p in sorted(repo.rglob("*")):
        rel = p.relative_to(repo)
        if any(part in SKIP_DIRS for part in rel.parts) or not p.is_file() or p.stat().st_size > SCHEMA_FILE_MAX:
            continue
        suf = p.suffix
        if suf not in {".sql", ".prisma", ".rules", ".py", ".ts", ".tsx", ".js", ".mjs", ".cjs"}:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if suf == ".sql":
            for name in SQL_CREATE.findall(text): add(name, "table", rel)
        elif suf == ".prisma":
            for a, b in PRISMA_MODEL.findall(text): add(a or b, "model", rel)
        elif suf == ".rules":
            for name in FIRESTORE_RULE.findall(text):
                if name not in ("databases", "documents"): add(name, "collection", rel)
        elif suf == ".py":
            for name in SQLALCHEMY_TABLE.findall(text): add(name, "table", rel)
        else:
            for name in DRIZZLE_TABLE.findall(text): add(name, "table", rel)
            if "Tables:" in text:
                for name in _supabase_tables(text): add(name, "table", rel)
            for name in FIRESTORE_CALL.findall(text): add(name, "collection", rel)
    return sorted(found.items())


def detect_blocks(repo: Path) -> list[Detected]:
    """Blocks from dependencies, configuration and unambiguous code hints; the first place per block."""
    found: dict[str, str] = {}

    def add(block: str, where: str) -> None:
        found.setdefault(block, where)

    for p, rel in _walk(repo, {"package.json"}):
        try:
            pkg = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
        for name in deps:
            b = _match(name, NPM)
            if b:
                add(b, f"{name} in {rel}")
    for p, rel in _walk(repo, {"requirements.txt", "requirements-dev.txt", "pyproject.toml", "Pipfile"}):
        text = p.read_text(encoding="utf-8", errors="replace").lower()
        for name, b in PY.items():
            if re.search(r"(?m)^\s*(?:\"|')?" + re.escape(name) + r"(?:\[[^\]]*\])?\s*(?:[=<>!~;\"' ,]|$)", text):
                add(b, f"{name} in {rel}")
    for p, rel in _walk(repo, {"pubspec.yaml"}):
        text = p.read_text(encoding="utf-8", errors="replace")
        for name, b in PUB.items():
            if re.search(r"(?m)^\s{2}" + re.escape(name) + r"\s*:", text):
                add(b, f"{name} in {rel}")
    for p, rel in _walk(repo, {"Podfile", "build.gradle", "build.gradle.kts", "Podfile.lock"}, max_depth=PACKAGE_DEPTH + 1):
        text = p.read_text(encoding="utf-8", errors="replace")
        for token, b in NATIVE:
            if token in text:
                add(b, f"{token} in {rel}")
        add("platforms", f"{rel}")
    for p, rel in _walk(repo, {"app.json", "app.config.js", "app.config.ts", "capacitor.config.ts", "capacitor.config.json", "capacitor.config.js"}):
        text = p.read_text(encoding="utf-8", errors="replace")
        if p.name.startswith("capacitor") or '"expo"' in text or "expo:" in text:
            add("platforms", f"{rel}")
        if "expo-notifications" in text:
            add("push", f"expo-notifications plugin in {rel}")
    for p, rel in _walk(repo, {"manifest.json"}):
        try:
            if json.loads(p.read_text(encoding="utf-8")).get("manifest_version") in (2, 3):
                add("platforms", f"extension {rel}")
        except Exception:
            pass
    # code hints: only unambiguous imports/calls, limited to source code
    for p in repo.rglob("*"):
        rel = p.relative_to(repo)
        if any(part in SKIP_DIRS for part in rel.parts) or not p.is_file() or p.suffix not in CODE_EXT or p.stat().st_size > CODE_FILE_MAX:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for rx, b, label in CODE:
            if b not in found and rx.search(text):
                add(b, f"{label} in {rel}")
        for name in url_imports(text):
            b = _match(name, NPM)
            if b: add(b, f"{name} (imported by URL) in {rel}")
        for host, b, label in HOSTS:
            if b not in found and host in text: add(b, f"{label} ({host}) in {rel}")
    # schema: tables and collections; chats and moderation rarely live in a library
    for b, where in detect_schema(repo):
        add(b, where)
    return [Detected(b, w) for b, w in sorted(found.items())]
