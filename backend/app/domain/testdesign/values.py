"""Equivalence partitions and boundary values computed from discovered field constraints (ISTQB CTFL v4).

BVA is 2-value by default (the boundary and its nearest neighbour across it) and 3-value for high/very-high risk.
A boundary exists only when a constraint was discovered (`required`, `minlength`, `maxlength`, `min`, `max`, a
`pattern` length quantifier) or an approved acceptance criterion carries test values. No constraint, no boundary.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from dataclasses import field as dc_field
from decimal import Decimal, InvalidOperation
from typing import Literal

Mode = Literal["2_value", "3_value"]
Side = Literal["below", "on", "above"]

TEXT_LIKE = frozenset({"text", "email", "tel", "url", "search", "textarea", "password", ""})
# A pattern made of one character class (or \d, \w) with a length quantifier, e.g. "[0-9 ]{6,}".
_PATTERN_LEN = re.compile(r"^\^?(\[[^\]]+\]|\\d|\\w|\.)\{(\d+)(,(\d*))?\}\$?$")


@dataclass(frozen=True)
class FieldFacts:
    """One discovered form field with the constraints the page declared."""

    key: str  # "{form anchor}:{normalised name}", the same anchor the requirement rules use
    name: str
    label: str
    type: str = "text"
    required: bool = False
    minlength: int | None = None
    maxlength: int | None = None
    min: str | None = None
    max: str | None = None
    pattern: str | None = None
    options: tuple[str, ...] = ()
    selector: str = ""

    @property
    def is_password(self) -> bool:
        return self.type == "password"

    @property
    def text_like(self) -> bool:
        return self.type in TEXT_LIKE


@dataclass(frozen=True)
class BoundaryValue:
    id: str  # coverage item id, e.g. "len:81"
    side: Side
    constraint: str  # "required", "minlength", "maxlength", "min", "max", "pattern", "ac"
    boundary: str  # the boundary under test, e.g. "80"
    length: int | None = None
    value: str | None = None  # numeric boundaries and AC test values
    explanation: str = ""

    @property
    def label(self) -> str:
        if self.length is not None:
            return f"{self.length} character{'s' if self.length != 1 else ''}"
        return str(self.value)


@dataclass(frozen=True)
class Partition:
    id: str  # coverage item id, e.g. "email:missing_at"
    kind: Literal["valid", "invalid"]
    description: str
    data: str  # data recipe for the synthetic factory: "nonempty", "empty", "email", "email_missing_at", ...
    value: str | None = None  # an explicit value (select options, numbers)


@dataclass
class BvaSet:
    field: FieldFacts
    constraint: str
    boundary: str
    values: list[BoundaryValue] = dc_field(default_factory=list)
    mode: Mode = "2_value"


def mode_for(risk_level: str | None) -> Mode:
    return "3_value" if risk_level in ("high", "very_high") else "2_value"


def _length_quantifier(pattern: str | None) -> tuple[int, int | None] | None:
    if not pattern:
        return None
    m = _PATTERN_LEN.match(pattern.strip())
    if m is None:
        return None
    lo = int(m.group(2))
    if m.group(3) is None:
        return lo, lo
    hi = m.group(4)
    return lo, int(hi) if hi else None


def _num(raw: str | None) -> Decimal | None:
    if raw in (None, ""):
        return None
    try:
        return Decimal(str(raw))
    except InvalidOperation:
        return None


def _step(d: Decimal) -> Decimal:
    exp = d.as_tuple().exponent
    return Decimal(1).scaleb(exp) if isinstance(exp, int) and exp < 0 else Decimal(1)


def _fmt(d: Decimal) -> str:
    return format(d.normalize(), "f") if d != d.to_integral() else str(int(d))


def lower_length(f: FieldFacts, n: int, constraint: str, mode: Mode, why: str) -> BvaSet:
    """Minimum length n: n-1 (below, rejected) and n (on, accepted); 3-value adds n+1."""
    out = BvaSet(f, constraint, str(n), mode=mode)
    out.values.append(
        BoundaryValue(f"len:{n - 1}", "below", constraint, str(n), length=n - 1, explanation=f"{why}; one below")
    )
    out.values.append(BoundaryValue(f"len:{n}", "on", constraint, str(n), length=n, explanation=f"{why}; on it"))
    if mode == "3_value":
        out.values.append(
            BoundaryValue(f"len:{n + 1}", "above", constraint, str(n), length=n + 1, explanation=f"{why}; one above")
        )
    return out


def upper_length(f: FieldFacts, n: int, constraint: str, mode: Mode, why: str) -> BvaSet:
    """Maximum length n: n (on) and n+1 (above); 3-value adds n-1."""
    out = BvaSet(f, constraint, str(n), mode=mode)
    if mode == "3_value":
        out.values.append(
            BoundaryValue(f"len:{n - 1}", "below", constraint, str(n), length=n - 1, explanation=f"{why}; one below")
        )
    out.values.append(BoundaryValue(f"len:{n}", "on", constraint, str(n), length=n, explanation=f"{why}; on it"))
    out.values.append(
        BoundaryValue(f"len:{n + 1}", "above", constraint, str(n), length=n + 1, explanation=f"{why}; one above")
    )
    return out


def required_boundaries(f: FieldFacts, mode: Mode) -> BvaSet | None:
    """`required` means a minimum length of 1, unless a larger `minlength` sets the lower boundary instead."""
    if not f.required or not f.text_like or (f.minlength or 0) > 1:
        return None
    return lower_length(f, 1, "required", mode, f"{f.label} requires at least 1 character (required attribute)")


def length_boundaries(f: FieldFacts, mode: Mode) -> list[BvaSet]:
    out: list[BvaSet] = []
    if f.minlength and f.minlength > 0:
        why = f"{f.label} requires at least {f.minlength} characters (minlength={f.minlength})"
        out.append(lower_length(f, f.minlength, "minlength", mode, why))
    if f.maxlength and f.maxlength > 0:
        why = f"{f.label} holds at most {f.maxlength} characters (maxlength={f.maxlength})"
        out.append(upper_length(f, f.maxlength, "maxlength", mode, why))
    q = _length_quantifier(f.pattern)
    if q is not None:
        lo, hi = q
        if lo > 0 and not f.minlength:
            why = f"{f.label} needs at least {lo} characters (pattern {f.pattern})"
            out.append(lower_length(f, lo, "pattern", mode, why))
        if hi is not None and not f.maxlength:
            why = f"{f.label} allows at most {hi} characters (pattern {f.pattern})"
            out.append(upper_length(f, hi, "pattern", mode, why))
    return out


def range_boundaries(f: FieldFacts, mode: Mode) -> list[BvaSet]:
    out: list[BvaSet] = []
    lo, hi = _num(f.min), _num(f.max)
    for bound, d, inside, outside in (("min", lo, "above", "below"), ("max", hi, "below", "above")):
        if d is None:
            continue
        step = _step(d)
        word = "at least" if bound == "min" else "at most"
        why = f"{f.label} accepts {word} {_fmt(d)} ({bound}={_fmt(d)})"
        bs = BvaSet(f, bound, _fmt(d), mode=mode)
        across = d - step if bound == "min" else d + step
        within = d + step if bound == "min" else d - step
        bs.values.append(
            BoundaryValue(f"num:{_fmt(across)}", outside, bound, _fmt(d), value=_fmt(across), explanation=why)  # type: ignore[arg-type]
        )
        bs.values.append(BoundaryValue(f"num:{_fmt(d)}", "on", bound, _fmt(d), value=_fmt(d), explanation=why))
        if mode == "3_value":
            bs.values.append(
                BoundaryValue(f"num:{_fmt(within)}", inside, bound, _fmt(d), value=_fmt(within), explanation=why)  # type: ignore[arg-type]
            )
        bs.values.sort(key=lambda v: Decimal(v.value or "0"))
        out.append(bs)
    return out


def ac_boundaries(f: FieldFacts, test_values: list[dict[str, str]]) -> BvaSet | None:
    """Boundary values stated by approved AC test values (P2-03 `test_values`: [{field, value, note}]).

    Only values that state a boundary (a length, or a minimum/maximum/limit) are boundaries; other examples (missing
    "@", spaces only) are equivalence classes the EP and error-guessing designs already cover."""
    vals: list[BoundaryValue] = []
    for i, tv in enumerate(test_values or []):
        raw = str(tv.get("value", ""))
        label = str(tv.get("label") or raw)
        length = _length_from_label(label)
        if length is None and not _BOUND_LABEL.search(label):
            continue
        vals.append(
            BoundaryValue(
                f"ac:{i}:{label[:40]}",
                "on",
                "ac",
                label,
                length=length,
                value=None if length is not None else raw,
                explanation=f"Value from an approved acceptance criterion: {label}",
            )
        )
    if not vals:
        return None
    return BvaSet(f, "ac", "acceptance criterion", vals, "2_value")


_LEN_LABEL = re.compile(r"(\d+)\s*char", re.I)
_BOUND_LABEL = re.compile(r"\b(minimum|maximum|limit)\b", re.I)


def _length_from_label(label: str) -> int | None:
    m = _LEN_LABEL.search(label)
    return int(m.group(1)) if m else None


def required_partitions(f: FieldFacts) -> list[Partition]:
    if not f.required:
        return []
    return [
        Partition(f"{_slug(f)}:nonempty", "valid", f"{f.label} filled in", "nonempty"),
        Partition(f"{_slug(f)}:empty", "invalid", f"{f.label} left empty", "empty"),
    ]


def email_partitions(f: FieldFacts) -> list[Partition]:
    if f.type != "email":
        return []
    return [
        Partition(f"{_slug(f)}:valid_format", "valid", f"{f.label} is a valid email address", "email"),
        Partition(f"{_slug(f)}:missing_at", "invalid", f'{f.label} without "@"', "email_missing_at"),
        Partition(f"{_slug(f)}:missing_domain", "invalid", f"{f.label} without a domain", "email_missing_domain"),
    ]


def number_partitions(f: FieldFacts) -> list[Partition]:
    if f.type != "number" and f.min in (None, "") and f.max in (None, ""):
        return []
    lo, hi = _num(f.min), _num(f.max)
    out: list[Partition] = []
    if lo is not None and hi is not None:
        mid = (lo + hi) / 2
        mid = mid.quantize(_step(lo)) if _step(lo) < 1 else Decimal(int(mid))
        out.append(Partition(f"{_slug(f)}:in_range", "valid", f"{f.label} within {_fmt(lo)}-{_fmt(hi)}", "number",
                             _fmt(mid)))  # fmt: skip
    elif lo is not None:
        out.append(Partition(f"{_slug(f)}:in_range", "valid", f"{f.label} at least {_fmt(lo)}", "number", _fmt(lo)))
    elif hi is not None:
        out.append(Partition(f"{_slug(f)}:in_range", "valid", f"{f.label} at most {_fmt(hi)}", "number", _fmt(hi)))
    if lo is not None:
        below = lo - _step(lo) * 10
        out.append(Partition(f"{_slug(f)}:below", "invalid", f"{f.label} below {_fmt(lo)}", "number", _fmt(below)))
    if hi is not None:
        above = hi + _step(hi) * 10
        out.append(Partition(f"{_slug(f)}:above", "invalid", f"{f.label} above {_fmt(hi)}", "number", _fmt(above)))
    if f.type == "number":
        out.append(Partition(f"{_slug(f)}:non_numeric", "invalid", f"{f.label} is not a number", "non_numeric"))
    return out


def pattern_partitions(f: FieldFacts) -> list[Partition]:
    if not f.pattern:
        return []
    return [
        Partition(f"{_slug(f)}:matching", "valid", f"{f.label} matches the pattern {f.pattern}", "pattern_match"),
        Partition(f"{_slug(f)}:non_matching", "invalid", f"{f.label} does not match {f.pattern}", "pattern_mismatch"),
    ]


def select_partitions(f: FieldFacts) -> list[Partition]:
    if f.type != "select" or not f.options:
        return []
    out = [
        Partition(f"{_slug(f)}:option:{i}", "valid", f"{f.label} = {o}", "option", o) for i, o in enumerate(f.options)
    ]
    if f.required:
        out.append(Partition(f"{_slug(f)}:none", "invalid", f"No {f.label} chosen", "empty"))
    return out


def missing_upper_bounds(fields: list[FieldFacts]) -> list[str]:
    """Labels of text fields with no discovered maximum length (no upper boundary case can be designed)."""
    out = []
    for f in fields:
        if not f.text_like or f.is_password:
            continue
        q = _length_quantifier(f.pattern)
        if f.maxlength or (q is not None and q[1] is not None):
            continue
        out.append(f.label)
    return out


def no_max_note(labels: list[str]) -> str | None:
    if not labels:
        return None
    joined = labels[0] if len(labels) == 1 else f"{', '.join(labels[:-1])} or {labels[-1]}"
    return f"No maximum length was discovered for {joined}; no upper boundary case is designed"


def pattern_matches(pattern: str, value: str) -> bool:
    try:
        return re.fullmatch(pattern, value) is not None
    except re.error:
        return False


def _slug(f: FieldFacts) -> str:
    return f.key.rsplit(":", 1)[-1].replace(" ", "_") or "field"
