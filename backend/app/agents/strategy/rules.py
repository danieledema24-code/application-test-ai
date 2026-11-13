"""Test strategy and risk register rules (P2-06). Pure: builds sections and risk drafts from loaded facts.

Every likelihood/impact comes from a coded factor with evidence; score and level are computed by
`app.domain.risk` only.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from app.domain.risk import APPROVAL_TEST_TYPES, requires_approval, risk_level, risk_score

LEVELS = ("component", "component_integration", "system", "system_integration", "acceptance")
TYPE_PHASE = {
    "functional": 3,
    "smoke": 4,
    "sanity": 4,
    "regression": 4,
    "exploratory": 3,
    "usability": 3,
    "accessibility": 5,
    "compatibility": 4,
    "security": 5,
    "performance": 5,
    "load": 5,
    "stress": 5,
    "spike": 5,
    "endurance": 5,
}
APPROVAL_NOTE = "Needs separate approval before any test runs; G4 does not authorise it."
SECTIONS = (
    "scope_in",
    "scope_out",
    "test_levels",
    "test_types",
    "techniques_by_feature",
    "risk_based_approach",
    "entry_criteria",
    "exit_criteria",
    "environments",
    "test_data_approach",
    "tools",
    "assumptions",
    "constraints",
    "limitations",
)
IMPACT = {"auth": 4, "account": 4, "commerce": 4, "form": 3, "search": 2, "content": 2, "navigation": 2, "other": 2}
IMPACT_REASON = {
    "auth": "Sign-in failures lock users out of their account",
    "account": "Account data and settings belong to individual users",
    "commerce": "Purchase and basket faults lose orders and revenue",
    "form": "The form submits data the business relies on",
    "search": "Users can't find content if search fails",
    "content": "Content and navigation faults are visible but recoverable",
    "navigation": "Content and navigation faults are visible but recoverable",
    "other": "Visible but limited effect on users",
}
MITIGATION: dict[str, dict[str, Any]] = {
    "auth": {"test_types": ["functional", "security"], "techniques": ["state_transition", "decision_table"]},
    "account": {"test_types": ["functional", "security"], "techniques": ["state_transition", "use_case"]},
    "commerce": {"test_types": ["functional", "regression"], "techniques": ["use_case", "decision_table"]},
    "form": {
        "test_types": ["functional", "usability"],
        "techniques": ["equivalence_partitioning", "boundary_value_analysis"],
    },
    "search": {"test_types": ["functional"], "techniques": ["equivalence_partitioning", "error_guessing"]},
    "content": {"test_types": ["functional", "smoke"], "techniques": ["use_case", "exploratory"]},
    "navigation": {"test_types": ["functional", "smoke"], "techniques": ["use_case", "exploratory"]},
    "other": {"test_types": ["functional", "exploratory"], "techniques": ["exploratory", "error_guessing"]},
}


@dataclass
class Req:
    id: uuid.UUID
    lineage_id: uuid.UUID
    key: str
    title: str
    category: str
    provenance: str
    rule_id: str | None
    feature_ids: list[str]
    evidence_refs: list[dict[str, Any]]


@dataclass
class Feature:
    id: uuid.UUID
    key: str
    name: str
    category: str
    evidence_refs: list[dict[str, Any]]
    page_ids: list[str]


@dataclass
class Page:
    id: uuid.UUID
    url: str
    console_issues: int
    network_issues: int
    evidence_id: uuid.UUID | None


@dataclass
class StrategyInput:
    start_url: str
    requirements: list[Req]
    features: list[Feature]
    journeys: list[dict[str, Any]]  # {key, name, evidence_refs}
    pages: list[Page]
    readiness: list[dict[str, Any]]  # {key, kind, text}
    access_gaps: list[dict[str, Any]] = field(default_factory=list)
    signed_in_observed: bool = False
    credentials: bool = False
    include_mobile: bool = True
    approval_policy: dict[str, str] = field(default_factory=dict)


@dataclass
class RiskDraft:
    match_key: str
    title: str
    description: str
    category: str
    likelihood: int
    impact: int
    factors: list[dict[str, Any]]
    likelihood_rationale: str
    impact_rationale: str
    mitigation: dict[str, Any]
    requirement_lineage_ids: list[str]
    feature_ids: list[str]
    evidence_refs: list[dict[str, Any]]
    provenance: str = "inferred"

    @property
    def score(self) -> int:
        return risk_score(self.likelihood, self.impact)

    @property
    def level(self) -> str:
        return risk_level(self.score).value

    @property
    def requires_approval(self) -> bool:
        return requires_approval(list(self.mitigation.get("test_types", [])))


def _item(
    text: str, rationale: str | None = None, refs: list[dict[str, Any]] | None = None, related: Any = None
) -> dict[str, Any]:
    return {
        "text": text,
        "rationale": rationale,
        "evidence_refs": refs or [],
        "related": related or [],
        "generated_by": "rules",
    }


def _ref(kind: str, id_: Any, key: str, label: str, path: str = "") -> dict[str, Any]:
    return {"type": kind, "id": str(id_) if id_ else None, "key": key, "label": label, "path": path}


def build_sections(inp: StrategyInput, risks: list[RiskDraft]) -> dict[str, Any]:
    feats = inp.features
    cats = {f.category for f in feats}
    has_forms = "form" in cats or any(r.category in ("form_input", "validation") for r in inp.requirements)
    has_auth = "auth" in cats or any(r.category == "authentication" for r in inp.requirements)
    scope_in = [
        _item(
            f"{f.name} ({f.key})",
            "Discovered in the application and covered by approved requirements",
            f.evidence_refs[:2],
            [_ref("feature", f.id, f.key, f.name)],
        )
        for f in feats
        if any(str(f.id) in r.feature_ids for r in inp.requirements)
    ] or [_item("The approved requirements", "Scope follows the approved requirement set")]
    scope_out = [
        _item("Component and component integration testing", "Out of scope: no source code access"),
        _item(
            "Back-end behaviour that can't be observed in the browser",
            "Server-side rules are tested only through what the UI shows",
        ),
        _item("Running security, performance or load tests", APPROVAL_NOTE),
    ]
    if has_auth and not inp.signed_in_observed:
        scope_out.append(
            _item("Pages behind sign-in", "Not observed: add test credentials (Settings) and run discovery again")
        )
    seen_out = {x["text"] for x in scope_out}
    for g in inp.access_gaps:
        url = g.get("url")
        text = f"Not reached: {url}" if url else str(g.get("description") or g.get("reason") or "Part of the site")
        if text in seen_out:
            continue  # several gaps with the same reason are one out-of-scope entry
        seen_out.add(text)
        scope_out.append(_item(text, str(g.get("suggestion") or g.get("reason") or "Discovery could not reach it")))
        if len(seen_out) >= 10:
            break
    levels = [
        {"level": "component", "in_scope": False, "rationale": "No source code access"},
        {"level": "component_integration", "in_scope": False, "rationale": "No source code access"},
        {"level": "system", "in_scope": True, "rationale": "The application is tested end to end through its UI"},
        {
            "level": "system_integration",
            "in_scope": False,
            "rationale": "Integrations are only visible through the UI; covered at system level",
        },
        {"level": "acceptance", "in_scope": True, "rationale": "Approved acceptance criteria define acceptance"},
    ]
    used = {t for r in risks for t in r.mitigation.get("test_types", [])}
    types = []
    for t, phase in TYPE_PHASE.items():
        in_scope = t in used or t in ("functional", "smoke", "regression", "exploratory")
        if t == "accessibility":
            in_scope = in_scope or any(r.category == "accessibility" for r in inp.requirements)
        if t == "compatibility":
            in_scope = inp.include_mobile
        rationale = {
            "functional": "Every approved requirement has acceptance criteria to verify",
            "smoke": "Quick confidence check of the main pages and journeys after each deployment",
            "sanity": "Covered by the smoke suite",
            "regression": "Re-run the functional suite when the application changes",
            "exploratory": "Finds problems the requirements don't describe",
            "usability": "Forms and journeys were observed; labels and messages matter to users",
            "accessibility": "Forms and navigation must be usable with assistive technology",
            "compatibility": "Discovery checked a mobile viewport"
            if inp.include_mobile
            else "Only desktop was checked",
            "security": "Sign-in and account pages handle credentials" if has_auth else "No sign-in observed",
            "performance": "Page load times were measured during discovery",
            "load": "No load expectations are known yet",
            "stress": "No load expectations are known yet",
            "spike": "No load expectations are known yet",
            "endurance": "No load expectations are known yet",
        }[t]
        types.append(
            {
                "type": t,
                "in_scope": in_scope,
                "rationale": rationale,
                "requires_approval": t in APPROVAL_TEST_TYPES,
                "available_from_phase": phase,
            }
        )
    techniques = []
    for f in feats:
        tech: list[dict[str, Any]] = []
        refs = f.evidence_refs[:2]
        if f.category == "form" or (f.category == "search"):
            tech += [
                {
                    "technique": "equivalence_partitioning",
                    "rationale": "Valid and invalid input classes per field",
                    "evidence_refs": refs,
                },
                {
                    "technique": "boundary_value_analysis",
                    "rationale": "Length and range limits seen on the fields",
                    "evidence_refs": refs,
                },
            ]
        if f.category in ("auth", "account"):
            tech += [
                {
                    "technique": "state_transition",
                    "rationale": "Signed-out, signed-in and locked states",
                    "evidence_refs": refs,
                },
                {
                    "technique": "decision_table",
                    "rationale": "Combinations of valid and invalid credentials",
                    "evidence_refs": refs,
                },
            ]
        if f.category in ("commerce", "navigation", "content"):
            tech.append(
                {"technique": "use_case", "rationale": "Follows the observed user journeys", "evidence_refs": refs}
            )
        tech += [
            {"technique": "error_guessing", "rationale": "Common faults for this kind of feature", "evidence_refs": []},
            {"technique": "exploratory", "rationale": "Time-boxed exploration around the feature", "evidence_refs": []},
        ]
        techniques.append({"feature": _ref("feature", f.id, f.key, f.name), "techniques": tech})
    approach = [
        {"level": "very_high", "depth": "All acceptance criteria, negative and boundary cases, exploratory session"},
        {"level": "high", "depth": "All acceptance criteria including negative cases"},
        {"level": "medium", "depth": "Positive acceptance criteria and key negative cases"},
        {"level": "low", "depth": "Smoke checks"},
    ]
    entry = [
        _item(
            c["text"],
            f"Definition of Ready {c['key']}",
            related=[_ref("readiness_criterion", c.get("id"), c["key"], c["text"])],
        )
        for c in inp.readiness
        if c["kind"] == "dor"
    ]
    entry = entry or [_item("Requirements are approved at Gate 3", "Testing starts from the approved requirements")]
    exit_ = [
        _item("100% of approved acceptance criteria have been executed", "Measurable: executed / approved"),
        _item("No open critical or high defects", "Measurable: count of open critical and high defects is 0"),
        _item("95% of executed tests pass", "Measurable: passed / executed ≥ 95%"),
        _item("Every high and very high risk has its mitigation tests executed", "Measurable: per risk"),
    ]
    viewports = ["1366x768"] + (["390x844"] if inp.include_mobile else [])
    environments = [
        {
            "name": "Target",
            "url": inp.start_url,
            "browsers": ["Chromium", "Firefox (planned)", "WebKit (planned)"],
            "viewports": viewports,
            "auth": "credentials" if inp.credentials else "none",
            "notes": None if inp.credentials or not has_auth else "No test credentials saved",
        },
    ]
    data = [
        _item("Synthetic, deterministic test data", "Repeatable runs; generated values, never real personal data"),
        _item("No real personal data", "Privacy"),
        _item("Credentials are used by reference only", "Values are stored encrypted and never shown in results"),
    ]
    if has_forms:
        data.append(_item("Boundary values derived from field limits", "From the acceptance criteria test values"))
    tools = [
        _item("Playwright with Chromium", "Browser automation used for discovery and later execution"),
        _item("axe-core", "Accessibility checks (Phase 5)"),
        _item("k6", "Performance checks after separate approval (Phase 5)"),
    ]
    assumptions = [
        _item("The target environment is stable during testing", "No deployment freeze is known"),
        _item("Requirements marked Assumed or Unverified are confirmed by the product owner", "Provenance labels"),
    ]
    constraints = [
        _item("Only the authorised URL and its allowed hosts are tested", "Gate 1 authorisation"),
        _item("No source code or database access", "Black-box testing only"),
    ]
    limitations = [_item("Back-end rules are inferred from the UI", "They can't be observed directly")]
    if inp.access_gaps:
        limitations.append(
            _item(f"Discovery reported {len(inp.access_gaps)} access gap(s)", "See the discovery report")
        )
    if has_auth and not inp.signed_in_observed:
        limitations.append(_item("The signed-in area was not observed", "No working test credentials"))
    return {
        "scope_in": scope_in,
        "scope_out": scope_out,
        "test_levels": levels,
        "test_types": types,
        "techniques_by_feature": techniques,
        "risk_based_approach": approach,
        "entry_criteria": entry,
        "exit_criteria": exit_,
        "environments": environments,
        "test_data_approach": data,
        "tools": tools,
        "assumptions": assumptions,
        "constraints": constraints,
        "limitations": limitations,
    }


def build_risks(inp: StrategyInput) -> list[RiskDraft]:
    pages = {str(p.id): p for p in inp.pages}
    out: list[RiskDraft] = []
    for f in inp.features:
        linked = [r for r in inp.requirements if str(f.id) in r.feature_ids]
        if not linked:
            continue
        impact = IMPACT.get(f.category, 2)
        if f.category == "commerce" and any(k in f.name.lower() for k in ("pay", "checkout", "card")):
            impact = 5
        factors: list[dict[str, Any]] = [
            {
                "factor": IMPACT_REASON.get(f.category, IMPACT_REASON["other"]),
                "affects": "impact",
                "delta": impact,
                "evidence_refs": f.evidence_refs[:1],
            },
        ]
        likelihood = 2
        weak = [r for r in linked if r.provenance in ("assumed", "unverified")]
        if weak:
            likelihood += 1
            factors.append(
                {
                    "factor": f"{len(weak)} related requirement(s) are Assumed or Unverified "
                    f"({', '.join(r.key for r in weak[:4])})",
                    "affects": "likelihood",
                    "delta": 1,
                    "evidence_refs": [],
                }
            )
        noisy = [pages[p] for p in f.page_ids if p in pages and (pages[p].console_issues or pages[p].network_issues)]
        if noisy:
            likelihood += 1
            factors.append(
                {
                    "factor": f"Console or network errors on {len(noisy)} related page(s)",
                    "affects": "likelihood",
                    "delta": 1,
                    "evidence_refs": [{"evidence_id": str(p.evidence_id)} for p in noisy[:2] if p.evidence_id],
                }
            )
        rule_ids = {r.rule_id for r in linked}
        if "form.optional_field" in rule_ids and "form.required_field" in rule_ids:
            likelihood += 1
            factors.append(
                {
                    "factor": "Inconsistent validation: optional fields next to required ones",
                    "affects": "likelihood",
                    "delta": 1,
                    "evidence_refs": f.evidence_refs[:1],
                }
            )
        if f.category in ("auth", "account") and not inp.signed_in_observed:
            likelihood += 1
            factors.append(
                {
                    "factor": "The signed-in area was not observed",
                    "affects": "likelihood",
                    "delta": 1,
                    "evidence_refs": [],
                }
            )
        if f.category == "auth" and inp.start_url.startswith("http:"):
            likelihood += 1
            factors.append(
                {
                    "factor": "Credentials are sent over http:",
                    "affects": "likelihood",
                    "delta": 1,
                    "evidence_refs": f.evidence_refs[:1],
                }
            )
        likelihood = min(likelihood, 5)
        mitigation = {**MITIGATION.get(f.category, MITIGATION["other"]), "notes": None}
        out.append(
            RiskDraft(
                match_key=f"feature:{f.key}|{f.category}",
                title=f"{f.name} doesn't work as specified",
                description=f"Faults in {f.name} ({f.key}) affect {len(linked)} approved requirement(s).",
                category="product",
                likelihood=likelihood,
                impact=impact,
                factors=factors,
                likelihood_rationale="; ".join(x["factor"] for x in factors if x["affects"] == "likelihood")
                or "Base likelihood: no aggravating factor found",
                impact_rationale=factors[0]["factor"],
                mitigation=mitigation,
                requirement_lineage_ids=[str(r.lineage_id) for r in linked],
                feature_ids=[str(f.id)],
                evidence_refs=f.evidence_refs[:2],
            )
        )
    a11y = [r for r in inp.requirements if r.category == "accessibility"]
    if a11y:
        out.append(
            RiskDraft(
                match_key="site|accessibility",
                title="Users of assistive technology can't complete key tasks",
                description="Forms and navigation may not be usable with a screen reader or keyboard.",
                category="product",
                likelihood=2 + (1 if any(r.provenance in ("assumed", "unverified") for r in a11y) else 0),
                impact=3,
                factors=[
                    {
                        "factor": "Accessibility affects every user of assistive technology",
                        "affects": "impact",
                        "delta": 3,
                        "evidence_refs": a11y[0].evidence_refs[:1],
                    }
                ],
                likelihood_rationale="Base likelihood",
                impact_rationale="Accessibility affects every user of assistive technology",
                mitigation={"test_types": ["accessibility", "usability"], "techniques": ["exploratory"], "notes": None},
                requirement_lineage_ids=[str(r.lineage_id) for r in a11y],
                feature_ids=[],
                evidence_refs=a11y[0].evidence_refs[:1],
            )
        )
    if inp.access_gaps or not inp.signed_in_observed:
        out.append(
            RiskDraft(
                match_key="project|coverage_gaps",
                title="Parts of the application can't be tested",
                description="Discovery could not reach every area, so tests may miss behaviour.",
                category="project",
                likelihood=3,
                impact=2,
                factors=[
                    {
                        "factor": f"{len(inp.access_gaps)} access gap(s) reported by discovery",
                        "affects": "likelihood",
                        "delta": 1,
                        "evidence_refs": [],
                    }
                ],
                likelihood_rationale="Access gaps or an unobserved signed-in area",
                impact_rationale="Untested areas reduce confidence in the release",
                mitigation={
                    "test_types": ["exploratory"],
                    "techniques": ["exploratory"],
                    "notes": "Add test credentials or widen the discovery scope",
                },
                requirement_lineage_ids=[],
                feature_ids=[],
                evidence_refs=[],
                provenance="assumed",
            )
        )
    return out
