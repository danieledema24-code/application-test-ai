"""G5 test-case lint (P3-01a, P3-02): coded quality checks stored per case and re-run on every write.

Errors and open questions block approval of the case (and, on approved cases, of G5). Warnings are advice.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.domain.testdesign import priority as prio
from app.domain.testdesign.synthetic import is_password_field, text_issues

# Bump when a rule changes: cases linted with an older version are re-linted on read.
LINT_RULES_VERSION = 2
MAX_STEPS = 15

ERRORS = frozenset(
    {
        "missing_steps",
        "missing_expected_result",
        "orphan_case",
        "unresolved_placeholder",
        "technique_data_mismatch",
        "literal_secret",
        "non_synthetic_data",
    }
)
WARNINGS = frozenset(
    {
        "open_question",
        "vague_wording",
        "too_many_steps",
        "duplicate_case",
        "type_not_in_strategy",
        "linked_requirement_rejected",
        "priority_below_risk",
    }
)
TITLES = {
    "missing_steps": "Missing steps",
    "missing_expected_result": "Missing expected result",
    "orphan_case": "Not linked to a requirement",
    "unresolved_placeholder": "Unresolved placeholder",
    "technique_data_mismatch": "Test data doesn't fit the technique",
    "literal_secret": "Literal password",
    "non_synthetic_data": "Real-looking data",
    "open_question": "Open question",
    "vague_wording": "Vague wording",
    "too_many_steps": "Too many steps",
    "duplicate_case": "Duplicate case",
    "type_not_in_strategy": "Test type not in the strategy",
    "linked_requirement_rejected": "Linked requirement rejected",
    "priority_below_risk": "Priority lower than its risk",
}

VAGUE = re.compile(
    r"\b(works|as expected|correctly|properly|appropriate(ly)?|etc|should be fine|verify it|check that it)\b", re.I
)
PLACEHOLDER = re.compile(r"\bTBD\b|\bTODO\b|<[^<>\s][^<>]{0,40}>|\{\{")
LITERAL_PASSWORD = re.compile(r"\bpassword\b[^.\n]{0,20}?(?:\bis\b|[:=])\s*['\"][^'\"]+['\"]", re.I)


@dataclass(frozen=True)
class DataFact:
    key: str
    kind: str  # valid / invalid / boundary / secret_ref
    value_type: str
    value: str | None
    secret_ref: str | None
    field_label: str
    field_type: str | None
    status: str = "active"


@dataclass
class CaseFacts:
    title: str
    objective: str
    steps: list[dict[str, Any]]  # [{n, action, expected, data_keys: [...]}]
    expected_result: str
    expected_result_status: str
    technique: str
    test_type: str
    requirement_count: int
    data: list[DataFact] = field(default_factory=list)
    open_question_message: str | None = None
    open_question_key: str | None = None
    has_coverage_item: bool = False
    in_scope_types: frozenset[str] | None = None
    rejected_requirement_keys: list[str] = field(default_factory=list)
    duplicate_of: str | None = None
    priority_override: str | None = None
    derived_priority: str = "low"
    risk_level: str | None = None


def item(code: str, message: str, path: str | None = None, hint: str | None = None) -> dict[str, Any]:
    severity = "error" if code in ERRORS else "warning"
    return {
        "code": code,
        "severity": severity,
        "blocks_approval": severity == "error" or code == "open_question",
        "message": message,
        "path": path,
        "hint": hint,
    }


def lint_case(c: CaseFacts) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not c.steps:
        out.append(item("missing_steps", "The case has no steps", "steps", "Add at least one step with an action"))
    # Steps may leave the expected result empty (setup steps such as "Open /contact") as long as at least one
    # step says what is checked; the overall expected result is checked separately below.
    if c.steps and not any(str(st.get("expected") or "").strip() for st in c.steps):
        last = len(c.steps) - 1
        out.append(
            item(
                "missing_expected_result",
                "No step has an expected result",
                f"steps[{last}].expected",
                "Describe what the user sees after at least one step, e.g. 'Name is marked as required'",
            )
        )
    if c.expected_result_status != "open_question" and not c.expected_result.strip():
        out.append(
            item(
                "missing_expected_result",
                "The case has no overall expected result",
                "expected_result",
                "Describe the outcome that shows the case passed",
            )
        )
    if c.requirement_count == 0:
        out.append(
            item("orphan_case", "The case isn't linked to a requirement", "requirement_ids", "Link a requirement")
        )
    texts = [("title", c.title), ("objective", c.objective), ("expected_result", c.expected_result)]
    for i, st in enumerate(c.steps):
        texts += [(f"steps[{i}].action", str(st.get("action") or "")), (f"steps[{i}].expected", str(st.get("expected") or ""))]  # fmt: skip
    # The open question's own wording ("REQ-0007 asks whether Message is optional") isn't checked for wording.
    undecided = (
        {c.open_question_message or "", c.expected_result} if c.expected_result_status == "open_question" else set()
    )

    def is_open_question_text(text: str) -> bool:
        return text.startswith("Not decided") or (bool(text) and text in undecided)

    for path, text in texts:
        if is_open_question_text(text):
            continue
        if PLACEHOLDER.search(text):
            out.append(item("unresolved_placeholder", f"Placeholder text in {_where(path)}", path, "Replace it with the real wording"))  # fmt: skip
            break
    if c.technique == "boundary_value_analysis" and not any(d.kind == "boundary" for d in c.data):
        out.append(
            item(
                "technique_data_mismatch",
                "A boundary value case needs a boundary test data item",
                "steps",
                "Use a test data item that holds the boundary value",
            )
        )
    if c.technique == "equivalence_partitioning" and not c.data and not c.has_coverage_item:
        out.append(
            item(
                "technique_data_mismatch",
                "An equivalence partitioning case needs a partition representative",
                "steps",
                "Use a test data item from the partition under test",
            )
        )
    for d in c.data:
        if is_password_field(d.field_type, d.field_label) and d.kind != "secret_ref" and (d.value or "").strip():
            out.append(
                item(
                    "literal_secret",
                    f"{d.key} puts a literal value in the {d.field_label} field",
                    "steps",
                    "Reference the saved test credentials instead",
                )
            )
            break
    for path, text in texts:
        if LITERAL_PASSWORD.search(text):
            out.append(item("literal_secret", f"A password is written out in {_where(path)}", path, "Reference the saved test credentials instead"))  # fmt: skip
            break
    synthetic_problem = next(
        (
            (path, msgs[0])
            for path, text in [*texts, *((f"data.{d.key}", d.value or "") for d in c.data)]
            if (msgs := text_issues(text))
        ),
        None,
    )
    if synthetic_problem is not None:
        out.append(item("non_synthetic_data", synthetic_problem[1], synthetic_problem[0], "Use synthetic test data"))
    if c.expected_result_status == "open_question":
        out.append(
            item(
                "open_question",
                c.open_question_message or "The expected result depends on a question that isn't answered",
                "expected_result",
                f"Write the expected result, or resolve {c.open_question_key or 'the requirement'} and regenerate.",
            )
        )
    vague_paths = [p for p, t in texts if VAGUE.search(t) and not is_open_question_text(t)]
    if vague_paths:
        word = VAGUE.search(dict(texts)[vague_paths[0]])
        out.append(
            item(
                "vague_wording",
                f"Vague wording in {_where(vague_paths[0])}: '{word.group(0) if word else ''}'",
                vague_paths[0],
                "Say exactly what is shown, e.g. 'Name is marked as required'",
            )
        )
    if len(c.steps) > MAX_STEPS:
        out.append(item("too_many_steps", f"{len(c.steps)} steps (more than {MAX_STEPS})", "steps", "Split the case"))
    if c.duplicate_of:
        out.append(
            item(
                "duplicate_case",
                f"Same steps, data and expected result as {c.duplicate_of}",
                None,
                "Reject one of them",
            )
        )
    if c.in_scope_types is not None and c.test_type not in c.in_scope_types:
        out.append(
            item(
                "type_not_in_strategy",
                f"Test type '{c.test_type}' is not in scope in the approved strategy",
                "test_type",
                "Change the type or update the strategy",
            )
        )
    if c.rejected_requirement_keys:
        out.append(
            item(
                "linked_requirement_rejected",
                f"Linked requirement {', '.join(c.rejected_requirement_keys)} was rejected",
                "requirement_ids",
                "Unlink it, or deprecate the case",
            )
        )
    if prio.below_risk(c.priority_override, c.derived_priority, c.risk_level):
        out.append(
            item(
                "priority_below_risk",
                f"Priority {c.priority_override} is lower than {c.derived_priority} from its {c.risk_level} risk",
                "priority_override",
                "Keep the override only if the reason explains the lower priority",
            )
        )
    return out


def text_lint(text: str) -> list[str]:
    """Codes a single piece of wording would raise (used by unit tests and the edit-form preview)."""
    codes = []
    if VAGUE.search(text):
        codes.append("vague_wording")
    if PLACEHOLDER.search(text):
        codes.append("unresolved_placeholder")
    if LITERAL_PASSWORD.search(text):
        codes.append("literal_secret")
    if text_issues(text):
        codes.append("non_synthetic_data")
    return codes


def blocking(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [i for i in items if i.get("blocks_approval")]


def summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "errors": sum(1 for i in items if i.get("severity") == "error"),
        "warnings": sum(1 for i in items if i.get("severity") == "warning"),
        "blocks_approval": any(i.get("blocks_approval") for i in items),
    }


def signature(steps: list[dict[str, Any]], data_keys: list[str], expected: str) -> str:
    """Normalised steps, data and expected result (lint `duplicate_case`)."""

    def norm(t: str) -> str:
        return re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()

    parts = [f"{norm(str(s.get('action', '')))}>{norm(str(s.get('expected', '')))}" for s in steps]
    return "|".join(parts) + "#" + ",".join(sorted(data_keys)) + "#" + norm(expected)


def _where(path: str) -> str:
    m = re.match(r"steps\[(\d+)\]\.(\w+)", path)
    if m:
        return f"step {int(m.group(1)) + 1}"
    return path.replace("_", " ")
