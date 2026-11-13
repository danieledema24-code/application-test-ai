"""Rule-based test design (P3-01a): conditions, cases and synthetic data from the approved snapshot. Pure.

Input is the G3-approved requirements (with approved ACs), the G4-approved strategy (techniques by feature,
in-scope test types), the risk register and discovery facts (forms with their declared constraints, the auth
boundary). Every value comes from `values` and `synthetic`; drafts reference each other by match key and the agent
turns them into rows (keys, lineage, links).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.domain.enums import Provenance
from app.domain.provenance import STRENGTH, backend_keywords, cap_to
from app.domain.testdesign import synthetic as syn
from app.domain.testdesign import values as val
from app.domain.testdesign.priority import RiskFact, top_risk

EP = "equivalence_partitioning"
BVA = "boundary_value_analysis"
DT = "decision_table"
ST = "state_transition"
UC = "use_case"
EG = "error_guessing"
CHECKLIST = "checklist"
ALWAYS_ALLOWED = frozenset({UC, EG, CHECKLIST})

MAX_CASES = 300
MAX_DATA = 400
MAX_CASES_PER_REQUIREMENT = 15
PRELIMINARY = "Preliminary: assessed in Phase 4."
NOT_DESIGNED_APPROVAL = "Needs separate approval; designed in Phase 5"
NOT_DESIGNED_SCOPE = "Out of scope in the approved strategy"
NOT_DESIGNED_EXPLORATORY = "Exploratory testing stays a planned approach; charters arrive in Phase 6"
APPROVAL_TYPES = frozenset({"security", "performance", "load", "stress", "spike", "endurance"})
FIELD_RULES = frozenset({"form.required_field", "form.email_format", "form.length_limit", "form.range", "form.pattern"})
FORM_RULES = frozenset({"form.purpose", "form.submission_outcome"})
MANDATORY_RE = re.compile(r"\b(mandatory|required|must be filled|must not be empty)\b", re.I)
OPTIONAL_RE = re.compile(r"\b(optional|may be left empty|can be left empty|not required)\b", re.I)
DEFINITIONS = {
    EP: "Equivalence partitioning: one representative value per class the field treats the same way.",
    BVA: "Boundary value analysis: values on and next to each discovered limit.",
    DT: "Decision table: one case per combination of conditions that leads to a different outcome.",
    ST: "State transition: paths through the states a user moves between, plus an invalid transition.",
    UC: "Use case: the main flow a user follows, step by step.",
    EG: "Error guessing: inputs and actions that often break forms, from a fixed catalogue.",
    CHECKLIST: "Checklist: a fixed list of quality checks.",
}


@dataclass(frozen=True)
class AcIn:
    lineage_id: str
    key: str
    kind: str
    given: str
    when: str
    then: str
    provenance: str
    rule_id: str | None = None
    test_values: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ReqIn:
    lineage_id: str
    key: str
    title: str
    description: str
    match_key: str
    rule_id: str | None
    category: str
    type: str
    behaviour_scope: str
    provenance: str
    status: str
    feature_ids: tuple[str, ...] = ()
    acs: tuple[AcIn, ...] = ()
    evidence_refs: tuple[dict[str, Any], ...] = ()

    @property
    def anchor(self) -> str:
        return self.match_key.rsplit("|", 1)[0]

    @property
    def rule(self) -> str:
        return self.match_key.rsplit("|", 1)[-1]


@dataclass
class FormIn:
    anchor: str
    name: str  # "contact", "sign-in", ...
    purpose: str
    path: str
    submit_label: str
    fields: list[val.FieldFacts]
    evidence_refs: list[dict[str, Any]] = field(default_factory=list)
    page_id: str | None = None
    form_index: int = 0


@dataclass
class DesignInput:
    requirements: list[ReqIn]  # approved at G3, with their approved ACs
    other_requirements: list[ReqIn]  # every other current requirement (open questions read them)
    forms: list[FormIn]
    risks: list[RiskFact] = field(default_factory=list)
    techniques_by_feature: dict[str, frozenset[str]] = field(default_factory=dict)
    test_types: list[dict[str, Any]] = field(default_factory=list)  # strategy `test_types` section
    credentials_saved: bool = False
    signed_in_redirect: bool = False
    signed_in_path: str | None = None
    mobile_viewport: str = "390×844"
    visited_paths: list[str] = field(default_factory=list)
    captcha: bool = False


@dataclass
class DataDraft:
    match_key: str
    name: str
    field_label: str
    field_selector: str
    field_type: str
    form_ref: dict[str, Any]
    feature_id: str | None
    kind: str  # valid / invalid / boundary / secret_ref
    value_type: str
    value: str | None
    secret_ref: str | None
    length: int | None
    generator: str
    boundary: dict[str, str] | None = None  # {condition match key, coverage item}
    display: str = ""  # short label used in step wording, e.g. "0 characters"


@dataclass
class ConditionDraft:
    match_key: str
    title: str
    description: str
    technique: str
    test_type: str
    feature_id: str | None
    requirement_lineages: list[str]
    ac_lineages: list[str]
    design_basis: dict[str, Any]
    coverage_items: list[dict[str, str]]
    notes: list[str]
    rule_id: str
    provenance: str
    evidence_refs: list[dict[str, Any]]


@dataclass
class CaseDraft:
    match_key: str
    condition_match_key: str | None
    coverage_item: str
    title: str
    objective: str
    preconditions: list[str]
    steps: list[dict[str, Any]]  # [{action, data: [data match keys], expected}]; "{d0}" marks data in the action
    expected_result: str
    technique: str
    test_type: str
    test_level: str
    requirement_lineages: list[str]
    ac_lineages: list[str]
    provenance: str
    rule_id: str
    explanation: str
    side_effects: list[str] = field(default_factory=list)
    suites: list[str] = field(default_factory=list)
    automation: tuple[str, str] = ("suitable", "")
    expected_result_status: str = "defined"
    open_question: dict[str, str] | None = None
    evidence_refs: list[dict[str, Any]] = field(default_factory=list)
    feature_ids: list[str] = field(default_factory=list)
    positive: bool = False
    smoke_candidate: bool = False
    risk: RiskFact | None = None
    generated_by: str = "rules"


@dataclass
class DesignOutput:
    conditions: list[ConditionDraft] = field(default_factory=list)
    cases: list[CaseDraft] = field(default_factory=list)
    data: dict[str, DataDraft] = field(default_factory=dict)
    not_designed: list[dict[str, str]] = field(default_factory=list)
    issues: list[dict[str, Any]] = field(default_factory=list)
    skipped_requirements: list[str] = field(default_factory=list)
    # Computed boundary lengths/partitions per field key: the AI path may only use these.
    allowed_boundaries: dict[str, set[int]] = field(default_factory=dict)
    allowed_partitions: dict[str, set[str]] = field(default_factory=dict)


def weakest(*labels: str) -> str:
    provs = [Provenance(x) for x in labels if x]
    if not provs:
        return Provenance.assumed.value
    return min(provs, key=lambda p: STRENGTH[p]).value


def classify(expected: str, *labels: str) -> str:
    """A case's label: the weakest of its sources, capped at inferred when it describes backend effects."""
    base = Provenance(weakest(*labels))
    if backend_keywords(expected):
        base = cap_to(base, Provenance.inferred)
    return base.value


def issue(severity: str, code: str, message: str, item: str | None = None) -> dict[str, Any]:
    return {"severity": severity, "code": code, "message": message, "path": None, "item_key": item}


def _cap(s: str) -> str:
    s = s.strip()
    return s[:1].upper() + s[1:] if s else s


def _join(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return f"{', '.join(items[:-1])} and {items[-1]}"


def field_constraints(fl: val.FieldFacts) -> str:
    """The constraints a field declared, as written on the page, e.g. "required, type=email, maxlength=80"."""
    parts = ["required"] if fl.required else []
    if fl.type not in ("text", "textarea", ""):
        parts.append(f"type={fl.type}")
    for name in ("minlength", "maxlength", "min", "max", "pattern"):
        value = getattr(fl, name)
        if value not in (None, ""):
            parts.append(f"{name}={value}")
    return ", ".join(parts) or "no declared constraint"


def _bva_constraint(fl: val.FieldFacts, bs: val.BvaSet) -> str:
    if bs.constraint == "required":
        return "required"
    if bs.constraint == "ac":
        return "acceptance criterion test values"
    if bs.constraint == "pattern":
        return f"pattern={fl.pattern}"
    return f"{bs.constraint}={bs.boundary}"


def test_type_for(req: ReqIn) -> str:
    rule = req.rule
    if rule == "nfr.form_labels" or req.category == "accessibility":
        return "accessibility"
    if rule == "nfr.mobile_layout":
        return "compatibility"
    if rule in ("nfr.response_time",) or req.category == "performance":
        return "performance"
    if rule == "nfr.https_credentials" or req.category == "security":
        return "security"
    if req.category == "usability":
        return "usability"
    return "functional"


class Designer:
    def __init__(self, inp: DesignInput) -> None:
        self.inp = inp
        self.out = DesignOutput()
        self.in_scope = {t["type"] for t in inp.test_types if t.get("in_scope") and not t.get("requires_approval")}
        if not inp.test_types:  # no strategy sections (should not happen after G4): functional only
            self.in_scope = {"functional", "smoke", "accessibility", "compatibility"}
        self.forms = {f.anchor: f for f in inp.forms}
        self.fields = {fl.key: (f, fl) for f in inp.forms for fl in f.fields}
        self.all_reqs = {r.match_key: r for r in [*inp.requirements, *inp.other_requirements]}
        self.per_req: dict[str, int] = {}
        self.blocked_types: set[str] = set()

    # ------------------------------------------------------------------ entry point

    def run(self) -> DesignOutput:
        self._not_designed()
        handled_forms: set[str] = set()
        for req in self.inp.requirements:
            ttype = test_type_for(req)
            if not self._type_ok(ttype):
                continue  # covered below by a passive checklist case
            rule = req.rule
            if rule in FIELD_RULES:
                self._field_requirement(req)
            elif rule == "form.purpose":
                self._form_purpose(req)
                handled_forms.add(req.anchor)
            elif rule == "auth.signin_form":
                self._signin(req)
            elif rule == "nfr.form_labels":
                self._labels(req)
            elif rule == "nfr.mobile_layout":
                self._mobile(req)
            elif rule == "nfr.console_errors":
                self._console(req)
            elif rule in ("form.submission_outcome", "auth.invalid_credentials"):
                continue  # covered by the all-valid case and the sign-in decision table
            elif req.behaviour_scope == "backend":
                self.out.skipped_requirements.append(req.key)
            else:
                self._use_case(req)
        self._cover_every_requirement()
        self._suites()
        self._caps()
        return self.out

    # ------------------------------------------------------------------ extra negatives (assistant, P3-06)

    def extra_negatives(self, lineages: set[str]) -> DesignOutput:
        """Negative and error-guessing cases for the given requirements, beyond the baseline design: the baseline's
        own negatives (so a removed one can come back) plus the wider catalogue (leading/trailing spaces, paste over
        `maxlength`, more malformed email addresses, EP invalid classes of fields whose format requirement wasn't
        approved). The caller removes what already exists."""
        self.run()
        base_cases = [c for c in self.out.cases if lineages & set(c.requirement_lineages) and not c.positive]
        self.out.cases = []
        self.per_req = {}
        for req in self.inp.requirements:
            if req.lineage_id not in lineages:
                continue
            targets: list[tuple[FormIn, val.FieldFacts]] = []
            if req.rule in FIELD_RULES and req.anchor in self.fields:
                targets = [self.fields[req.anchor]]
            elif req.rule in FORM_RULES and req.anchor in self.forms:
                form = self.forms[req.anchor]
                targets = [(form, fl) for fl in form.fields]
            for form, fl in targets:
                if fl.is_password or fl.type in ("checkbox", "radio", "file", "hidden", "select"):
                    continue
                self._extra_field(req, form, fl)
        self.out.cases = base_cases + [c for c in self.out.cases if lineages & set(c.requirement_lineages)]
        return self.out

    def _extra_case(
        self,
        req: ReqIn,
        form: FormIn,
        fl: val.FieldFacts,
        cid: str,
        title: str,
        steps: list[dict[str, Any]],
        expected: str,
        provenance: str,
        catalogue: str,
        technique: str = EG,
    ) -> None:
        self._case(
            req,
            CaseDraft(
                f"{req.match_key}|{EG}.extra#{cid}:{val._slug(fl)}",
                None,
                cid,
                title[:160],
                f"Check how the {form.name} form handles a common input mistake in {fl.label}.",
                [f"On {form.path}", "Signed out"],
                steps,
                expected,
                technique,
                "functional",
                "system",
                [req.lineage_id],
                [],
                provenance,
                f"design.eg.extra.{cid}",
                f"Error guessing: {title[:1].lower() + title[1:]} (catalogue {catalogue})",
                automation=self._automation(),
                evidence_refs=list(req.evidence_refs),
                feature_ids=list(req.feature_ids),
            ),
        )

    def _extra_field(self, req: ReqIn, form: FormIn, fl: val.FieldFacts) -> None:
        feature = self._feature(req)
        verb = "Sign-in" if form.purpose == "login" else "Submission"
        seed = syn.seed_of(f"{fl.key}|extra")
        if fl.text_like:
            padded = f"  {syn.valid_value(fl, seed)}  "
            if not fl.maxlength or len(padded) <= fl.maxlength:
                mk = self.literal_item(
                    form, fl, feature, recipe="eg:padded", value=padded, kind="valid",
                    display="a valid value with 2 spaces before and after",
                )  # fmt: skip
                if fl.type == "email":
                    expected = f"{fl.label} is accepted: browsers remove spaces around an email address"
                    label = Provenance.inferred.value
                else:
                    expected = (
                        f"{fl.label} is accepted and the spaces before and after are removed "
                        "(assumed: surrounding spaces should not be stored)"
                    )
                    label = Provenance.assumed.value
                steps = self._fill_steps(form, feature, {fl.key: mk})
                steps.append(self._submit(form, expected))
                self._extra_case(
                    req, form, fl, "padded", f"{fl.label} with spaces before and after the value", steps, expected,
                    label, "eg.leading_trailing_spaces",
                )  # fmt: skip
        if fl.maxlength and fl.text_like:
            n = fl.maxlength
            mk = self.literal_item(
                form, fl, feature, recipe=f"eg:paste:{n + 1}", value=syn.value_of_length(fl, n + 1, seed),
                kind="invalid", display=f"{n + 1} characters",
            )  # fmt: skip
            steps = self._fill_steps(form, feature, {fl.key: mk})
            for st in steps:
                if st["data"] == [mk]:
                    st["action"] = f"Paste {{d0}} into {fl.label}"
                    st["expected"] = f"{fl.label} holds at most {n} characters"
            expected = f"{fl.label} keeps only the first {n} characters and no validation message is shown"
            steps.append(self._submit(form, expected))
            self._extra_case(
                req, form, fl, f"paste_over_max:{n + 1}", f"{fl.label}: paste {n + 1} characters", steps, expected,
                Provenance.inferred.value, "eg.paste_over_maxlength",
            )  # fmt: skip
        if fl.type == "email":
            local = syn.email(seed).split("@")[0]
            for cid, value, what in (
                ("email_space", f"{local.replace('.', ' ')}@example.com", "a space inside"),
                ("email_double_at", f"{local}@@example.com", 'two "@"'),
            ):
                mk = self.literal_item(form, fl, feature, recipe=f"eg:{cid}", value=value, kind="invalid", display=what)
                expected = f"{verb} is blocked and {fl.label} is identified as an invalid email address"
                steps = self._fill_steps(form, feature, {fl.key: mk})
                steps.append(self._submit(form, expected))
                self._extra_case(
                    req, form, fl, cid, f"{fl.label} with {what}: rejected", steps, expected,
                    Provenance.inferred.value, "eg.malformed_email",
                )  # fmt: skip
            # The EP invalid classes, for an email field whose format requirement isn't the one asked about.
            for p in val.email_partitions(fl):
                if p.kind != "invalid":
                    continue
                value = self._partition_value(fl, p, syn.seed_of(f"{fl.key}|{p.id}"))
                mk = self.literal_item(
                    form, fl, feature, recipe=f"ep:{p.data}:", value=value, kind="invalid",
                    display=p.description.replace(f"{fl.label} ", "", 1),
                )  # fmt: skip
                expected = self._ep_expected(form, fl, p)
                steps = self._fill_steps(form, feature, {fl.key: mk})
                steps.append(self._submit(form, expected))
                self._extra_case(
                    req, form, fl, p.id.rsplit(":", 1)[-1], f"{p.description}: rejected", steps, expected,
                    Provenance.inferred.value, "eg.malformed_email", technique=EP,
                )  # fmt: skip

    # ------------------------------------------------------------------ at least one case per approved requirement

    def _cover_every_requirement(self) -> None:
        """Every approved requirement gets at least one case. Where no technique above produced one (for example a
        security or backend requirement), a checklist case is designed from its acceptance criteria."""
        covered = {lin for c in self.out.cases for lin in c.requirement_lineages}
        skipped = set(self.out.skipped_requirements)
        for req in self.inp.requirements:
            if req.lineage_id in covered:
                continue
            if req.rule == "nfr.https_credentials":
                self._https(req)
            else:
                self._fallback_checklist(req)
            skipped.discard(req.key)
        self.out.skipped_requirements = [k for k in self.out.skipped_requirements if k in skipped]

    def _passive_type(self, req: ReqIn) -> tuple[str, str]:
        """The case's test type and a note: a type that isn't designed (needs approval or is out of scope) gets a
        passive functional check, never active testing."""
        ttype = test_type_for(req)
        if self._type_ok(ttype):
            return ttype, ""
        if ttype in APPROVAL_TYPES:
            return "functional", f"A passive check only: active {ttype} testing needs separate approval (Phase 5)."
        return "functional", f"A passive check only: {ttype} testing is out of scope in the approved strategy."

    def _https(self, req: ReqIn) -> None:
        form = self.forms.get(req.anchor)
        path = form.path if form is not None else (self.inp.signed_in_path or "/")
        submit = form.submit_label if form is not None else "Sign in"
        ttype, note = self._passive_type(req)
        steps = [
            {
                "action": f"Open {path} in a browser with the developer tools Network panel open",
                "data": [],
                "expected": "The address starts with https:// and the browser shows the connection as secure",
            },
            {
                "action": "Inspect the sign-in form's action address",
                "data": [],
                "expected": "The form submits to an https:// address",
            },
            {
                "action": f"Sign in with the saved test account and press {submit}",
                "data": [],
                "expected": "The sign-in request in the Network panel goes to an https:// address",
            },
        ]
        self._checklist(
            req,
            ttype,
            "Sign-in credentials are sent only over HTTPS",
            steps,
            "The sign-in page is served over HTTPS and the credentials are sent only to an https:// address",
            [f"On {path}", "Signed out", "Saved test credentials"],
            "https_signin",
            note=note,
        )

    def _fallback_checklist(self, req: ReqIn) -> None:
        ttype, note = self._passive_type(req)
        form = self.forms.get(req.anchor)
        pre = [f"On {form.path}"] if form is not None else []
        steps: list[dict[str, Any]] = []
        thens: list[str] = []
        for a in req.acs[:8]:
            given = a.given.strip().rstrip(".")
            when = a.when.strip().rstrip(".")
            then = a.then.strip().rstrip(".")
            if given and given not in pre:
                pre.append(_cap(given))
            steps.append({"action": _cap(when) or f"Check {a.key}", "data": [], "expected": _cap(then)})
            if then:
                thens.append(then)
        if not steps:
            text = (req.description or req.title).strip().rstrip(".")
            steps.append({"action": f"Check: {req.title.rstrip('.')}", "data": [], "expected": _cap(text)})
            thens.append(text)
        expected = _cap("; ".join(dict.fromkeys(thens))) if thens else _cap(req.title)
        self._checklist(req, ttype, _cap(req.title.rstrip(".")), steps, expected, pre, "requirement_check", note=note)

    # ------------------------------------------------------------------ helpers

    def _not_designed(self) -> None:
        for t in self.inp.test_types:
            name = str(t.get("type"))
            if t.get("requires_approval") or name in APPROVAL_TYPES:
                self.out.not_designed.append({"test_type": name, "reason": NOT_DESIGNED_APPROVAL})
            elif name == "exploratory":
                self.out.not_designed.append({"test_type": name, "reason": NOT_DESIGNED_EXPLORATORY})
            elif not t.get("in_scope"):
                self.out.not_designed.append({"test_type": name, "reason": NOT_DESIGNED_SCOPE})

    def _type_ok(self, ttype: str) -> bool:
        if ttype in APPROVAL_TYPES:
            return False
        return ttype in self.in_scope or (ttype == "functional" and not self.inp.test_types)

    def _allowed(self, req: ReqIn, technique: str) -> bool:
        if technique in ALWAYS_ALLOWED:
            return True
        sets = [self.inp.techniques_by_feature[f] for f in req.feature_ids if f in self.inp.techniques_by_feature]
        if not sets:
            return True  # the strategy assigned no technique to this requirement's feature: all apply
        return any(technique in s for s in sets)

    def _risk(self, lineages: list[str], features: list[str]) -> RiskFact | None:
        return top_risk(self.inp.risks, set(lineages), set(features))

    def _req_risk_level(self, req: ReqIn) -> str | None:
        r = self._risk([req.lineage_id], list(req.feature_ids))
        return r.level if r else None

    def _ac_lineages(self, req: ReqIn, *kinds: str) -> list[str]:
        return [a.lineage_id for a in req.acs if not kinds or a.kind in kinds]

    def _condition(self, c: ConditionDraft) -> ConditionDraft:
        self.out.conditions.append(c)
        return c

    def _case(self, req: ReqIn, c: CaseDraft) -> None:
        n = self.per_req.get(req.lineage_id, 0)
        if n >= MAX_CASES_PER_REQUIREMENT:
            if n == MAX_CASES_PER_REQUIREMENT:
                self.out.issues.append(
                    issue(
                        "warning",
                        "case_cap_reached",
                        f"{req.key} reached the limit of {MAX_CASES_PER_REQUIREMENT} generated cases; "
                        "further cases for it were not designed",
                        req.key,
                    )
                )
            self.per_req[req.lineage_id] = n + 1
            return
        self.per_req[req.lineage_id] = n + 1
        c.risk = self._risk(c.requirement_lineages, c.feature_ids)
        self.out.cases.append(c)

    def _data(self, d: DataDraft) -> str:
        self.out.data.setdefault(d.match_key, d)
        return d.match_key

    def _form_ref(self, form: FormIn, fl: val.FieldFacts) -> dict[str, Any]:
        return {
            "form_anchor": form.anchor,
            "path": form.path,
            "page_id": form.page_id,
            "form_index": form.form_index,
            "field_key": fl.key,
            "field_type": fl.type,
        }

    def _feature(self, req: ReqIn) -> str | None:
        return req.feature_ids[0] if req.feature_ids else None

    def valid_item(self, form: FormIn, fl: val.FieldFacts, feature: str | None) -> str:
        if fl.is_password:
            return self.secret_item(form, fl, feature, altered=False)
        seed = syn.seed_of(fl.key)
        value = syn.valid_value(fl, seed)
        vt = "email" if fl.type == "email" else "number" if fl.type == "number" else "text"
        return self._data(
            DataDraft(
                f"{fl.key}|valid",
                f"{fl.label} · valid",
                fl.label,
                fl.selector,
                fl.type,
                self._form_ref(form, fl),
                feature,
                "valid",
                vt,
                value,
                None,
                len(value),
                "factory.valid",
                display="valid",
            )
        )

    def secret_item(self, form: FormIn, fl: val.FieldFacts, feature: str | None, *, altered: bool) -> str:
        part = "password" if fl.is_password else "username"
        name = f"Saved test account · {part}" + (", altered" if altered else "")
        display = f"the saved test account's {part}" + (", altered so it is wrong" if altered else "")
        return self._data(
            DataDraft(
                f"{fl.key}|secret{'|altered' if altered else ''}",
                name,
                fl.label,
                fl.selector,
                fl.type,
                self._form_ref(form, fl),
                feature,
                "secret_ref",
                "secret_ref",
                None,
                syn.CREDENTIALS_REF,
                None,
                "secret.altered" if altered else "secret.reference",
                display=display,
            )
        )

    def literal_item(
        self,
        form: FormIn,
        fl: val.FieldFacts,
        feature: str | None,
        *,
        recipe: str,
        value: str,
        kind: str,
        display: str,
        boundary: dict[str, str] | None = None,
    ) -> str:
        vt = (
            "empty"
            if value == ""
            else "whitespace"
            if not value.strip()
            else "email"
            if fl.type == "email" and "@" in value
            else "number"
            if fl.type == "number"
            else "text"
        )
        name = f"{fl.label} · {display}"
        return self._data(
            DataDraft(
                f"{fl.key}|{recipe}",
                name,
                fl.label,
                fl.selector,
                fl.type,
                self._form_ref(form, fl),
                feature,
                kind,
                vt,
                value,
                None,
                len(value),
                f"factory.{recipe.split(':')[0]}",
                boundary=boundary,
                display=display,
            )
        )

    def _fill_steps(
        self,
        form: FormIn,
        feature: str | None,
        overrides: dict[str, str | None],
        *,
        typed: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Open the form, fill every field (valid unless overridden; None leaves a field empty)."""
        steps: list[dict[str, Any]] = [
            {"action": f"Open {form.path}", "data": [], "expected": f"The {form.name} form is shown"}
        ]
        for fl in form.fields:
            if fl.type in ("checkbox", "radio", "file", "hidden"):
                continue
            if fl.key in overrides:
                mk = overrides[fl.key]
                if mk is None:
                    steps.append({"action": f"Leave {fl.label} empty", "data": [], "expected": ""})
                    continue
            else:
                if not fl.required and fl.is_password:
                    continue
                mk = self.valid_item(form, fl, feature)
            verb = "Type" if typed and fl.key in typed else "Enter"
            steps.append({"action": f"{verb} {{d0}} in {fl.label}", "data": [mk], "expected": ""})
        return steps

    def _submit(self, form: FormIn, expected: str) -> dict[str, Any]:
        return {"action": f"Press {form.submit_label}", "data": [], "expected": expected}

    def _side_effects(self, form: FormIn, accepted: bool) -> list[str]:
        if not accepted:
            return []
        if form.purpose == "login":
            return ["signs_in"]
        if form.purpose in ("registration",):
            return ["submits_form", "creates_data"]
        if form.purpose == "checkout":
            return ["submits_form", "external_transaction"]
        return ["submits_form"]

    def _automation(self, *, manual: str | None = None, needs_credentials: bool = False) -> tuple[str, str]:
        if manual:
            return "manual_only", f"{PRELIMINARY} {manual}"
        if self.inp.captcha:
            return "manual_only", f"{PRELIMINARY} The form is protected by a CAPTCHA."
        if needs_credentials and not self.inp.credentials_saved:
            return "partial", f"{PRELIMINARY} Needs test credentials, which are not saved yet."
        return "suitable", f"{PRELIMINARY} Scriptable: fixed inputs and a visible result."

    def _form_note(self, form: FormIn) -> list[str]:
        note = val.no_max_note(val.missing_upper_bounds([f for f in form.fields if f.type not in ("select",)]))
        return [note] if note else []

    # ------------------------------------------------------------------ field requirements (EP, BVA)

    def _field_requirement(self, req: ReqIn) -> None:
        found = self.fields.get(req.anchor)
        if found is None:
            self.out.skipped_requirements.append(req.key)
            return
        form, fl = found
        rule = req.rule
        partitions: list[val.Partition] = []
        if rule == "form.required_field":
            partitions = val.required_partitions(fl) + val.select_partitions(fl)
        elif rule == "form.email_format":
            partitions = val.email_partitions(fl)
        elif rule == "form.range":
            partitions = val.number_partitions(fl)
        elif rule == "form.pattern":
            partitions = val.pattern_partitions(fl)
        if partitions and self._allowed(req, EP):
            self._ep(req, form, fl, partitions)
        mode = val.mode_for(self._req_risk_level(req))
        sets: list[val.BvaSet] = []
        if rule == "form.required_field":
            r = val.required_boundaries(fl, mode)
            sets = [r] if r else []
        elif rule in ("form.length_limit", "form.pattern"):
            sets = val.length_boundaries(fl, mode)
        elif rule == "form.range":
            sets = val.range_boundaries(fl, mode)
        ac_values = [(a, list(a.test_values)) for a in req.acs if a.test_values]
        for _a, tv in ac_values:
            extra = val.ac_boundaries(fl, [{"label": lb, "value": v} for lb, v in tv])
            if extra is None:
                continue
            have_len = {v.length for s in sets for v in s.values if v.length is not None}
            have_val = {v.value for s in sets for v in s.values if v.value is not None}
            extra.values = [
                v for v in extra.values if (v.length is None or v.length not in have_len) and v.value not in have_val
            ]
            if extra.values:
                sets.append(extra)
        for bs in sets:
            self.out.allowed_boundaries.setdefault(fl.key, set()).update(
                v.length for v in bs.values if v.length is not None
            )
        if sets and self._allowed(req, BVA):
            self._bva(req, form, fl, sets, mode)
        elif not sets and rule == "form.length_limit":
            self.out.issues.append(
                issue("info", "boundary_not_found", f"No length constraint found for {fl.label}", req.key)
            )

    def _ep(self, req: ReqIn, form: FormIn, fl: val.FieldFacts, partitions: list[val.Partition]) -> None:
        feature = self._feature(req)
        cmk = f"{req.match_key}|{EP}"
        self.out.allowed_partitions.setdefault(fl.key, set()).update(p.id for p in partitions)
        self._condition(
            ConditionDraft(
                cmk,
                f"{fl.label}: {_join([p.description for p in partitions])}"[:200],
                f"Equivalence classes of {fl.label} on the {form.name} form, from its declared constraints.",
                EP,
                "functional",
                feature,
                [req.lineage_id],
                self._ac_lineages(req),
                {
                    "field": fl.label,
                    "constraint": field_constraints(fl),
                    "classes": [{"id": p.id, "kind": p.kind, "description": p.description} for p in partitions],
                },
                [{"id": p.id, "label": p.description} for p in partitions],
                [],
                f"design.ep.{req.rule}",
                req.provenance,
                list(req.evidence_refs),
            )
        )
        for p in partitions:
            seed = syn.seed_of(f"{fl.key}|{p.id}")
            if p.kind == "valid" and p.data in ("nonempty", "email") and not fl.pattern:
                mk = self.valid_item(form, fl, feature)
            else:
                value = self._partition_value(fl, p, seed)
                kind = "valid" if p.kind == "valid" else "invalid"
                mk = self.literal_item(
                    form,
                    fl,
                    feature,
                    recipe=f"ep:{p.data}:{p.value or ''}",
                    value=value,
                    kind=kind,
                    display=p.description.replace(f"{fl.label} ", "", 1)
                    if p.description.startswith(fl.label)
                    else p.description,
                )
            accepted = p.kind == "valid"
            expected = self._ep_expected(form, fl, p)
            steps = self._fill_steps(form, feature, {fl.key: mk})
            steps.append(self._submit(form, expected))
            ac = self._matching_ac(req, accepted)
            self._case(
                req,
                CaseDraft(
                    f"{cmk}#{p.id}",
                    cmk,
                    p.id,
                    f"{p.description}: {'accepted' if accepted else 'rejected'}"[:160],
                    f"Check that the {form.name} form {'accepts' if accepted else 'rejects'} {p.description[:1].lower() + p.description[1:]}.",
                    [f"On {form.path}", "Signed out"],
                    steps,
                    expected,
                    EP,
                    "functional",
                    "system",
                    [req.lineage_id],
                    [ac.lineage_id] if ac else [],
                    classify(expected, req.provenance, ac.provenance if ac else Provenance.inferred.value),
                    f"design.ep.{req.rule}",
                    f"Equivalence class: {p.description} ({p.kind} partition of {fl.label})",
                    side_effects=self._side_effects(form, accepted),
                    automation=self._automation(),
                    evidence_refs=list(req.evidence_refs),
                    feature_ids=list(req.feature_ids),
                    positive=accepted,
                ),
            )

    def _partition_value(self, fl: val.FieldFacts, p: val.Partition, seed: int) -> str:
        if p.data == "empty":
            return ""
        if p.data == "email_missing_at":
            return syn.email_missing_at(seed)
        if p.data == "email_missing_domain":
            return syn.email_missing_domain(seed)
        if p.data == "pattern_match":
            return syn.valid_value(fl, seed)
        if p.data == "pattern_mismatch":
            return syn.pattern_mismatch(fl)
        if p.data == "non_numeric":
            return "twelve"
        if p.value is not None:
            return p.value
        return syn.valid_value(fl, seed)

    def _ep_expected(self, form: FormIn, fl: val.FieldFacts, p: val.Partition) -> str:
        if p.kind == "valid":
            return f"{fl.label} is accepted without a validation message"
        verb = "Sign-in" if form.purpose == "login" else "Submission"
        if p.data == "empty":
            return f"{verb} is blocked and {fl.label} is identified as required"
        if p.data.startswith("email"):
            return f"{verb} is blocked and {fl.label} is identified as an invalid email address"
        if p.data == "pattern_mismatch":
            return f"{verb} is blocked and {fl.label} is identified as not matching the required format"
        if p.data == "non_numeric":
            return f"{fl.label} does not accept the text and {verb.lower()} is blocked"
        return f"{verb} is blocked and {fl.label} is identified as out of range"

    def _matching_ac(self, req: ReqIn, positive: bool) -> AcIn | None:
        want = ("positive",) if positive else ("negative", "boundary")
        return next((a for a in req.acs if a.kind in want), None) or (req.acs[0] if req.acs else None)

    def _bva(self, req: ReqIn, form: FormIn, fl: val.FieldFacts, sets: list[val.BvaSet], mode: val.Mode) -> None:
        feature = self._feature(req)
        cmk = f"{req.match_key}|{BVA}"
        items = [v for bs in sets for v in bs.values]
        notes = self._form_note(form)
        if not fl.maxlength and fl.text_like and not any(bs.constraint in ("maxlength",) for bs in sets):
            per_field = val.no_max_note([fl.label])
            if per_field and per_field not in notes:
                notes.append(per_field)
        self._condition(
            ConditionDraft(
                cmk,
                f"{fl.label} length and value boundaries"
                if any(v.length is not None for v in items)
                else f"{fl.label} boundaries",
                f"Boundary values of {fl.label} on the {form.name} form ({'3-value' if mode == '3_value' else '2-value'} "
                "boundary value analysis).",
                BVA,
                "functional",
                feature,
                [req.lineage_id],
                self._ac_lineages(req),
                {
                    "field": fl.label,
                    "constraint": ", ".join(dict.fromkeys(_bva_constraint(fl, bs) for bs in sets)),
                    "boundary": ", ".join(dict.fromkeys(bs.boundary for bs in sets)),
                    "values": [
                        {"id": v.id, "length": v.length, "value": v.value, "side": v.side, "constraint": v.constraint}
                        for v in items
                    ],
                    "mode": mode,
                },
                [{"id": v.id, "label": f"{fl.label}: {v.label}"} for v in items],
                notes,
                f"design.bva.{req.rule}",
                req.provenance,
                list(req.evidence_refs),
            )
        )
        seen: set[str] = set()
        for v in items:
            if v.id in seen:
                continue
            seen.add(v.id)
            seed = syn.seed_of(f"{fl.key}|{v.id}")
            value = syn.value_of_length(fl, v.length, seed) if v.length is not None else v.value or ""
            mk = self.literal_item(
                form,
                fl,
                feature,
                recipe=f"bva:{v.id}",
                value=value,
                kind="boundary",
                display=v.label,
                boundary={"condition": cmk, "coverage_item": v.id},
            )
            accepted, expected = self._bva_expected(form, fl, v)
            explanation = f"Boundary: {v.explanation}; this case uses {v.label}"
            problem = syn.format_problem(fl, value) if not (v.constraint == "maxlength" and v.side == "above") else None
            if accepted and problem is not None:
                # The length is inside the boundary but the value can't be valid for the field's format (for
                # example a 1-character email address), so the field rejects it.
                accepted, expected = False, self._format_expected(form, fl, problem)
                explanation += f", which isn't a valid {self._format_name(fl, problem)}, so it is rejected"
            typed = {fl.key} if v.constraint == "maxlength" else None
            steps = self._fill_steps(form, feature, {fl.key: mk}, typed=typed)
            if v.constraint == "maxlength" and v.side == "above":
                steps[-1]["expected"] = f"{fl.label} holds at most {v.boundary} characters"
            steps.append(self._submit(form, expected))
            ac = self._matching_ac(req, accepted)
            self._case(
                req,
                CaseDraft(
                    f"{cmk}#{v.id}",
                    cmk,
                    v.id,
                    f"{fl.label} with {v.label}"[:160],
                    f"Check the {form.name} form at the {fl.label} boundary ({v.boundary}) with {v.label}.",
                    [f"On {form.path}", "Signed out"],
                    steps,
                    expected,
                    BVA,
                    "functional",
                    "system",
                    [req.lineage_id],
                    [ac.lineage_id] if ac else [],
                    classify(expected, req.provenance, ac.provenance if ac else Provenance.inferred.value),
                    f"design.bva.{req.rule}",
                    explanation,
                    side_effects=self._side_effects(form, accepted),
                    automation=self._automation(),
                    evidence_refs=list(req.evidence_refs),
                    feature_ids=list(req.feature_ids),
                    positive=accepted,
                ),
            )

    @staticmethod
    def _format_name(fl: val.FieldFacts, problem: str) -> str:
        return {
            "invalid_email": "email address",
            "invalid_url": "web address",
            "non_numeric": "number",
        }.get(problem, f"value for the pattern {fl.pattern}")

    def _format_expected(self, form: FormIn, fl: val.FieldFacts, problem: str) -> str:
        verb = "Sign-in" if form.purpose == "login" else "Submission"
        if problem == "invalid_email":
            return f"{verb} is blocked and {fl.label} is identified as an invalid email address"
        if problem == "invalid_url":
            return f"{verb} is blocked and {fl.label} is identified as an invalid web address"
        if problem == "non_numeric":
            return f"{fl.label} does not accept the text and {verb.lower()} is blocked"
        return f"{verb} is blocked and {fl.label} is identified as not matching the required format"

    def _bva_expected(self, form: FormIn, fl: val.FieldFacts, v: val.BoundaryValue) -> tuple[bool, str]:
        verb = "Sign-in" if form.purpose == "login" else "Submission"
        if v.constraint == "required":
            if v.length == 0:
                return False, f"{verb} is blocked and {fl.label} is identified as required"
            return True, f"{fl.label} is accepted without a validation message"
        if v.constraint in ("minlength", "pattern") and v.side == "below" and v.length is not None:
            if v.length == 0 and fl.required:
                return False, f"{verb} is blocked and {fl.label} is identified as required"
            return (
                False,
                f"{verb} is blocked and {fl.label} is identified as too short (at least {v.boundary} characters)",
            )
        if v.constraint == "maxlength":
            if v.side == "above":
                return (
                    True,
                    f"{fl.label} keeps only the first {v.boundary} characters and no validation message is shown",
                )
            return True, f"{fl.label} holds all {v.length} characters and is accepted without a validation message"
        if v.constraint == "pattern" and v.side == "above" and v.length is not None and v.boundary.isdigit():
            hi = int(v.boundary)
            if v.length > hi and v.id.startswith("len:"):
                return False, f"{verb} is blocked and {fl.label} is identified as too long (at most {hi} characters)"
        if v.constraint in ("min", "max"):
            inside = (v.side in ("on", "above")) if v.constraint == "min" else (v.side in ("on", "below"))
            if not inside:
                return False, f"{verb} is blocked and {fl.label} is identified as out of range"
            return True, f"{fl.label} is accepted without a validation message"
        if v.constraint == "ac":
            return True, f"{fl.label} with {v.label} is handled as the acceptance criterion states"
        return True, f"{fl.label} is accepted without a validation message"

    # ------------------------------------------------------------------ forms: all valid + error guessing

    def _form_purpose(self, req: ReqIn) -> None:
        form = self.forms.get(req.anchor)
        if form is None:
            self.out.skipped_requirements.append(req.key)
            return
        feature = self._feature(req)
        outcome = self.all_reqs.get(f"{form.anchor}|form.submission_outcome")
        outcome_ok = outcome is not None and outcome.status == "approved"
        lineages = [req.lineage_id] + ([outcome.lineage_id] if outcome and outcome_ok else [])
        notes = self._form_note(form)
        if self._allowed(req, EP):
            cmk = f"{req.match_key}|{EP}"
            self._condition(
                ConditionDraft(
                    cmk,
                    f"{_cap(form.name)} form: every field valid",
                    f"The valid partition of every field on the {form.name} form, covered by one shared case.",
                    EP,
                    "functional",
                    feature,
                    lineages,
                    self._ac_lineages(req, "positive"),
                    {
                        "field": "all fields",
                        "classes": [
                            {"id": "all_valid", "kind": "valid", "description": "Every field holds a valid value"}
                        ],
                    },
                    [{"id": "all_valid", "label": "Every field valid"}],
                    notes,
                    "design.ep.form.all_valid",
                    req.provenance,
                    list(req.evidence_refs),
                )
            )
            expected = "The form is accepted without validation messages"
            ac_lins = self._ac_lineages(req, "positive")
            labels = [req.provenance] + [a.provenance for a in req.acs if a.kind == "positive"]
            if outcome is not None and outcome_ok:
                then = next((a.then for a in outcome.acs if a.kind == "positive"), "")
                if then:
                    expected = f"{expected}, and {then}"
                ac_lins += [a.lineage_id for a in outcome.acs if a.kind == "positive"]
                labels.append(outcome.provenance)
            steps = self._fill_steps(form, feature, {})
            steps.append(self._submit(form, expected))
            verb = "Send" if form.purpose == "contact" else "Submit"
            self._case(
                req,
                CaseDraft(
                    f"{cmk}#all_valid",
                    cmk,
                    "all_valid",
                    f"{verb} the {form.name} form with every field valid",
                    f"Check that a complete, valid {form.name} form is accepted.",
                    [f"On {form.path}", "Signed out"],
                    steps,
                    expected,
                    EP,
                    "functional",
                    "system",
                    lineages,
                    ac_lins,
                    classify(expected, *labels),
                    "design.ep.form.all_valid",
                    "Valid partition representative shared by every field of the form",
                    side_effects=self._side_effects(form, True),
                    automation=self._automation(),
                    evidence_refs=list(req.evidence_refs),
                    feature_ids=list(req.feature_ids),
                    positive=True,
                    smoke_candidate=True,
                ),
            )
        self._error_guessing(req, form)

    def _error_guessing(self, req: ReqIn, form: FormIn) -> None:
        feature = self._feature(req)
        cmk = f"{req.match_key}|{EG}"
        required = [f for f in form.fields if f.required and f.text_like and not f.is_password]
        optional = [f for f in form.fields if not f.required and f.type in ("text", "textarea", "email", "tel", "url")]
        items: list[dict[str, str]] = []
        basis: list[dict[str, str]] = []
        cases: list[CaseDraft] = []
        verb = "Send" if form.purpose == "contact" else "Submit"
        if required:
            for fl in optional:
                q = self.all_reqs.get(f"{fl.key}|form.optional_field")
                if q is None or q.status == "rejected":
                    continue
                cid = f"optional_empty:{val._slug(fl)}"
                items.append(
                    {"id": cid, "label": f"{fl.label} left empty while {_join([r.label for r in required])} are filled"}
                )
                basis.append({"id": cid, "catalogue_id": "eg.optional_next_to_required"})
                cases.append(self._optional_case(req, form, fl, q, cmk, cid, verb, feature))
            for fl in required:
                cid = f"whitespace:{val._slug(fl)}"
                field_req = self.all_reqs.get(f"{fl.key}|form.required_field")
                items.append({"id": cid, "label": f"{fl.label} holds only spaces"})
                basis.append({"id": cid, "catalogue_id": "eg.whitespace_only"})
                mk = self.literal_item(
                    form, fl, feature, recipe="eg:whitespace", value="   ", kind="invalid", display="3 spaces"
                )
                expected = (
                    f"Submission is blocked and {fl.label} is identified as required "
                    "(assumed: input of only spaces should count as empty)"
                )
                steps = self._fill_steps(form, feature, {fl.key: mk})
                steps.append(self._submit(form, expected))
                lins = [req.lineage_id] + (
                    [field_req.lineage_id] if field_req and field_req.status == "approved" else []
                )
                cases.append(
                    CaseDraft(
                        f"{cmk}#{cid}",
                        cmk,
                        cid,
                        f"{verb} the {form.name} form with only spaces in {fl.label}",
                        f"Check that a {fl.label} of only spaces is not accepted as filled in.",
                        [f"On {form.path}", "Signed out"],
                        steps,
                        expected,
                        EG,
                        "functional",
                        "system",
                        lins,
                        [],
                        Provenance.assumed.value,
                        "design.eg.whitespace_only",
                        "Error guessing: whitespace-only input in a required field (catalogue eg.whitespace_only)",
                        automation=self._automation(),
                        evidence_refs=list(req.evidence_refs),
                        feature_ids=list(req.feature_ids),
                    )
                )
        if form.purpose != "login":
            for cid, label, title, steps_tail, expected, cat in (
                (
                    "double_submit",
                    "The submit button pressed twice quickly",
                    f"Press {form.submit_label} twice quickly on the {form.name} form",
                    [
                        {
                            "action": f"Press {form.submit_label} twice quickly",
                            "data": [],
                            "expected": "Only one submission is made and one confirmation is shown",
                        }
                    ],
                    "Only one submission is made and one confirmation is shown (assumed)",
                    "eg.double_submit",
                ),
                (
                    "back_after_submit",
                    "Browser Back after submitting",
                    f"Go back after sending the {form.name} form",
                    [
                        self._submit(form, "The form is accepted"),
                        {
                            "action": "Press the browser Back button",
                            "data": [],
                            "expected": "The form is not sent again without the user choosing to resend it",
                        },
                    ],
                    "The form is not sent again without the user choosing to resend it (assumed)",
                    "eg.back_after_submit",
                ),
            ):
                items.append({"id": cid, "label": label})
                basis.append({"id": cid, "catalogue_id": cat})
                steps = self._fill_steps(form, feature, {}) + steps_tail
                cases.append(
                    CaseDraft(
                        f"{cmk}#{cid}",
                        cmk,
                        cid,
                        title,
                        f"Check the {form.name} form against a common mistake: {label.lower()}.",
                        [f"On {form.path}", "Signed out"],
                        steps,
                        expected,
                        EG,
                        "functional",
                        "system",
                        [req.lineage_id],
                        [],
                        Provenance.assumed.value,
                        f"design.{cat}",
                        f"Error guessing: {label.lower()} (catalogue {cat})",
                        side_effects=self._side_effects(form, True),
                        automation=self._automation(),
                        evidence_refs=list(req.evidence_refs),
                        feature_ids=list(req.feature_ids),
                    )
                )
        if not items:
            return
        self._condition(
            ConditionDraft(
                cmk,
                f"{_cap(form.name)} form: common input mistakes",
                f"Error guessing on the {form.name} form from the fixed catalogue, tied to what discovery found.",
                EG,
                "functional",
                feature,
                sorted({lin for c in cases for lin in c.requirement_lineages}),
                [],
                {"catalogue": basis},
                items,
                self._form_note(form),
                "design.eg.form",
                Provenance.assumed.value,
                list(req.evidence_refs),
            )
        )
        for c in cases:
            self._case(req, c)

    def _optional_case(
        self,
        req: ReqIn,
        form: FormIn,
        fl: val.FieldFacts,
        q: ReqIn,
        cmk: str,
        cid: str,
        verb: str,
        feature: str | None,
    ) -> CaseDraft:
        """Decision D6: the expected result is not guessed while the question is open."""
        text = " ".join([q.title, q.description, *(a.then for a in q.acs)])
        approved = q.status == "approved"
        says_mandatory = approved and bool(MANDATORY_RE.search(text)) and not OPTIONAL_RE.search(q.title)
        says_optional = approved and not says_mandatory and bool(OPTIONAL_RE.search(text)) and "Confirm" not in q.title
        lineages = [req.lineage_id] + ([q.lineage_id] if approved else [])
        open_q: dict[str, str] | None = None
        status = "defined"
        if says_mandatory:
            expected = f"Submission is blocked and {fl.label} is identified as required"
            label = classify(expected, Provenance.inferred.value, q.provenance)
            automation = self._automation()
        elif says_optional:
            expected = f"The form is accepted with {fl.label} left empty"
            label = classify(expected, Provenance.inferred.value, q.provenance)
            automation = self._automation()
        else:
            # The UI and reports show this with a "Not decided:" prefix, so the text itself doesn't repeat it.
            expected = f"{q.key} asks whether {fl.label} is optional"
            status = "open_question"
            open_q = {"requirement_lineage_id": q.lineage_id, "key": q.key, "message": expected, "field": fl.label}
            label = Provenance.unverified.value
            automation = self._automation(manual="The expected result is an open question.")
        steps = self._fill_steps(form, feature, {fl.key: None})
        steps.append(self._submit(form, expected))
        return CaseDraft(
            f"{cmk}#{cid}",
            cmk,
            cid,
            f"{verb} the {form.name} form with an empty {fl.label}",
            f"Find out how the {form.name} form handles an empty {fl.label} when other fields are required.",
            [f"On {form.path}", "Signed out"],
            steps,
            expected,
            EG,
            "functional",
            "system",
            lineages,
            [],
            label,
            "design.eg.optional_next_to_required",
            f"Error guessing: {fl.label} has no required attribute while "
            f"{_join([f.label for f in form.fields if f.required])} do (catalogue eg.optional_next_to_required)",
            side_effects=self._side_effects(form, says_optional),
            automation=automation,
            expected_result_status=status,
            open_question=open_q,
            evidence_refs=list(q.evidence_refs or req.evidence_refs),
            feature_ids=list(req.feature_ids),
        )

    # ------------------------------------------------------------------ sign-in (decision table, state transition)

    def _signin(self, req: ReqIn) -> None:
        form = self.forms.get(req.anchor)
        if form is None:
            self.out.skipped_requirements.append(req.key)
            return
        user = next((f for f in form.fields if not f.is_password), None)
        pw = next((f for f in form.fields if f.is_password), None)
        if user is None or pw is None:
            self._use_case(req)
            return
        feature = self._feature(req)
        invalid_req = self.all_reqs.get(f"{form.anchor}|auth.invalid_credentials")
        area_reqs = [r for r in self.inp.requirements if r.rule == "auth.signed_in_area" and r.status == "approved"]
        lineages = [req.lineage_id]
        if invalid_req is not None and invalid_req.status == "approved":
            lineages.append(invalid_req.lineage_id)
        pre = [f"On {form.path}", "Signed out"]
        u_ok = self.secret_item(form, user, feature, altered=False)
        p_ok = self.secret_item(form, pw, feature, altered=False)
        p_bad = self.secret_item(form, pw, feature, altered=True)
        u_empty = self.literal_item(form, user, feature, recipe="dt:empty", value="", kind="invalid", display="empty")
        p_empty = self.literal_item(form, pw, feature, recipe="dt:empty", value="", kind="invalid", display="empty")
        seed = syn.seed_of(user.key)
        u_unknown = self.literal_item(
            form,
            user,
            feature,
            recipe="dt:unknown",
            value=f"unknown.user.{seed % 1000}@example.com",
            kind="invalid",
            display="an unknown account",
        )
        rules: list[tuple[str, str, str | None, str | None, str, bool, str]] = [
            (
                "r1",
                f"{user.label} empty",
                u_empty,
                p_ok,
                f"Sign-in is blocked and {user.label} is identified as required",
                False,
                "blocked",
            ),
        ]
        if user.type == "email":
            u_bad = self.literal_item(
                form,
                user,
                feature,
                recipe="dt:invalid_format",
                value=syn.email_missing_at(seed),
                kind="invalid",
                display='no "@"',
            )
            rules.append(
                (
                    "r2",
                    f"{user.label} not a valid email address",
                    u_bad,
                    p_ok,
                    f"Sign-in is blocked and {user.label} is identified as an invalid email address",
                    False,
                    "blocked",
                )
            )
        pw_expected = (
            f"Sign-in is blocked and {pw.label} is identified as required"
            if pw.required
            else "An error message is shown and the user is not signed in"
        )
        rules += [
            (
                "r3",
                f"Valid {user.label.lower()}, {pw.label} empty",
                u_ok,
                p_empty,
                pw_expected,
                False,
                "blocked" if pw.required else "error",
            ),
            (
                "r4",
                f"Valid {user.label.lower()}, wrong {pw.label.lower()}",
                u_ok,
                p_bad,
                "An error message is shown and the user is not signed in",
                False,
                "error",
            ),
            (
                "r5",
                f"Valid {user.label.lower()} and correct {pw.label.lower()}",
                u_ok,
                p_ok,
                "The user is signed in and sees the signed-in area",
                True,
                "signed_in",
            ),
        ]
        if invalid_req is not None and invalid_req.status == "approved":
            rules.append(
                (
                    "r6",
                    f"Unknown {user.label.lower()}",
                    u_unknown,
                    p_bad,
                    "A generic error is shown that does not reveal whether the account exists",
                    False,
                    "error",
                )
            )
        if self._allowed(req, DT):
            cmk = f"{req.match_key}|{DT}"
            self._condition(
                ConditionDraft(
                    cmk,
                    f"Sign-in outcomes by {user.label.lower()} and {pw.label.lower()}",
                    "Decision table for the sign-in form, collapsed to the minimal rule set.",
                    DT,
                    "functional",
                    feature,
                    lineages,
                    self._ac_lineages(req)
                    + (self._ac_lineages(invalid_req) if invalid_req and invalid_req.status == "approved" else []),
                    {
                        "conditions": [
                            f"{user.label}: valid / invalid / empty",
                            f"{pw.label}: correct / wrong / empty",
                        ],
                        "actions": ["signed in", "error shown", "submission blocked"],
                        "rules": [{"id": r[0], "conditions": r[1], "action": r[6]} for r in rules],
                    },
                    [{"id": r[0], "label": f"{r[0].upper()}: {r[1]}"} for r in rules],
                    [],
                    "design.dt.signin",
                    req.provenance,
                    list(req.evidence_refs),
                )
            )
            for rid, cond_text, umk, pmk, expected, ok, _action in rules:
                steps = [
                    {"action": f"Open {form.path}", "data": [], "expected": "The sign-in form is shown"},
                    self._enter(user, umk),
                    self._enter(pw, pmk),
                    self._submit(form, expected),
                ]
                ac = self._matching_ac(req, ok)
                self._case(
                    req,
                    CaseDraft(
                        f"{cmk}#{rid}",
                        cmk,
                        rid,
                        f"Sign in: {cond_text[:1].lower() + cond_text[1:]}"[:160],
                        f"Check the sign-in outcome when {cond_text[:1].lower() + cond_text[1:]}.",
                        pre
                        + (
                            ["Test credentials are saved in Project settings"]
                            if umk == u_ok or pmk in (p_ok, p_bad)
                            else []
                        ),
                        steps,
                        expected,
                        DT,
                        "functional",
                        "system",
                        lineages if rid in ("r4", "r6") else [req.lineage_id],
                        [ac.lineage_id] if ac else [],
                        classify(expected, req.provenance, ac.provenance if ac else "inferred"),
                        "design.dt.signin",
                        f"Decision table rule {rid.upper()}: {cond_text} → {_action.replace('_', ' ')}",
                        side_effects=["signs_in"] if ok else [],
                        automation=self._automation(needs_credentials=umk == u_ok or pmk in (p_ok, p_bad)),
                        evidence_refs=list(req.evidence_refs),
                        feature_ids=list(req.feature_ids),
                        positive=ok,
                        smoke_candidate=ok,
                    ),
                )
        if self._allowed(req, ST):
            self._state_transition(req, form, user, pw, u_ok, p_ok, p_bad, area_reqs, pre, lineages)

    def _enter(self, fl: val.FieldFacts, mk: str | None) -> dict[str, Any]:
        if mk is None:
            return {"action": f"Leave {fl.label} empty", "data": [], "expected": ""}
        d = self.out.data[mk]
        if d.value == "":
            return {"action": f"Leave {fl.label} empty ({{d0}})", "data": [mk], "expected": ""}
        return {"action": f"Enter {{d0}} in {fl.label}", "data": [mk], "expected": ""}

    def _state_transition(
        self,
        req: ReqIn,
        form: FormIn,
        user: val.FieldFacts,
        pw: val.FieldFacts,
        u_ok: str,
        p_ok: str,
        p_bad: str,
        area_reqs: list[ReqIn],
        pre: list[str],
        lineages: list[str],
    ) -> None:
        feature = self._feature(req)
        cmk = f"{req.match_key}|{ST}"
        signed_in_path = self.inp.signed_in_path
        paths = [
            ("so_si", "Signed out → Signed in", [("Signed out", "valid credentials", "Signed in")]),
            (
                "so_e_si",
                "Signed out → Error → Signed in",
                [("Signed out", "wrong password", "Error shown"), ("Error shown", "valid credentials", "Signed in")],
            ),
        ]
        invalid = self.inp.signed_in_redirect and signed_in_path is not None
        if invalid:
            paths.append(
                (
                    "invalid_so_area",
                    f"Open {signed_in_path} while signed out (invalid transition)",
                    [("Signed out", f"open {signed_in_path}", "Signed out")],
                )
            )
        transitions: list[dict[str, Any]] = [
            {"from": "Signed out", "event": "valid credentials", "to": "Signed in"},
            {"from": "Signed out", "event": "wrong password", "to": "Error shown"},
            {"from": "Error shown", "event": "valid credentials", "to": "Signed in"},
        ]
        if invalid:
            transitions.append(
                {"from": "Signed out", "event": f"open {signed_in_path}", "to": "Signed out", "invalid": True}
            )
        area_lineages = [r.lineage_id for r in area_reqs]
        self._condition(
            ConditionDraft(
                cmk,
                "Sign-in state transitions",
                "States a visitor moves through when signing in; every valid transition is covered"
                + (", plus the invalid one discovery observed" if invalid else ""),
                ST,
                "functional",
                feature,
                lineages + area_lineages,
                [],
                {
                    "states": ["Signed out", "Error shown", "Signed in"],
                    "transitions": transitions,
                    "coverage": "all valid transitions" + (" + 1 invalid" if invalid else ""),
                },
                [{"id": p[0], "label": p[1]} for p in paths],
                [],
                "design.st.signin",
                req.provenance,
                list(req.evidence_refs),
            )
        )
        after: dict[str, Any] = (
            {"action": f"Open {signed_in_path}", "data": [], "expected": "The signed-in page is shown"}
            if signed_in_path
            else {"action": "Reload the page", "data": [], "expected": "The user is still signed in"}
        )
        signed = "The user is signed in and sees the signed-in area"
        so_si = [
            {"action": f"Open {form.path}", "data": [], "expected": "The sign-in form is shown"},
            self._enter(user, u_ok),
            self._enter(pw, p_ok),
            self._submit(form, signed),
            after,
        ]
        so_e_si = [
            {"action": f"Open {form.path}", "data": [], "expected": "The sign-in form is shown"},
            self._enter(user, u_ok),
            self._enter(pw, p_bad),
            self._submit(form, "An error message is shown and the user is not signed in"),
            self._enter(user, u_ok),
            self._enter(pw, p_ok),
            self._submit(form, signed),
            after,
        ]
        cases: list[tuple[str, str, list[dict[str, Any]], str, bool]] = [
            ("so_si", "Sign in from signed out", so_si, after["expected"], True),
            ("so_e_si", "Sign in after a failed attempt", so_e_si, after["expected"], True),
        ]
        if invalid:
            cases.append(
                (
                    "invalid_so_area",
                    f"Open {signed_in_path} while signed out",
                    [
                        {
                            "action": f"Open {signed_in_path}",
                            "data": [],
                            "expected": "The sign-in page is shown and the signed-in content is not shown",
                        },
                    ],
                    "The sign-in page is shown and the signed-in content is not shown",
                    False,
                )
            )
        path_names = {p[0]: p[1] for p in paths}
        for cid, title, steps, expected, needs_creds in cases:
            lins = (lineages if cid != "invalid_so_area" else [req.lineage_id]) + area_lineages
            self._case(
                req,
                CaseDraft(
                    f"{cmk}#{cid}",
                    cmk,
                    cid,
                    title,
                    f"Check the sign-in state path: {path_names[cid]}.",
                    pre + (["Test credentials are saved in Project settings"] if needs_creds else []),
                    steps,
                    f"{signed} ({expected[:1].lower() + expected[1:]})" if needs_creds else expected,
                    ST,
                    "functional",
                    "system",
                    lins,
                    [],
                    classify(expected, req.provenance, "inferred"),
                    "design.st.signin",
                    f"State transition path: {path_names[cid]}",
                    side_effects=["signs_in"] if needs_creds else [],
                    automation=self._automation(needs_credentials=needs_creds),
                    evidence_refs=list(req.evidence_refs),
                    feature_ids=list(req.feature_ids),
                    positive=needs_creds,
                ),
            )

    # ------------------------------------------------------------------ non-functional checklists

    def _checklist(
        self,
        req: ReqIn,
        ttype: str,
        title: str,
        steps: list[dict[str, Any]],
        expected: str,
        pre: list[str],
        cid: str,
        *,
        note: str = "",
    ) -> None:
        cmk = f"{req.match_key}|{CHECKLIST}"
        self._condition(
            ConditionDraft(
                cmk,
                title,
                req.description or title,
                CHECKLIST,
                ttype,
                self._feature(req),
                [req.lineage_id],
                self._ac_lineages(req),
                {"checks": [s["action"] for s in steps]},
                [{"id": cid, "label": title}],
                [note] if note else [],
                f"design.checklist.{req.rule}",
                req.provenance,
                list(req.evidence_refs),
            )
        )
        ac = self._matching_ac(req, True)
        self._case(
            req,
            CaseDraft(
                f"{cmk}#{cid}",
                cmk,
                cid,
                title,
                f"Check: {title[:1].lower() + title[1:]}.",
                pre,
                steps,
                expected,
                CHECKLIST,
                ttype,
                "system",
                [req.lineage_id],
                [ac.lineage_id] if ac else [],
                classify(expected, req.provenance, ac.provenance if ac else "inferred"),
                f"design.checklist.{req.rule}",
                f"Checklist: {title}" + (f". {note}" if note else ""),
                automation=self._automation(),
                evidence_refs=list(req.evidence_refs),
                feature_ids=list(req.feature_ids),
                positive=True,
            ),
        )

    def _labels(self, req: ReqIn) -> None:
        form = self.forms.get(req.anchor)
        if form is None:
            self.out.skipped_requirements.append(req.key)
            return
        labels = [f.label for f in form.fields if f.type not in ("hidden",)]
        self._checklist(
            req,
            "accessibility",
            f"Every field of the {form.name} form has an accessible label",
            [
                {"action": f"Open {form.path}", "data": [], "expected": f"The {form.name} form is shown"},
                {
                    "action": "Check each field with an accessibility checker such as axe, or a screen reader",
                    "data": [],
                    "expected": f"Each field announces its label: {_join(labels)}",
                },
            ],
            f"Each field of the {form.name} form announces its label ({_join(labels)}) and no label violation is reported",
            [f"On {form.path}"],
            "labels",
        )

    def _mobile(self, req: ReqIn) -> None:
        paths = self.inp.visited_paths[:5] or ["/"]
        steps = [{"action": f"Set the browser viewport to {self.inp.mobile_viewport}", "data": [], "expected": ""}]
        steps += [
            {
                "action": f"Open {p}",
                "data": [],
                "expected": "The page fits the screen width without horizontal scrolling",
            }
            for p in paths
        ]
        self._checklist(
            req,
            "compatibility",
            f"Pages fit a {self.inp.mobile_viewport} screen without horizontal scrolling",
            steps,
            "Every checked page fits the screen width without horizontal scrolling",
            ["A mobile-sized browser window"],
            "mobile_overflow",
        )

    def _console(self, req: ReqIn) -> None:
        paths = self.inp.visited_paths[:5] or ["/"]
        steps = [{"action": "Open the browser developer console", "data": [], "expected": ""}]
        steps += [
            {"action": f"Open {p}", "data": [], "expected": "No errors are written to the browser console"}
            for p in paths
        ]
        self._checklist(
            req,
            "functional",
            "Visited pages load without browser console errors",
            steps,
            "No errors are written to the browser console on any checked page",
            ["Browser console open"],
            "console_errors",
        )

    # ------------------------------------------------------------------ use cases (journeys, navigation, other ACs)

    def _use_case(self, req: ReqIn) -> None:
        acs = list(req.acs)
        if not acs:
            return
        level = "acceptance" if req.rule == "journey.e2e" else "system"
        ttype = "smoke" if req.rule == "nav.primary" and "smoke" in self.in_scope else test_type_for(req)
        if not self._type_ok(ttype):
            ttype = "functional"
        cmk = f"{req.match_key}|{UC}"
        signed_in = req.rule == "auth.signed_in_area"
        self._condition(
            ConditionDraft(
                cmk,
                req.title[:200],
                f"Main flow{'s' if len(acs) > 1 else ''} of {req.key}, one per acceptance criterion.",
                UC,
                ttype,
                self._feature(req),
                [req.lineage_id],
                [a.lineage_id for a in acs],
                {
                    "journey": req.title if req.rule == "journey.e2e" else None,
                    "flow": [{"id": a.key, "given": a.given, "when": a.when, "then": a.then} for a in acs],
                },
                [{"id": a.key, "label": f"{_cap(a.when)} → {a.then}"[:200]} for a in acs],
                [],
                f"design.uc.{req.rule or 'other'}",
                req.provenance,
                list(req.evidence_refs),
            )
        )
        for a in acs:
            given = re.sub(r"^(a visitor|a registered user|a signed-in user|a user)\s+(is\s+)?(on|at)\s+", "", a.given)
            setup = f"Open {given}" if given != a.given else f"Start with {a.given}"
            action = _cap(re.sub(r"^(they|the user|the visitor)\s+", "", a.when))
            expected = _cap(a.then)
            needs_creds = signed_in and "not signed in" not in a.given
            pre = ["Signed in with the saved test account"] if needs_creds else ["Signed out"]
            title = f"{_cap(a.when)}: {a.then}"
            self._case(
                req,
                CaseDraft(
                    f"{cmk}#{a.key}",
                    cmk,
                    a.key,
                    _cap(re.sub(r"^They ", "", title))[:160],
                    f"Check that {a.then} when {re.sub(r'^they ', 'a user ', a.when)}.",
                    pre,
                    [
                        {"action": setup, "data": [], "expected": ""},
                        {"action": action, "data": [], "expected": expected},
                    ],
                    expected,
                    UC,
                    ttype,
                    level,
                    [req.lineage_id],
                    [a.lineage_id],
                    classify(expected, req.provenance, a.provenance),
                    f"design.uc.{req.rule or 'other'}",
                    f"Use case: {req.title} ({a.key}: given {a.given}, when {a.when}, then {a.then})",
                    side_effects=["signs_in"] if needs_creds else [],
                    automation=self._automation(needs_credentials=needs_creds),
                    evidence_refs=list(req.evidence_refs),
                    feature_ids=list(req.feature_ids),
                    positive=a.kind == "positive",
                    smoke_candidate=a.kind == "positive",
                    suites=["smoke"] if req.rule == "nav.primary" else [],
                ),
            )

    # ------------------------------------------------------------------ suites and caps

    def _suites(self) -> None:
        smoke_features: set[str] = set()
        for c in self.out.cases:
            suites = set(c.suites)
            high = c.risk is not None and c.risk.level in ("high", "very_high")
            if c.positive and c.expected_result_status == "defined":
                suites.add("regression")
            if not c.positive and high:
                suites.add("regression")
            if c.smoke_candidate and c.positive:
                key = (c.feature_ids or ["-"])[0]
                if key not in smoke_features:
                    smoke_features.add(key)
                    suites.add("smoke")
            c.suites = sorted(suites)

    def _caps(self) -> None:
        if len(self.out.cases) > MAX_CASES:
            self.out.issues.append(
                issue(
                    "warning",
                    "case_cap_reached",
                    f"{len(self.out.cases)} cases were designed; only the first {MAX_CASES} are kept",
                )
            )
            self.out.cases = self.out.cases[:MAX_CASES]
        used = {mk for c in self.out.cases for st in c.steps for mk in st.get("data", [])}
        self.out.data = {k: v for k, v in self.out.data.items() if k in used}
        if len(self.out.data) > MAX_DATA:
            self.out.issues.append(
                issue(
                    "warning",
                    "case_cap_reached",
                    f"{len(self.out.data)} test data items were needed; the limit is {MAX_DATA}",
                )
            )
        used_conditions = {c.condition_match_key for c in self.out.cases}
        self.out.conditions = [c for c in self.out.conditions if c.match_key in used_conditions]


def extra_negatives(inp: DesignInput, lineages: set[str]) -> DesignOutput:
    """Candidate negative cases for the assistant's "Generate more negative test cases" (callers drop existing ones)."""
    return Designer(inp).extra_negatives(lineages)


def design(inp: DesignInput) -> DesignOutput:
    return Designer(inp).run()
