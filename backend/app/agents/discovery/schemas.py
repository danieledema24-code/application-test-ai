"""Typed input/output of the Application Discovery Agent (architecture.md §3, agent A)."""

from __future__ import annotations

import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.domain.enums import FeatureCategory, GeneratedBy, Provenance


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EvidenceRefModel(Strict):
    evidence_id: uuid.UUID
    selector: str | None = None
    excerpt: str | None = Field(None, max_length=300)
    note: str | None = None


class DiscoveryLimits(Strict):
    max_pages: int = Field(30, ge=1, le=100)
    max_depth: int = Field(3, ge=0, le=5)
    include_mobile: bool = True
    respect_robots: bool = True
    page_timeout_s: int = 20
    total_timeout_s: int = 1200
    politeness_ms: int = 500
    mobile_sample: int = 10


class DiscoveryInput(Strict):
    scan_session_id: uuid.UUID
    start_url: str
    allowed_hosts: list[str]
    limits: DiscoveryLimits
    respect_robots: bool = True
    resume: bool = False


# ------------------------------------------------------------------ in-page extraction (from extract.js)


class FieldConstraints(BaseModel):
    min: str | None = None
    max: str | None = None
    maxlength: int | None = None
    minlength: int | None = None
    pattern: str | None = None
    step: str | None = None


class FormField(BaseModel):
    name: str = ""
    type: str = "text"
    label: str = ""
    required: bool = False
    placeholder: str | None = None
    constraints: FieldConstraints = FieldConstraints()
    options: list[str] | None = None
    autocomplete: str | None = None
    locator: str = ""


class ExtractedForm(BaseModel):
    name: str | None = None
    heading: str | None = None
    method: str = "GET"
    action: str = ""
    submit_label: str | None = None
    role: str | None = None
    fields: list[FormField] = []
    selector: str = ""
    locator: str = ""
    html: str = ""


ComponentKind = Literal[
    "button",
    "link",
    "dropdown",
    "search",
    "filter",
    "table",
    "modal",
    "tabs",
    "accordion",
    "menu",
    "pagination",
    "other",
]


class ExtractedComponent(BaseModel):
    kind: ComponentKind
    role: str | None = None
    name: str = ""
    locator: str = ""
    locators: list[str] = []
    selector: str = ""
    visible: bool = True
    details: dict[str, Any] = {}
    html: str = ""


class ExtractedLink(BaseModel):
    href: str
    text: str = ""
    rel: str = ""
    download: bool = False


class NavLink(BaseModel):
    text: str
    href: str


class Heading(BaseModel):
    level: int
    text: str


class PageExtract(BaseModel):
    title: str = ""
    lang: str | None = None
    meta_robots: str | None = None
    links: list[ExtractedLink] = []
    nav_links: list[NavLink] = []
    headings: list[Heading] = []
    forms: list[ExtractedForm] = []
    components: list[ExtractedComponent] = []
    has_password: bool = False
    text: str = ""
    hidden_text: str = ""
    captcha: bool = False
    counts: dict[str, int] = {}


class ResponsiveObs(BaseModel):
    width: int = 0
    nav_links_total: int = 0
    nav_links_visible: int = 0
    menu_button: bool = False
    horizontal_overflow: bool = False
    scroll_width: int = 0


# ------------------------------------------------------------------ analysis output


class FeatureCandidate(BaseModel):
    name: str
    description: str
    category: FeatureCategory
    page_ids: list[uuid.UUID]
    provenance: Provenance
    confidence: float = Field(ge=0, le=1)
    evidence_refs: list[EvidenceRefModel] = []
    generated_by: GeneratedBy
    reason: str | None = None


class JourneyStep(BaseModel):
    page_id: uuid.UUID
    action: str
    label: Literal["observed", "inferred"] = "observed"


class JourneyCandidate(BaseModel):
    name: str
    steps: list[JourneyStep]
    provenance: Provenance
    confidence: float = Field(ge=0, le=1)
    evidence_refs: list[EvidenceRefModel] = []
    generated_by: GeneratedBy
    reason: str | None = None


class Completeness(BaseModel):
    score: int
    rating: Literal["good", "partial", "limited"]
    reasons: list[str]
    checks: list[dict[str, str]] = []


class GateRecommendationModel(BaseModel):
    recommend: Literal["proceed", "proceed_with_caution", "do_not_proceed"]
    reasons: list[str]
    generated_by: Literal["ai", "rules"]


# ------------------------------------------------------------------ LLM structured output (validated, then domain-checked)


class LlmFeature(Strict):
    name: str = Field(min_length=2, max_length=120)
    description: str = Field(max_length=600)
    category: FeatureCategory
    page_ids: list[str] = Field(min_length=1, max_length=30)
    evidence_ids: list[str] = Field(default_factory=list, max_length=10)
    provenance: Literal["observed", "inferred"]
    confidence: float = Field(ge=0, le=1)


class LlmJourneyStep(Strict):
    page_id: str
    action: str = Field(max_length=200)


class LlmJourney(Strict):
    name: str = Field(min_length=2, max_length=120)
    steps: list[LlmJourneyStep] = Field(min_length=1, max_length=12)
    confidence: float = Field(ge=0, le=1)


class LlmDiscoveryAnalysis(Strict):
    summary: str = Field(max_length=2000)
    features: list[LlmFeature] = Field(max_length=40)
    journeys: list[LlmJourney] = Field(max_length=15)
    page_urls_mentioned: list[str] = Field(default_factory=list, max_length=50)
