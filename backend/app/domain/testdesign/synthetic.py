"""Synthetic test data (P3-01a, P3-03, decision D3): deterministic factories and the guard every value passes.

Factories are seeded by the item's match key, so the same input always gives the same values. Emails use reserved
domains (RFC 2606/6761), phone numbers use published fictional ranges, card-like numbers must be published test
cards, and credentials are only ever a reference to a saved project secret, never a value.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from app.domain.testdesign.values import FieldFacts, pattern_matches

MAX_VALUE_LENGTH = 5000
CREDENTIALS_REF = "login_credentials"

FIRST_NAMES = ("Alex", "Sam", "Robin", "Jordan", "Casey", "Morgan", "Riley", "Taylor", "Jamie", "Avery")
LAST_NAMES = ("Example", "Sample", "Tester", "Placeholder", "Fixture", "Demo", "Mock", "Specimen")
WORDS = (
    "synthetic", "test", "message", "written", "for", "quality", "checks", "only", "please", "ignore", "this",
    "sample", "text", "from", "the", "design", "suite",
)  # fmt: skip
RESERVED_EMAIL_SUFFIXES = (".example.com", ".example.org", ".example.net", ".test", ".invalid", ".example")
RESERVED_EMAIL_DOMAINS = ("example.com", "example.org", "example.net")
# UK Ofcom drama ranges (01632 960xxx, 07700 900xxx) and the North American 555-01xx fictional range.
RESERVED_PHONE = re.compile(r"^(?:(?:44|0)1632960\d{0,3}|(?:44|0)7700900\d{0,3}|1?\d{3}55501\d{0,2}|55501\d{0,2})$")
PHONE_BASE = "01632 960123"
TEST_CARDS = frozenset(
    {
        "4111111111111111", "4242424242424242", "4012888888881881", "4000056655665556", "5555555555554444",
        "5105105105105100", "2223003122003222", "378282246310005", "371449635398431", "6011111111111117",
        "6011000990139424", "3530111333300000", "3566002020360505", "30569309025904", "38520000023237",
    }
)  # fmt: skip

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")
CARD_RUN_RE = re.compile(r"(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])")
PHONE_RE = re.compile(r"(?<![\w])\+?\(?\d[\d ().-]{5,}\d(?![\w])")
PASSWORD_LABEL = re.compile(r"pass(word|phrase|code)|\bpin\b", re.I)

MSG_EMAIL = "Use a reserved domain such as example.com; real-looking data isn't allowed"
MSG_PHONE = "Use a fictional phone number from the reserved ranges"
MSG_CARD = "This looks like a real card number; use a published test card"
MSG_PASSWORD = "Passwords must reference saved test credentials"  # noqa: S105 - a message, not a password
MSG_TOO_LONG = f"Values can be at most {MAX_VALUE_LENGTH:,} characters"


def seed_of(key: str) -> int:
    return int(hashlib.sha256(key.encode()).hexdigest()[:8], 16)


def fictional_name(seed: int) -> str:
    return f"{FIRST_NAMES[seed % len(FIRST_NAMES)]} {LAST_NAMES[(seed // 7) % len(LAST_NAMES)]}"


def email(seed: int) -> str:
    first, last = fictional_name(seed).lower().split(" ")
    return f"{first}.{last}@example.com"


def text_of_length(n: int, seed: int, alphabet: str | None = None) -> str:
    """Deterministic readable text of exactly n characters that never starts or ends with a space."""
    if n <= 0:
        return ""
    if alphabet:
        chars = [c for c in alphabet if not c.isspace()] or list(alphabet)
        return "".join(chars[(seed + i) % len(chars)] for i in range(n))
    words: list[str] = []
    i = seed
    while sum(len(w) + 1 for w in words) < n + 1:
        words.append(WORDS[i % len(WORDS)])
        i += 1
    out = " ".join(words)[:n]
    if out[-1] == " ":
        out = out[:-1] + "x"
    return out


def phone_of_length(n: int) -> str:
    base = PHONE_BASE
    if n <= len(base):
        out = base[:n]
        return out[:-1] + "0" if out.endswith(" ") and n > 1 else out
    return base + "0" * (n - len(base))


def _class_alphabet(pattern: str | None) -> str | None:
    """Characters of a simple single-class pattern (e.g. "[0-9 ]{6,}" -> "0123456789 ")."""
    if not pattern:
        return None
    m = re.match(r"^\^?\[([^\]]+)\]", pattern.strip())
    if m is None:
        if pattern.startswith("\\d"):
            return "0123456789"
        return None
    body, out, i = m.group(1), [], 0
    while i < len(body):
        if i + 2 < len(body) and body[i + 1] == "-":
            out += [chr(c) for c in range(ord(body[i]), ord(body[i + 2]) + 1)]
            i += 3
        else:
            out.append(body[i])
            i += 1
    return "".join(out)


def is_phone_field(f: FieldFacts) -> bool:
    return f.type == "tel" or bool(re.search(r"phone|mobile|\btel\b", f"{f.label} {f.name}", re.I))


def value_of_length(f: FieldFacts, n: int, seed: int) -> str:
    """A boundary value of exactly n characters that is valid in every other respect where possible."""
    alphabet = _class_alphabet(f.pattern)
    digits_only = bool(alphabet) and set(alphabet or "") <= set("0123456789 -+()")
    if is_phone_field(f) or digits_only:
        return phone_of_length(n)
    if f.type == "email":
        # The shortest valid synthetic address is "a@x.test" (8 characters); shorter values can't be valid emails.
        domain = "@example.com" if n >= len("a@example.com") else "@x.test"
        candidate = "a" * max(1, n - len(domain)) + domain
        return candidate if len(candidate) == n else text_of_length(n, seed)
    return text_of_length(n, seed, alphabet)


VALID_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$")
NUMBER_RE = re.compile(r"^-?\d+(?:\.\d+)?$")


def format_problem(f: FieldFacts, value: str) -> str | None:
    """Why a non-empty value can't pass the field's declared format (type or pattern), or None if it can."""
    if not value:
        return None
    if f.type == "email" and not VALID_EMAIL_RE.match(value):
        return "invalid_email"
    if f.type == "url" and not re.match(r"^[a-z][a-z0-9+.-]*://\S+$", value, re.I):
        return "invalid_url"
    if f.type == "number" and not NUMBER_RE.match(value):
        return "non_numeric"
    if f.pattern and not pattern_matches(f.pattern, value):
        return "pattern_mismatch"
    return None


def valid_value(f: FieldFacts, seed: int) -> str:
    """A representative of the valid partition: satisfies every discovered constraint."""
    if f.type == "email":
        return email(seed)
    if f.options:
        return f.options[0]
    if is_phone_field(f):
        base = PHONE_BASE
        if f.pattern and not pattern_matches(f.pattern, base):
            for alt in ("01632960123", "555-0100", "5550100"):
                if pattern_matches(f.pattern, alt):
                    return alt
        return base
    if f.pattern:
        alphabet = _class_alphabet(f.pattern)
        lo = f.minlength or 6
        candidate = text_of_length(max(lo, 6), seed, alphabet)
        return candidate
    lo, hi = f.minlength or 0, f.maxlength
    if re.search(r"name", f"{f.label} {f.name}", re.I):
        v = fictional_name(seed)
    elif f.type == "textarea" or re.search(r"message|comment|question|details", f"{f.label} {f.name}", re.I):
        v = "Synthetic test message written for quality checks only."
    else:
        v = text_of_length(12, seed)
    if len(v) < lo:
        v = text_of_length(lo, seed)
    if hi and len(v) > hi:
        v = text_of_length(hi, seed)
    return v


def email_missing_at(seed: int) -> str:
    return email(seed).replace("@", ".")


def email_missing_domain(seed: int) -> str:
    return email(seed).split("@")[0] + "@"


def pattern_mismatch(f: FieldFacts) -> str:
    for cand in ("not-a-match!", "~", "abc", "!!"):
        if f.pattern and not pattern_matches(f.pattern, cand):
            return cand
    return "~"


# ------------------------------------------------------------------ guard


@dataclass(frozen=True)
class GuardError:
    field: str
    message: str


def _luhn(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def _reserved_email_domain(domain: str) -> bool:
    d = domain.lower().rstrip(".")
    return d in RESERVED_EMAIL_DOMAINS or d.endswith(RESERVED_EMAIL_SUFFIXES) or d in ("test", "invalid", "example")


def text_issues(text: str, *, phone_field: bool = False) -> list[str]:
    """Messages for real-looking personal data inside free text or a value (empty list when synthetic)."""
    out: list[str] = []
    if not text:
        return out
    for m in EMAIL_RE.finditer(text):
        if not _reserved_email_domain(m.group(1)):
            out.append(MSG_EMAIL)
            break
    for m in CARD_RUN_RE.finditer(text):
        digits = re.sub(r"\D", "", m.group(0))
        if 13 <= len(digits) <= 19 and _luhn(digits) and digits not in TEST_CARDS:
            out.append(MSG_CARD)
            break
    for m in PHONE_RE.finditer(text):
        digits = re.sub(r"\D", "", m.group(0))
        if digits in TEST_CARDS or (13 <= len(digits) <= 19 and _luhn(digits)):
            continue
        looks_like_phone = (
            phone_field or m.group(0).startswith(("+", "(", "0")) or bool(re.search(r"[ ().-]", m.group(0)))
        )
        if 7 <= len(digits) <= 15 and looks_like_phone and not RESERVED_PHONE.match(digits):
            out.append(MSG_PHONE)
            break
    return out


def is_password_field(field_type: str | None, field_label: str | None) -> bool:
    return field_type == "password" or bool(PASSWORD_LABEL.search(field_label or ""))


def check_value(
    value: str | None,
    *,
    secret_ref: str | None = None,
    field_type: str | None = None,
    field_label: str | None = None,
    known_secrets: set[str] | None = None,
    boundary_length: int | None = None,
) -> list[GuardError]:
    """The synthetic guard (P3-03). `known_secrets` holds the project's secret names and kinds (never values);
    None skips the existence check (generated items reference the conventional name)."""
    errors: list[GuardError] = []
    if secret_ref is not None:
        if value not in (None, ""):
            errors.append(GuardError("value", "Use either a value or a saved-credentials reference, not both"))
        if known_secrets is not None and secret_ref not in known_secrets:
            errors.append(GuardError("secret_ref", f"No saved test credentials are called '{secret_ref}'"))
        return errors
    v = value or ""
    if len(v) > MAX_VALUE_LENGTH:
        errors.append(GuardError("value", MSG_TOO_LONG))
        return errors
    if is_password_field(field_type, field_label) and v.strip():
        errors.append(GuardError("value", MSG_PASSWORD))
        return errors
    phone = field_type == "tel" or bool(re.search(r"phone|mobile|\btel\b", field_label or "", re.I))
    errors += [GuardError("value", m) for m in text_issues(v, phone_field=phone)]
    if boundary_length is not None and len(v) != boundary_length:
        errors.append(
            GuardError("value", f"This item tests the {boundary_length}-character boundary; change the case instead")
        )
    return errors
