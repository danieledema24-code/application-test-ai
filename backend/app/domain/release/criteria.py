"""Release readiness rules (P6-05a; decisions D32, D33). Pure functions over a snapshot of stored evidence; no I/O
and no AI. The service (`app/services/release.py`) loads the snapshot; nothing here reads the database.

Criteria come from two places:
- the **exit criteria** of the strategy approved at G4, recognised from their text (`EXIT_RULES`, unit-tested
  patterns; the P5-07 non-functional words too) plus the project's **Definition of Done** results. A criterion the
  platform can't check is `not_evaluable` ("The platform can't check this: confirm it") until a person records a
  result with a reason (`manual`);
- **platform checks**, always added (`rr.*`).

The verdict is tiered (D32): `no_go` when a blocking criterion is `not_met`; `conditional` when anything else is not
met or not evaluable (a blocking criterion that can't be evaluated never yields `go`); `go` only when everything is
met. Absence of evidence is never "met". Conditions are fixed templates that name the evidence.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

MET, NOT_MET, NOT_EVALUABLE = "met", "not_met", "not_evaluable"
STATUSES = (MET, NOT_MET, NOT_EVALUABLE)
LEVELS = ("low", "medium", "high", "very_high")
HIGH = frozenset({"high", "very_high"})
# Defects a person confirmed at G8 that aren't verified yet (traceability `OPEN_DEFECT`): drafts are hypotheses.
OPEN_DEFECT = frozenset({"confirmed", "fixed"})
HIGH_SEVERITY = ("critical", "major")
# A latest result that is evidence the test was executed (the DoD rule: flaky, errors and blocked don't count).
EXECUTED = frozenset({"passed", "failed"})
# A latest result that says the test ran (the pass rate counts every one of these; only `passed` passes).
RAN = frozenset({"passed", "failed", "error", "flaky"})
CANT_CHECK = "The platform can't check this: confirm it"
HIGH_MEANS = '"Critical or high" means the critical and major severities.'
VERDICT_LABEL = {"go": "Go", "conditional": "Conditional", "no_go": "No-go"}
LEVEL_LABEL = {"low": "Low", "medium": "Medium", "high": "High", "very_high": "Very high"}
# D32: blocking by default. Everything else (also the pass rate and AC execution) is non-blocking. When the strategy
# has no "no open critical or high defects" criterion, the platform check `rr.no_open_high_defects` takes its place.
BLOCKING = frozenset(
    {
        "exit.no_open_high_defects",
        "rr.no_open_high_defects",
        "rr.impacted_rerun",
        "rr.high_risk_tested",
        "rr.g8_pending",
    }
)
RELEASE_STATEMENT = (
    "This recommendation is based on the tests the platform ran and the evidence recorded up to {time}. It is "
    "advisory, it does not cover what wasn't tested, and the release decision belongs to the people who approve it."
)


# ---------------------------------------------------------------- the snapshot


@dataclass(frozen=True)
class Case:
    """An approved test case (G5) with its latest result (the worst result of the latest run that ran it)."""

    lineage: str
    key: str
    requirement_lineages: tuple[str, ...] = ()
    ac_lineages: tuple[str, ...] = ()
    result: str | None = None
    result_at: datetime | None = None
    run_key: str | None = None
    script_state: str | None = None
    script_path: str | None = None
    id: str | None = None


@dataclass(frozen=True)
class Ac:
    lineage: str
    key: str
    id: str | None = None


@dataclass(frozen=True)
class Requirement:
    lineage: str
    key: str
    feature_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class Defect:
    key: str
    severity: str
    status: str
    id: str | None = None


@dataclass(frozen=True)
class Risk:
    key: str
    title: str
    level: str
    status: str = "open"
    requirement_lineages: tuple[str, ...] = ()
    feature_ids: tuple[str, ...] = ()
    comment: str | None = None
    accepted_by: str | None = None
    id: str | None = None


@dataclass(frozen=True)
class MustPick:
    """A must-run test of a change set (D28). `rerun`: it has a result from a run started after the change set.
    `excluded_reason`: it was must-run but is Not included now (`was_must`, a removed page), so it is reviewed, not
    re-run. `manual`: a manual test; it counts as re-run once a person records a manual re-test for the change set
    (D37, `manual_result`); without one the platform can't tell."""

    change_set: str
    case_lineage: str
    case_key: str
    rerun: bool = False
    excluded_reason: str | None = None
    manual: bool = False
    manual_result: str | None = None  # D37: the latest recorded manual re-test (passed/failed), if any
    manual_note: str | None = None  # ... and the note the person wrote with it


@dataclass(frozen=True)
class OpenItem:
    """Something from a change that still needs a person: an open review or gap impact item, an open "Test case needs
    review" item or an undecided repair suggestion. `text` is the condition."""

    kind: str  # review | gap | case_review | repair
    key: str
    text: str
    ref: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Finding:
    key: str
    severity: str
    id: str | None = None


@dataclass(frozen=True)
class DodResult:
    key: str
    text: str
    status: str  # met | not_met | unknown (the P2-05 evaluator; not_applicable rows are left out)
    detail: str
    rule: str | None = None
    id: str | None = None


@dataclass(frozen=True)
class Manual:
    """A person's result for a criterion the platform can't check (`exit_criterion.confirmed`)."""

    status: str
    reason: str
    by: str
    by_id: str | None = None
    at: str | None = None


@dataclass
class Snapshot:
    assessed_at: datetime
    # The strategy approved at G4: its version and exit criteria. None: never approved.
    strategy_version: int | None = None
    exit_criteria: list[str] = field(default_factory=list)
    requirements: dict[str, Requirement] = field(default_factory=dict)
    acs: list[Ac] = field(default_factory=list)  # approved ACs of approved requirements
    cases: list[Case] = field(default_factory=list)  # approved cases (G5)
    defects: list[Defect] = field(default_factory=list)
    risks: list[Risk] | None = None  # None: no risk register yet
    change_sets: list[str] = field(default_factory=list)  # rescan change sets since the last final assessment
    latest_change_at: datetime | None = None  # the newest completed rescan change set (residual risk cut-off)
    must: list[MustPick] = field(default_factory=list)
    open_items: list[OpenItem] = field(default_factory=list)
    exploratory_sessions: list[str] = field(default_factory=list)
    exploratory_open: list[Finding] = field(default_factory=list)
    # P5-07 facts: accessibility/security {scan_key, open: [(key, severity)]}, performance {run_key, missed: [text]}.
    nf: dict[str, dict[str, Any] | None] = field(default_factory=dict)
    dod: list[DodResult] = field(default_factory=list)
    manual: dict[str, Manual] = field(default_factory=dict)


# ---------------------------------------------------------------- results


@dataclass
class Result:
    status: str
    detail: str
    evidence: list[dict[str, Any]] = field(default_factory=list)
    conditions: list[str] = field(default_factory=list)
    short: str | None = None  # the no-go sentence's clause ("there is an open major defect (DEF-0001)")
    measured: dict[str, Any] | None = None


def ref(type_: str, key: str, id_: str | None = None, label: str | None = None) -> dict[str, Any]:
    return {"type": type_, "key": key, "id": id_, "label": label or key}


def names(items: list[str], limit: int = 8) -> str:
    """Names joined with commas; past `limit`, "A, B, … and 3 more" (a detail never drops names silently)."""
    shown = ", ".join(items[:limit])
    return f"{shown} and {len(items) - limit} more" if len(items) > limit else shown


def plural(n: int, word: str, many: str | None = None) -> str:
    return f"{n} {word if n == 1 else (many or word + 's')}"


def pct(n: int, d: int) -> float:
    return round(100.0 * n / d, 1) if d else 0.0


def fmt_pct(x: float) -> str:
    return f"{x:g} %"


# ---------------------------------------------------------------- exit criteria recognised from their text

_NUM = r"(\d{1,3}(?:[.,]\d+)?)\s*%"
EXIT_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "exit.no_open_high_defects",
        re.compile(
            r"\b(?:no|zero|0)\s+(?:open\s+|unresolved\s+|outstanding\s+)?(?:critical|blocker|blocking|high|major)"
            r"(?:[\s/,-]+(?:or|and)?\s*(?:critical|high|major|severity))*\s+(?:severity\s+|priority\s+)?"
            r"(?:defects?|bugs?|issues?)\b",
            re.I,
        ),
    ),
    (
        "exit.ac_executed",
        re.compile(
            _NUM
            + r"\s+of\s+(?:the\s+|all\s+)?(?:approved\s+)?acceptance\s+criteria\s+(?:have\s+been\s+|are\s+|were\s+)?"
            r"(?:executed|tested|run|covered\s+by\s+executed\s+tests)",
            re.I,
        ),
    ),
    (
        "exit.pass_rate",
        re.compile(
            _NUM + r"\s+of\s+(?:the\s+|all\s+)?executed\s+(?:tests?|test\s+cases?)\s+(?:have\s+)?pass(?:ed|es)?"
            r"|pass\s+rate\s+(?:of\s+|is\s+|at\s+least\s+|>=?\s*|≥\s*)*" + _NUM,
            re.I,
        ),
    ),
    (
        "exit.high_risks_executed",
        re.compile(
            r"\b(?:every|all|each)\s+(?:open\s+)?high(?:\s+(?:and|or)\s+very\s+high)?\s+risks?\b.*\b(?:tested|executed|run)\b",
            re.I,
        ),
    ),
)
# P5-07 non-functional words (`app.agents.readiness.rules.NF_RULES`), checked after the patterns above.
NF_WORDS = (
    ("accessibility", ("accessib", "wcag", "screen reader", "keyboard")),
    ("security", ("security", "secure", "https", "header")),
    ("performance", ("performance", "load test", "under load", "response time", "page speed")),
)


def recognise(text: str) -> tuple[str | None, float | None]:
    """(rule id, parsed percentage) for an exit criterion's text, or (None, None) when the platform can't check it."""
    for rule, pattern in EXIT_PATTERNS:
        m = pattern.search(text)
        if m is None:
            continue
        number = next((g for g in m.groups() if g), None)
        value = float(number.replace(",", ".")) if number else None
        if value is not None and not 0 <= value <= 100:
            return None, None
        if rule in ("exit.ac_executed", "exit.pass_rate") and value is None:
            continue
        return rule, value
    low = text.lower()
    for kind, words in NF_WORDS:
        if any(w in low for w in words):
            return f"exit.nf.{kind}", None
    return None, None


# ---------------------------------------------------------------- shared evidence helpers


def _linked(snap: Snapshot, risk: Risk) -> list[Case]:
    """Approved cases linked to a risk: through a requirement it names, or a requirement on one of its features."""
    reqs = set(risk.requirement_lineages)
    feats = set(risk.feature_ids)
    out: list[Case] = []
    for c in snap.cases:
        if reqs & set(c.requirement_lineages):
            out.append(c)
            continue
        for lin in c.requirement_lineages:
            r = snap.requirements.get(lin)
            if r is not None and feats & set(r.feature_ids):
                out.append(c)
                break
    return sorted(out, key=lambda c: c.key)


def _case_ref(c: Case) -> dict[str, Any]:
    return ref("test_case", c.key, c.id)


def _defect_ref(d: Defect) -> dict[str, Any]:
    return ref("defect", d.key, d.id, f"{d.key} ({d.severity})")


def _risk_ref(r: Risk) -> dict[str, Any]:
    return ref("risk", r.key, r.id, f"{r.key} · {r.title}")


def _result_word(c: Case) -> str:
    return "not run" if c.result is None else c.result


# ---------------------------------------------------------------- defects


def open_high_defects(snap: Snapshot) -> Result:
    high = [d for d in snap.defects if d.status in OPEN_DEFECT and d.severity in HIGH_SEVERITY]
    if not high:
        return Result(MET, f"No critical or major defect is open. {HIGH_MEANS}")
    named = [f"{d.key} ({d.severity})" for d in high]
    short = (
        f"there is an open {high[0].severity} defect ({high[0].key})"
        if len(high) == 1
        else f"there are {len(high)} open critical or major defects ({names([d.key for d in high])})"
    )
    return Result(
        NOT_MET,
        f"{names(named)} {'is' if len(high) == 1 else 'are'} open. {HIGH_MEANS}",
        [_defect_ref(d) for d in high],
        [f"Fix or accept {d.key} ({d.severity})" for d in high],
        short,
    )


def open_other_defects(snap: Snapshot) -> Result:
    other = [d for d in snap.defects if d.status in OPEN_DEFECT and d.severity not in HIGH_SEVERITY]
    if not other:
        return Result(MET, "No minor or trivial defect is open")
    named = [f"{d.key} ({d.severity})" for d in other]
    return Result(
        NOT_MET,
        f"{names(named)} {'is' if len(other) == 1 else 'are'} open",
        [_defect_ref(d) for d in other],
        [f"Fix or accept {d.key} ({d.severity})" for d in other],
    )


def g8_pending(snap: Snapshot) -> Result:
    drafts = [d for d in snap.defects if d.status == "draft"]
    if not drafts:
        return Result(MET, "No defect draft is waiting for a Gate 8 decision")
    keys = [d.key for d in drafts]
    return Result(
        NOT_MET,
        f"Waiting for a Gate 8 decision: {names(keys)}",
        [_defect_ref(d) for d in drafts],
        [f"Decide {d.key} at Gate 8" for d in drafts],
        f"{keys[0]} is waiting at Gate 8"
        if len(keys) == 1
        else f"{len(keys)} defect drafts are waiting at Gate 8 ({names(keys)})",
    )


# ---------------------------------------------------------------- changes


def impacted_rerun(snap: Snapshot) -> Result:
    if not snap.change_sets:
        return Result(MET, "No change set since the last final assessment, so no impacted test has to be re-run")
    picks = [m for m in snap.must if m.excluded_reason is None]
    pending = [m for m in picks if not m.rerun]
    moved = [m for m in snap.must if m.excluded_reason is not None]
    sets = names(snap.change_sets)
    extra = (
        f" Was must run, now not included (reviewed under 'No open review or gap items from changes'): "
        f"{names([f'{m.case_key} ({m.excluded_reason})' for m in moved])}."
        if moved
        else ""
    )
    automated = [m for m in pending if not m.manual]
    if automated:
        keys = sorted({m.case_key for m in automated})
        return Result(
            NOT_MET,
            f"Not re-run since the change: {names([f'{m.case_key} ({m.change_set})' for m in automated])}.{extra}",
            [ref("test_case", k) for k in keys] + [ref("change_set", k) for k in snap.change_sets],
            [f"Re-test {m.case_key} after {m.change_set}" for m in automated],
            f"{plural(len(keys), 'impacted test')} {'hasn' if len(keys) == 1 else 'haven'}'t been re-run since {sets}",
        )
    if pending:
        # Only manual tests without a recorded manual re-test (D37) are left: the platform can't tell (conditional).
        keys = sorted({m.case_key for m in pending})
        return Result(
            NOT_EVALUABLE,
            f"Every automated must-run test from {sets} has a result since the change. Manual must-run tests without "
            f"a recorded re-test: {names([f'{m.case_key} ({m.change_set})' for m in pending])}.{extra}",
            [ref("test_case", k) for k in keys] + [ref("change_set", k) for k in snap.change_sets],
            [f"Re-test {m.case_key} by hand after {m.change_set} and record the result (manual test)" for m in pending],
            f"{plural(len(keys), 'manual impacted test')} {'has' if len(keys) == 1 else 'have'} no recorded re-test",
        )
    if not picks:
        return Result(MET, f"{sets} {'has' if len(snap.change_sets) == 1 else 'have'} no must-run tests.{extra}",
                      [ref("change_set", k) for k in snap.change_sets])  # fmt: skip
    keys = sorted({m.case_key for m in picks})
    by_hand = [f"{m.case_key} ({m.manual_result})" for m in picks if m.manual and m.manual_result]
    hand = f" Re-tested by hand: {names(by_hand)}." if by_hand else ""
    return Result(
        MET,
        f"Every must-run test from {sets} has a result since the change: {names(keys)}.{hand}{extra}",
        [ref("change_set", k) for k in snap.change_sets],
    )


def manual_retests(snap: Snapshot) -> Result:
    """`rr.manual_retests` (D37, not blocking): a manual re-test recorded as failed counts as re-run for
    `rr.impacted_rerun` but is never "fine": it is a condition naming the test and the person's note. A failed test
    linked to an open critical or major defect is already blocking through the defect criterion."""
    tried = [m for m in snap.must if m.manual and m.manual_result]
    failed = [m for m in tried if m.manual_result == "failed"]
    if not failed:
        return Result(MET, f"Manual re-tests passed: {names([m.case_key for m in tried])}" if tried
                      else "No manual re-test is recorded as failed")  # fmt: skip
    return Result(
        NOT_MET,
        f"Failed when re-tested by hand: {names([f'{m.case_key} ({m.change_set})' for m in failed])}",
        [ref("test_case", m.case_key) for m in failed],
        [f"{m.case_key} failed when re-tested by hand after {m.change_set}: '{m.manual_note or ''}'. Fix it or "
         "raise a defect" for m in failed],
        f"{plural(len(failed), 'manual re-test')} failed",
    )  # fmt: skip


def outdated_scripts(snap: Snapshot) -> Result:
    bad = [c for c in snap.cases if c.script_state == "outdated"]
    if not bad:
        return Result(MET, "No approved test case's script is outdated")
    return Result(
        NOT_MET,
        f"Outdated scripts: {names([f'{c.key} ({c.script_path})' for c in bad])}",
        [_case_ref(c) for c in bad],
        [f"Repair or regenerate the script of {c.key} ({c.script_path})" for c in bad],
    )


def impact_reviewed(snap: Snapshot) -> Result:
    items = snap.open_items
    if not items:
        return Result(MET, "No open review, gap or repair item from changes")
    by_kind: dict[str, int] = {}
    for i in items:
        by_kind[i.kind] = by_kind.get(i.kind, 0) + 1
    words = {
        "review": ("review item", "review items"),
        "gap": ("gap", "gaps"),
        "case_review": ("test case needs review", "test cases need review"),
        "repair": ("repair suggestion", "repair suggestions"),
    }
    parts = [plural(n, *words[k]) for k, n in by_kind.items()]
    return Result(
        NOT_MET,
        f"Open: {', '.join(parts)} ({names(list(dict.fromkeys(i.key for i in items)))})",
        [i.ref or ref(i.kind, i.key) for i in items],
        [i.text for i in items],
    )


# ---------------------------------------------------------------- risks


def high_risk_tested(snap: Snapshot, *, executed_only: bool = False) -> Result:
    """`rr.high_risk_tested` (blocking): every open high/very high risk has a linked case that passed in its latest
    run. With `executed_only` (the strategy's "mitigation tests executed" criterion): passed or failed."""
    if snap.risks is None:
        return Result(NOT_EVALUABLE, "There is no risk register yet: the test strategy hasn't been generated",
                      conditions=["Generate and approve the test strategy (its risk register)"])  # fmt: skip
    highs = sorted((r for r in snap.risks if r.status == "open" and r.level in HIGH), key=lambda r: r.key)
    if not highs:
        return Result(MET, "No open high or very high risk")
    ok_states = EXECUTED if executed_only else frozenset({"passed"})
    good: list[str] = []
    bad: list[tuple[Risk, list[Case]]] = []
    for r in highs:
        linked = _linked(snap, r)
        passed = [c for c in linked if c.result in ok_states]
        if passed:
            good.append(f"{r.key} ({names([c.key for c in passed], 3)})")
        else:
            bad.append((r, linked))
    verb = "was executed" if executed_only else "passed"
    if not bad:
        return Result(
            MET, f"Every open high or very high risk has a linked test that {verb}: {names(good)}",
            [_risk_ref(r) for r in highs],
        )  # fmt: skip
    lines = []
    conditions = []
    for r, linked in bad:
        level = LEVEL_LABEL[r.level].lower()
        if not linked:
            lines.append(f"{r.key} ({level}) has no linked approved test case")
            conditions.append(f"Add and run a test case for {r.key} ({level})")
        else:
            lines.append(f"{r.key} ({level}): {names([f'{c.key} {_result_word(c)}' for c in linked], 4)}")
            conditions.append(
                f"Run {'' if executed_only else 'and pass '}a test for {r.key} ({level}): "
                f"{names([c.key for c in linked], 4)}"
            )
    first = bad[0][0]
    short = (
        f"{first.key} ({LEVEL_LABEL[first.level].lower()}) has no passing test"
        if len(bad) == 1
        else f"{len(bad)} high risks have no passing test ({names([r.key for r, _ in bad])})"
    )
    return Result(NOT_MET, "; ".join(lines), [_risk_ref(r) for r, _ in bad], conditions, short)


# ---------------------------------------------------------------- execution measures


def ac_executed(snap: Snapshot, required: float) -> Result:
    if not snap.acs:
        return Result(NOT_EVALUABLE, "There are no approved acceptance criteria to execute",
                      conditions=["Approve acceptance criteria and their test cases"])  # fmt: skip
    executed_acs = {a for c in snap.cases if c.result in EXECUTED for a in c.ac_lineages}
    done = [a for a in snap.acs if a.lineage in executed_acs]
    missing = sorted((a for a in snap.acs if a.lineage not in executed_acs), key=lambda a: a.key)
    rate = pct(len(done), len(snap.acs))
    measured = {"value": rate, "required": required, "numerator": len(done), "denominator": len(snap.acs)}
    detail = f"{fmt_pct(rate)} executed ({len(done)} of {len(snap.acs)} approved acceptance criteria)"
    if rate >= required:
        return Result(MET, detail, measured=measured)
    return Result(
        NOT_MET,
        f"{detail}; needs {fmt_pct(required)}. Not executed: {names([a.key for a in missing])}",
        [ref("acceptance_criterion", a.key, a.id) for a in missing[:20]],
        [f"Execute the remaining acceptance criteria ({fmt_pct(rate)} executed, needs {fmt_pct(required)}): "
         f"{names([a.key for a in missing])}"],
        measured=measured,
    )  # fmt: skip


def pass_rate(snap: Snapshot, required: float) -> Result:
    ran = [c for c in snap.cases if c.result in RAN]
    if not ran:
        return Result(NOT_EVALUABLE, "No approved test case has a result yet", conditions=["Run the approved tests"])
    passed = [c for c in ran if c.result == "passed"]
    rate = pct(len(passed), len(ran))
    measured = {"value": rate, "required": required, "numerator": len(passed), "denominator": len(ran)}
    detail = f"{fmt_pct(rate)} pass ({len(passed)} of {len(ran)} executed approved tests, latest results)"
    if rate >= required:
        return Result(MET, detail, [ref("execution_run", k) for k in sorted({c.run_key for c in ran if c.run_key})][:5],
                      measured=measured)  # fmt: skip
    failing = sorted((c for c in ran if c.result != "passed"), key=lambda c: c.key)
    return Result(
        NOT_MET,
        f"{detail}; needs {fmt_pct(required)}. Not passing: {names([f'{c.key} ({c.result})' for c in failing])}",
        [_case_ref(c) for c in failing[:20]],
        [f"Fix or re-run the tests that don't pass ({fmt_pct(rate)}, needs {fmt_pct(required)}): "
         f"{names([c.key for c in failing])}"],
        measured=measured,
    )  # fmt: skip


# ---------------------------------------------------------------- exploratory and non-functional


def exploratory(snap: Snapshot) -> Result:
    if not snap.exploratory_sessions:
        return Result(NOT_EVALUABLE, "No exploratory session has run", conditions=["Run an exploratory session"])
    bad = [f for f in snap.exploratory_open if f.severity in ("high", "medium")]
    sessions = names(snap.exploratory_sessions)
    if not bad:
        return Result(MET, f"No open high or medium exploratory finding ({sessions})",
                      [ref("quality_scan", k) for k in snap.exploratory_sessions])  # fmt: skip
    return Result(
        NOT_MET,
        f"Open: {names([f'{f.key} ({f.severity})' for f in bad])}",
        [ref("quality_finding", f.key, f.id) for f in bad],
        [f"Fix or accept {f.key} ({f.severity})" for f in bad],
    )


NF_SEVERE = {"accessibility": ("critical", "serious"), "security": ("high", "medium")}
NF_MISSING = {
    "accessibility": ("no accessibility check has run", "Run an accessibility check"),
    "security": ("no security check has run", "Run a security check"),
    "performance": ("no load test has run", "Run a load test"),
}


def nf_part(kind: str, data: dict[str, Any] | None) -> Result:
    """One non-functional type, as P5-07 judges it: accessibility (open critical or serious findings), security (open
    high or medium findings) and performance (thresholds of the latest judged load test)."""
    if data is None:
        why, todo = NF_MISSING[kind]
        return Result(NOT_EVALUABLE, f"Not checked: {why}", conditions=[todo])
    if kind == "performance":
        missed = list(data.get("missed") or [])
        run_key = str(data.get("run_key"))
        if missed:
            return Result(NOT_MET, f"Thresholds missed in {run_key}: {names(missed)}", [ref("performance_run", run_key)],
                          [f"Meet the load-test thresholds missed in {run_key}: {names(missed)}"])  # fmt: skip
        return Result(MET, f"All thresholds met in {run_key}", [ref("performance_run", run_key)])
    scan = str(data.get("scan_key"))
    bad = [(k, sev) for k, sev in data.get("open") or [] if sev in NF_SEVERE[kind]]
    if bad:
        return Result(
            NOT_MET,
            f"Open in {scan}: {names([f'{k} ({sev})' for k, sev in bad])}",
            [ref("quality_finding", k) for k, _ in bad],
            [f"Fix or accept {k} ({sev})" for k, sev in bad],
        )
    what = "critical or serious accessibility" if kind == "accessibility" else "high or medium security"
    return Result(MET, f"No open {what} finding in {scan}", [ref("quality_scan", scan)])


def nonfunctional(snap: Snapshot) -> Result:
    parts = {k: nf_part(k, snap.nf.get(k)) for k in ("accessibility", "security", "performance")}
    evidence = [e for r in parts.values() for e in r.evidence]
    conditions = [c for r in parts.values() for c in r.conditions]
    detail = "; ".join(f"{k.capitalize()}: {r.detail}" for k, r in parts.items())
    if any(r.status == NOT_MET for r in parts.values()):
        return Result(
            NOT_MET, detail, evidence, [c for r in parts.values() if r.status == NOT_MET for c in r.conditions]
        )
    if any(r.status == NOT_EVALUABLE for r in parts.values()):
        return Result(NOT_EVALUABLE, detail, evidence, conditions)
    return Result(MET, detail, evidence)


# ---------------------------------------------------------------- assembling the criteria


PLATFORM: tuple[tuple[str, str], ...] = (
    ("rr.impacted_rerun", "Impacted tests re-run since the change"),
    ("rr.high_risk_tested", "Every high risk tested and passing"),
    ("rr.g8_pending", "Nothing waiting at Gate 8"),
    ("rr.open_defects", "No other open defects"),
    ("rr.manual_retests", "Manual re-tests passed"),
    ("rr.outdated_scripts", "No outdated scripts"),
    ("rr.impact_reviewed", "No open review or gap items from changes"),
    ("rr.exploratory", "No open high or medium exploratory findings"),
    ("rr.nf", "Accessibility, security and performance checks pass"),
)


def _platform_result(rule: str, snap: Snapshot) -> Result:
    return {
        "rr.no_open_high_defects": open_high_defects,
        "rr.impacted_rerun": impacted_rerun,
        "rr.high_risk_tested": high_risk_tested,
        "rr.g8_pending": g8_pending,
        "rr.open_defects": open_other_defects,
        "rr.manual_retests": manual_retests,
        "rr.outdated_scripts": outdated_scripts,
        "rr.impact_reviewed": impact_reviewed,
        "rr.exploratory": exploratory,
        "rr.nf": nonfunctional,
    }[rule](snap)


def _exit_result(rule: str | None, value: float | None, text: str, snap: Snapshot) -> Result:
    if rule == "exit.no_open_high_defects":
        return open_high_defects(snap)
    if rule == "exit.ac_executed" and value is not None:
        return ac_executed(snap, value)
    if rule == "exit.pass_rate" and value is not None:
        return pass_rate(snap, value)
    if rule == "exit.high_risks_executed":
        return high_risk_tested(snap, executed_only=True)
    if rule is not None and rule.startswith("exit.nf."):
        kind = rule.rsplit(".", 1)[1]
        return nf_part(kind, snap.nf.get(kind))
    return Result(NOT_EVALUABLE, CANT_CHECK, conditions=[f"Confirm: {text}"])


def _criterion(
    cid: str, text: str, source: str, rule: str | None, r: Result, snap: Snapshot, *, confirmable: bool
) -> dict[str, Any]:
    c: dict[str, Any] = {
        "id": cid,
        "rule": rule,
        "text": text,
        "source": source,
        "blocking": (rule or cid) in BLOCKING,
        "status": r.status,
        "detail": r.detail,
        "evidence_refs": r.evidence,
        "conditions": r.conditions,
        "short": r.short,
        "measured": r.measured,
        "confirmable": confirmable,
        "manual": False,
        "confirmed_by": None,
        "confirm_reason": None,
        "confirmed_at": None,
    }
    m = snap.manual.get(cid)
    if confirmable and m is not None:
        apply_manual(c, m)
    return c


def apply_manual(c: dict[str, Any], m: Manual) -> None:
    """A person's result replaces "not evaluable" (D32: shown as "Confirmed by {name}")."""
    c.update(
        status=m.status,
        manual=True,
        detail=f"Confirmed by {m.by}: '{m.reason}'",
        conditions=[] if m.status == MET else [f"{c['text']}: confirmed not met by {m.by}"],
        short=None if m.status == MET else f"{c['text']} (confirmed not met by {m.by})",
        confirmed_by={"id": m.by_id, "full_name": m.by},
        confirm_reason=m.reason,
        confirmed_at=m.at,
    )


def evaluate(snap: Snapshot) -> list[dict[str, Any]]:
    """Every criterion of the assessment, in order: strategy exit criteria, Definition of Done, platform checks."""
    out: list[dict[str, Any]] = []
    used: set[str] = set()
    has_defect_rule = False
    for i, text in enumerate(snap.exit_criteria, 1):
        rule, value = recognise(text)
        cid = rule if rule is not None and rule not in used else f"exit.text.{i}"
        used.add(cid)
        has_defect_rule = has_defect_rule or rule == "exit.no_open_high_defects"
        res = _exit_result(rule, value, text, snap)
        out.append(_criterion(cid, text, "exit_criterion", rule, res, snap, confirmable=res.status == NOT_EVALUABLE
                              and rule is None))  # fmt: skip
    if snap.strategy_version is None:
        out.append(_criterion(
            "rr.strategy", "Exit criteria from the approved test strategy", "platform", None,
            Result(NOT_EVALUABLE, "The test strategy hasn't been approved at Gate 4, so its exit criteria can't be "
                   "checked", conditions=["Approve the test strategy (Gate 4)"]),
            snap, confirmable=False,
        ))  # fmt: skip
    for d in snap.dod:
        if d.rule == "dod.no_open_high_defects":
            continue  # the blocking defect criterion covers it (exit criterion or platform check)
        if d.status == "unknown":
            unknown = d.detail if d.rule else CANT_CHECK
            res = Result(NOT_EVALUABLE, unknown, conditions=[f"Confirm: {d.text}"])
        elif d.status == NOT_MET:
            res = Result(NOT_MET, d.detail, [ref("readiness_criterion", d.key, d.id)],
                         [f"Meet the Definition of Done: {d.text} ({d.detail})"])  # fmt: skip
        else:
            res = Result(MET, d.detail, [ref("readiness_criterion", d.key, d.id)])
        out.append(_criterion(f"dod.{d.key}", d.text, "dod", d.rule, res, snap,
                              confirmable=res.status == NOT_EVALUABLE))  # fmt: skip
    if not has_defect_rule:
        out.append(_criterion("rr.no_open_high_defects", "No open critical or high defects", "platform", None,
                              open_high_defects(snap), snap, confirmable=False))  # fmt: skip
    for cid, text in PLATFORM:
        out.append(_criterion(cid, text, "platform", None, _platform_result(cid, snap), snap, confirmable=False))
    return out


# ---------------------------------------------------------------- verdict (D32) and conditions


def verdict(criteria: list[dict[str, Any]]) -> str:
    if any(c["blocking"] and c["status"] == NOT_MET for c in criteria):
        return "no_go"
    if any(c["status"] != MET for c in criteria):
        return "conditional"
    return "go"


def conditions(criteria: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What has to happen first: blocking criteria first, each condition once."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for blocking in (True, False):
        for c in criteria:
            if c["blocking"] != blocking or c["status"] == MET:
                continue
            for text in c["conditions"] or [f"Confirm: {c['text']}"]:
                if text in seen:
                    continue
                seen.add(text)
                out.append({"text": text, "criterion_id": c["id"], "blocking": c["blocking"],
                            "evidence_refs": c["evidence_refs"][:5]})  # fmt: skip
    return out


def reason(criteria: list[dict[str, Any]], verdict_: str, n_conditions: int) -> str:
    """The one-sentence reason (design P6 §10.1 templates)."""
    if verdict_ == "no_go":
        unmet = [c for c in criteria if c["blocking"] and c["status"] == NOT_MET]
        first = unmet[0]["short"] or unmet[0]["text"]
        if len(unmet) == 1:
            return f"1 blocking criterion isn't met: {first}."
        return f"{len(unmet)} blocking criteria aren't met: {first} and {len(unmet) - 1} more."
    if verdict_ == "conditional":
        remain = f"{plural(n_conditions, 'condition')} {'remains' if n_conditions == 1 else 'remain'}"
        unknown = [c for c in criteria if c["blocking"] and c["status"] == NOT_EVALUABLE]
        if unknown:
            return f"{unknown[0]['text']} can't be checked, so the recommendation can't be Go; {remain}."
        return f"Every blocking criterion is met, but {remain}."
    return "Every criterion is met by recorded evidence."


def counts(criteria: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "total": len(criteria),
        "met": sum(1 for c in criteria if c["status"] == MET),
        "not_met": sum(1 for c in criteria if c["status"] == NOT_MET),
        "not_evaluable": sum(1 for c in criteria if c["status"] == NOT_EVALUABLE),
        "blocking": sum(1 for c in criteria if c["blocking"]),
        "blocking_not_met": sum(1 for c in criteria if c["blocking"] and c["status"] == NOT_MET),
        "manual": sum(1 for c in criteria if c["manual"]),
    }


# ---------------------------------------------------------------- residual risk


def _lower(level: str) -> str:
    return LEVELS[max(LEVELS.index(level) - 1, 0)]


def residual(snap: Snapshot) -> tuple[list[dict[str, Any]], str | None]:
    """Per risk: the initial level, kept unless its linked approved cases all passed in runs after the latest change
    set ("Mitigated by testing", residual Low), or one level lower when some passed and none failed. Accepted risks
    keep their level and say who accepted them and why. Failed or untested high risks come first."""
    if not snap.risks:
        return [], None
    cutoff = snap.latest_change_at
    rows: list[dict[str, Any]] = []
    for r in snap.risks:
        linked = _linked(snap, r)
        fresh = [c for c in linked if cutoff is None or (c.result_at is not None and c.result_at > cutoff)]
        passed = [c for c in fresh if c.result == "passed"]
        failed = [c for c in linked if c.result in ("failed", "error")]
        untested = [c for c in linked if c not in passed and c not in failed]
        tests = {"passed": [c.key for c in passed], "failed": [c.key for c in failed],
                 "not_tested": [c.key for c in untested]}  # fmt: skip
        reduced = True
        if r.status == "accepted":
            level = r.level
            line = f"Accepted by {r.accepted_by or 'someone'}: '{r.comment or ''}'"
            reduced = False
        elif linked and len(passed) == len(linked):
            level, line = "low", f"Mitigated by testing: all {plural(len(linked), 'linked test')} passed"
        elif passed and not failed:
            level, line = _lower(r.level), "Reduced: some tests passed, none failed"
        else:
            level, reduced = r.level, False
            bits = []
            if failed:
                bits.append(f"{plural(len(failed), 'test')} failed ({names([c.key for c in failed], 4)})")
            if untested:
                after = " since the change" if cutoff is not None else ""
                bits.append(
                    f"{plural(len(untested), 'test')} not tested{after} ({names([c.key for c in untested], 4)})"
                )
            line = "Not reduced: " + ("; ".join(bits) if bits else "no linked test case")
        rows.append({
            "risk": _risk_ref(r), "title": r.title, "status": r.status, "initial": r.level, "residual": level,
            "line": line, "reduced": reduced, "tests": tests,
        })  # fmt: skip
    rows.sort(
        key=lambda x: (
            0 if (not x["reduced"] and x["status"] != "accepted" and x["initial"] in HIGH) else 1,
            -LEVELS.index(x["residual"]),
            x["risk"]["key"],
        )
    )
    overall = max((x["residual"] for x in rows), key=LEVELS.index)
    return rows, overall


# ---------------------------------------------------------------- the narrative ("What this means")


def rule_narrative(verdict_: str, n_conditions: int, blocking_not_met: int) -> str:
    """The fixed text used when the AI's narrative is rejected (the rule path never needs one)."""
    if verdict_ == "no_go":
        return (
            f"The release should not go ahead yet: {plural(blocking_not_met, 'blocking criterion', 'blocking criteria')} "
            f"{'is' if blocking_not_met == 1 else 'are'} not met. Deal with {'it' if blocking_not_met == 1 else 'them'}, "
            "then assess again."
        )
    if verdict_ == "conditional":
        return (
            f"The release can go ahead only if the people deciding accept the {plural(n_conditions, 'condition')} "
            "listed, or deal with them first."
        )
    return "Every criterion is met by recorded evidence. The release can go ahead if the people deciding agree."


PLACEHOLDERS = ("verdict", "conditions", "blocking_not_met", "met", "not_met", "not_evaluable", "criteria",
                "overall_residual")  # fmt: skip
_PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")
_GO_CLAIM = re.compile(
    r"\b(?:ready (?:to|for) (?:release|ship|launch|go live)|safe to (?:release|ship|launch)|good to go|"
    r"(?:can|may|should) (?:now )?(?:be )?(?:released|shipped|launched)|go ahead with (?:the )?release|"
    r"release (?:now|immediately|today)|recommend(?:s|ed|ation is)? (?:a )?go\b|verdict is go\b|is a go\b|"
    r"all (?:criteria|checks|tests) (?:are |were |have been )?(?:met|passed|green))",
    re.I,
)
_NO_GO_CLAIM = re.compile(
    r"\b(?:no[- ]go|not (?:be )?ready|should not (?:be )?(?:released|shipped|go ahead)|must not (?:be )?released|"
    r"do not release|don'?t release|cannot (?:be )?released|block(?:s|ed)? (?:the )?release)\b",
    re.I,
)
_CONDITIONAL_CLAIM = re.compile(r"\bconditional(?:ly)?\b", re.I)
# Release-action language (QA P6-05a): on a No-go or Conditional the narrative may not tell anyone to release. A
# clause with an action word is a go claim unless the same clause negates or conditions it ("not", "until", "once",
# "before", "only if", …); "release" counts only as a verb. Telling people to ignore or skip the listed items is never
# allowed. Clauses split at . ; : ! ? and commas.
_ACTION = re.compile(
    r"\b(?:ship(?:s|ped|ping)?|launch(?:es|ed|ing)?|roll(?:s|ed|ing)? ?out|rollout|go(?:es)? live|"
    r"go(?:es)? ahead|proceed(?:s|ed|ing)?|approv(?:e|es|ed|ing)|green[- ]?light|thumbs up|"
    r"released|releasing|release (?:it|this|that|the|now|today|immediately|as planned|on schedule))\b",
    re.I,
)
_HOLD = re.compile(
    r"\b(?:not|no|never|cannot|can't|won't|don't|doesn't|shouldn't|mustn't|isn't|until|unless|once|before|after|"
    r"first|only if|if|when|wait|hold|until)\b|n't\b",
    re.I,
)
_IGNORE = re.compile(
    r"\b(?:ignore|disregard|skip|dismiss|overlook|bypass|override)\b[^.;:!?]*\b(?:block\w*|item|items|condition|"
    r"conditions|criteri\w+|problems?|issues?|defects?|findings?|risks?|warnings?|checks?)\b",
    re.I,
)
_CLAUSE = re.compile(r"[.;:!?,]+")


def _release_action(text: str) -> bool:
    return any(_ACTION.search(c) and not _HOLD.search(c) for c in _CLAUSE.split(text))


def check_narrative(text: str, verdict_: str) -> str | None:
    """Why an AI narrative is rejected, or None. It may explain, never decide: no digits (figures are placeholders
    the platform fills), no unknown placeholder, and no claim of a verdict other than the computed one."""
    bare = _PLACEHOLDER.sub("", text)
    if re.search(r"\d", bare):
        return "it wrote a number instead of a placeholder"
    unknown = set(_PLACEHOLDER.findall(text)) - set(PLACEHOLDERS)
    if unknown:
        return f"it used an unknown placeholder ({', '.join(sorted(unknown))})"
    if _IGNORE.search(bare):
        return "it tells people to ignore the listed criteria"
    claims = {
        "go": bool(_GO_CLAIM.search(bare)) or (verdict_ != "go" and _release_action(bare)),
        "no_go": bool(_NO_GO_CLAIM.search(bare)),
        "conditional": bool(_CONDITIONAL_CLAIM.search(bare)),
    }
    wrong = [k for k, v in claims.items() if v and k != verdict_]
    if wrong:
        return f"it claims a different verdict ({VERDICT_LABEL[wrong[0]]}) than the rules ({VERDICT_LABEL[verdict_]})"
    return None


def fill_narrative(text: str, values: dict[str, str]) -> str:
    return _PLACEHOLDER.sub(lambda m: values[m.group(1)], text).strip()


def narrative_values(verdict_: str, n_conditions: int, c: dict[str, int], overall: str | None) -> dict[str, str]:
    return {
        "verdict": VERDICT_LABEL[verdict_],
        "conditions": str(n_conditions),
        "blocking_not_met": str(c["blocking_not_met"]),
        "met": str(c["met"]),
        "not_met": str(c["not_met"]),
        "not_evaluable": str(c["not_evaluable"]),
        "criteria": str(c["total"]),
        "overall_residual": LEVEL_LABEL.get(overall or "", "not assessed").lower(),
    }


def recompute(criteria: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]], str]:
    """(verdict, conditions, reason) from stored criteria (after a person confirms one)."""
    v = verdict(criteria)
    conds = conditions(criteria)
    return v, conds, reason(criteria, v, len(conds))
