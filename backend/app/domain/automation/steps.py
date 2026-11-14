"""Step model and automation suitability (P4-02).

Each approved case's steps and expected results are parsed into typed actions and assertions, using the Phase 3
generator's closed vocabulary (`domain/testdesign/generate.py`) plus common human phrasings. Fields and controls
resolve through the steps' test data (`form_ref`) and the discovered form model; a step naming a field that isn't in
the discovered form is unresolved. Anything that can't be parsed or resolved makes the case `manual_only`, with the
step quoted in the reason, so "what can be automated" and "what the emitter writes" never drift apart: the emitter
(P4-03a) consumes exactly this model.

Pure code: no database, no browser. Values in the model are test data references, never secrets.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

SUITABLE = "suitable"
PARTIAL = "partial"
MANUAL_ONLY = "manual_only"
SUITABLE_REASON = "Every step and expected result can be scripted"
NEEDS_CREDENTIALS = "Needs saved test credentials (Project settings)"

ACTION_KINDS = frozenset(
    {"open", "fill", "leave_empty", "paste", "press", "press_twice", "back", "reload", "set_viewport", "sign_in",
     "open_console", "inspect"}
)  # fmt: skip
ASSERTION_KINDS = frozenset(
    {"form_shown", "submission_blocked", "field_flagged", "submission_accepted", "signed_in", "not_signed_in",
     "error_shown", "text_visible", "url_is", "no_console_errors", "no_horizontal_overflow",
     "every_field_labelled", "still_signed_in", "field_length", "control_enabled"}
)  # fmt: skip


# ------------------------------------------------------------------ inputs


@dataclass(frozen=True)
class FieldInfo:
    key: str
    label: str
    name: str = ""
    type: str = "text"
    required: bool = False
    locator: str = ""  # discovery's first locator candidate, e.g. getByRole("textbox", { name: "Name" })

    @property
    def is_password(self) -> bool:
        return self.type == "password"


@dataclass(frozen=True)
class FormInfo:
    anchor: str
    name: str  # display name, e.g. "Contact us" (the form's accessible name or nearest heading)
    purpose: str
    path: str
    submit_label: str
    fields: tuple[FieldInfo, ...] = ()
    locator: str = ""  # discovery's locator for the <form> (getByRole("form", …) only when it has a name)
    requires_auth: bool = False
    alias: str = ""  # the test design's short name ("contact", "sign-in"), as in "The contact form is shown"

    def field(self, label: str) -> FieldInfo | None:
        want = _norm(label)
        return next((f for f in self.fields if _norm(f.label) == want), None) or next(
            (f for f in self.fields if f.name and _norm(f.name) == want), None
        )

    def field_by_key(self, key: str) -> FieldInfo | None:
        return next((f for f in self.fields if f.key == key), None)

    @property
    def card_like(self) -> bool:
        return any(CARD_FIELD.search(f"{f.label} {f.name}") for f in self.fields)


@dataclass(frozen=True)
class PageInfo:
    path: str
    title: str = ""
    requires_auth: bool = False
    buttons: tuple[str, ...] = ()
    links: tuple[tuple[str, str], ...] = ()  # (text, path) of same-site links
    nav: tuple[tuple[str, str], ...] = ()  # (text, path) of primary navigation links


@dataclass(frozen=True)
class DataInfo:
    lineage_id: str
    key: str
    field_label: str
    field_key: str
    form_anchor: str
    kind: str  # valid / invalid / boundary / secret_ref
    value: str | None  # None for secret references
    secret: str | None = None  # "username" | "password" for secret references
    altered: bool = False
    display: str = ""


@dataclass(frozen=True)
class StepIn:
    n: int
    action: str
    data_refs: tuple[str, ...] = ()
    expected: str = ""


@dataclass(frozen=True)
class CaseIn:
    lineage_id: str
    key: str
    title: str
    version: int
    steps: tuple[StepIn, ...]
    expected_result: str
    open_question: bool = False
    suites: tuple[str, ...] = ()
    requirement_keys: tuple[str, ...] = ()


@dataclass
class SiteModel:
    forms: list[FormInfo]
    pages: dict[str, PageInfo]
    data: dict[str, DataInfo]
    credentials_saved: bool = False
    login_path: str | None = None
    captcha_login: bool = False
    mfa_login: bool = False

    def forms_on(self, path: str) -> list[FormInfo]:
        return [f for f in self.forms if f.path == path]

    def form(self, anchor: str | None) -> FormInfo | None:
        return next((f for f in self.forms if f.anchor == anchor), None) if anchor else None

    @property
    def login_form(self) -> FormInfo | None:
        return next((f for f in self.forms if f.purpose == "login"), None)

    def page_by_title(self, title: str) -> PageInfo | None:
        want = _norm(title)
        for p in self.pages.values():
            if _norm(p.title) == want or _norm(p.title.split(" · ")[0].split(" | ")[0]) == want:
                return p
        return None


# ------------------------------------------------------------------ output


@dataclass
class Assessment:
    suitability: str
    reasons: list[str]
    blockers: list[dict[str, Any]]
    model: dict[str, Any]


@dataclass
class _State:
    path: str | None = None
    form: FormInfo | None = None
    forms: list[str] = field(default_factory=list)
    pages: list[str] = field(default_factory=list)
    uses_credentials: bool = False
    signs_in: bool = False


# ------------------------------------------------------------------ helpers

CARD_FIELD = re.compile(r"\b(card ?number|cc-?number|cvc|cvv|security code|expiry|expiration)\b", re.I)
_PATH = re.compile(r"(/[\w\-./%~]*)")
_QUOTED = re.compile(r"[\"“']([^\"”']{1,200})[\"”']")
_PAREN = re.compile(r"\s*\([^()]*\)")


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().strip(".").lower())


def _clean(text: str) -> str:
    t = re.sub(r"^not decided:\s*", "", text.strip(), flags=re.I)
    return re.sub(r"\s+", " ", t).strip().rstrip(".").strip()


def _quote(text: str, limit: int = 120) -> str:
    t = re.sub(r"\s+", " ", text.strip())
    return t if len(t) <= limit else t[: limit - 1] + "…"


def _path_of(text: str) -> str | None:
    m = _PATH.search(text)
    if not m:
        return None
    p = m.group(1).rstrip(".,;)")
    return p or "/"


def _accepts(c: str, cl: str, state: Any) -> bool:
    """'The form is accepted', 'A confirmation message is shown' or '<field> is accepted'."""
    if re.match(r"^the form is accepted(?: without validation messages)?(?: with .+ left empty)?$", cl):
        return True
    if re.match(r"^(?:a|one) (?:confirmation|success) message is shown$|^a confirmation is shown$", cl):
        return True
    m = re.match(r"^(.+?) is accepted(?: without a validation message)?$", c, re.I)
    return m is not None and state.form is not None and state.form.field(m.group(1)) is not None


class _Problem(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ------------------------------------------------------------------ actions


def _field(state: _State, site: SiteModel, label: str, step: StepIn, data: DataInfo | None) -> FieldInfo:
    form = site.form(data.form_anchor) if data else None
    form = form or state.form
    candidates = [form] if form else []
    if state.path:
        candidates += [f for f in site.forms_on(state.path) if f is not form]
    label = re.sub(r"\s*\(.*\)$", "", label.strip()).strip()
    for f in candidates:
        if f is None:
            continue
        hit = f.field_by_key(data.field_key) if data and data.field_key else None
        hit = hit or f.field(label)
        if hit is not None:
            state.form = f
            if f.anchor not in state.forms:
                state.forms.append(f.anchor)
            return hit
    where = f" of the {form.name} form" if form else (f" on {state.path}" if state.path else "")
    raise _Problem(
        "unresolved_field", f"Step {step.n} '{_quote(step.action)}': {label} is not a discovered field{where}"
    )


def _data(step: StepIn, site: SiteModel) -> DataInfo | None:
    for ref in step.data_refs:
        d = site.data.get(str(ref))
        if d is not None:
            return d
    return None


def _open(state: _State, site: SiteModel, path: str) -> dict[str, Any]:
    path = path.split("?")[0].split("#")[0] or "/"
    state.path = path
    forms = site.forms_on(path)
    state.form = forms[0] if len(forms) == 1 else None
    if path not in state.pages:
        state.pages.append(path)
    return {"kind": "open", "path": path}


def _control(state: _State, site: SiteModel, name: str, step: StepIn) -> dict[str, Any]:
    name = name.strip().strip("'\"“”‘’").strip()
    if re.match(r"^(a|an|any|some|one of the) ", name, re.I):
        raise _Problem("judgement", f"Step {step.n} '{_quote(step.action)}' needs human judgement")
    forms = ([state.form] if state.form else []) + [f for f in site.forms_on(state.path or "") if f is not state.form]
    for f in forms:
        if f is not None and _norm(f.submit_label) == _norm(name):
            state.form = f
            if f.anchor not in state.forms:
                state.forms.append(f.anchor)
            return {"type": "submit", "form": f.anchor, "name": f.submit_label}
    page = site.pages.get(state.path or "")
    if page is not None:
        for b in page.buttons:
            if _norm(b) == _norm(name):
                return {"type": "button", "name": b, "page": page.path}
        for text, href in page.nav + page.links:
            if _norm(text) == _norm(name):
                return {"type": "link", "name": text, "page": page.path, "href": href}
    where = f" on {state.path}" if state.path else ""
    raise _Problem("unresolved_control", f"Step {step.n} '{_quote(step.action)}': '{name}' was not found{where}")


def parse_action(step: StepIn, state: _State, site: SiteModel) -> list[dict[str, Any]]:
    """Typed actions of one step (raises _Problem when the step can't be scripted)."""
    text = _clean(step.action)
    low = text.lower()
    judgement = _Problem("judgement", f"Step {step.n} '{_quote(step.action)}' needs human judgement")
    if not text:
        return []
    if re.match(r"^open (/\S*) in a browser with the developer tools", low):
        raise judgement
    if low == "open the browser developer console":
        return [{"kind": "open_console"}]
    if low in ("the page loads", "wait for the page to load"):
        return []
    if re.match(r"^check each field with an accessibility checker", low):
        return [{"kind": "inspect"}]
    m = re.match(r"^set the browser viewport to (\d+)\s*[×x]\s*(\d+)$", low)
    if m:
        return [{"kind": "set_viewport", "width": int(m.group(1)), "height": int(m.group(2))}]
    if re.match(r"^(press|use) the browser back button$", low):
        return [{"kind": "back"}]
    if re.match(r"^(reload|refresh) the page$", low):
        return [{"kind": "reload"}]
    if (
        re.match(r"^(sign in|log in) with the saved test (account|credentials)$", low)
        or low == "start with a signed-in user"
    ):
        if site.login_path is None and site.login_form is None:
            raise _Problem(
                "unresolved_control", f"Step {step.n} '{_quote(step.action)}': no sign-in form was discovered"
            )
        state.uses_credentials = True
        state.signs_in = True
        return [{"kind": "sign_in"}]
    if re.match(r"^start with (a visitor|a user|a visitor who is not signed in|a signed-out visitor)$", low):
        return []
    m = re.match(r"^(?:open|go to|navigate to|visit) (/\S*)$", text, re.I)
    if m:
        return [_open(state, site, m.group(1))]
    if re.match(r"^open (any page|the home page|the start page)$", low):
        return [_open(state, site, "/")]
    m = re.match(r"^open the (.+?) page$", text, re.I)
    if m:
        if m.group(1).lower() in ("sign-in", "sign in", "login", "log-in") and (site.login_form or site.login_path):
            return [_open(state, site, site.login_form.path if site.login_form else str(site.login_path))]
        page = site.page_by_title(m.group(1))
        if page is None:
            raise _Problem(
                "unknown_page", f"Step {step.n} '{_quote(step.action)}': no discovered page is called {m.group(1)}"
            )
        return [_open(state, site, page.path)]
    m = re.match(r"^(?:open|start with) .+? (?:on|at) (/\S*)$", text, re.I)
    if m:
        return [_open(state, site, m.group(1))]
    m = re.match(r"^open .*?(/[\w\-./%~]+)$", text, re.I)
    if m and not re.search(r"\bin a browser\b", text, re.I):
        return [_open(state, site, m.group(1))]
    m = re.match(r"^(enter|type) (.+) in(?:to)? (?:the )?(.+?)(?: field)?$", text, re.I)
    if m:
        data = _data(step, site)
        fl = _field(state, site, m.group(3), step, data)
        return [{"kind": "fill", **_fill_target(state, fl), "value": _value_ref(m.group(2), data, step)}]
    m = re.match(r"^paste (.+) into (?:the )?(.+?)(?: field)?$", text, re.I)
    if m:
        data = _data(step, site)
        fl = _field(state, site, m.group(2), step, data)
        return [{"kind": "paste", **_fill_target(state, fl), "value": _value_ref(m.group(1), data, step)}]
    m = re.match(r"^leave (?:the )?(.+?)(?: field)? empty(?: \(.*\))?$", text, re.I)
    if m:
        fl = _field(state, site, m.group(1), step, _data(step, site))
        return [{"kind": "leave_empty", **_fill_target(state, fl)}]
    m = re.match(r"^press (.+?) twice quickly$", text, re.I)
    if m:
        return [{"kind": "press_twice", "control": _control(state, site, m.group(1), step)}]
    m = re.match(r"^select [\"“'](.+?)[\"”'] in the primary navigation$", text, re.I)
    if m:
        return [{"kind": "press", "control": _nav_link(state, site, m.group(1), step)}]
    if low == "open an item from the list":
        example = re.search(r"for example (/\S+?)\)?$", step.expected.strip().rstrip("."), re.I)
        page = site.pages.get(state.path or "")
        if example and page is not None:
            want = example.group(1).rstrip(")")
            hit = next(((t, h) for t, h in page.links if h == want), None)
            if hit is not None:
                return [
                    {"kind": "press", "control": {"type": "link", "name": hit[0], "page": page.path, "href": hit[1]}}
                ]
        raise judgement
    m = re.match(r"^(?:press|click|select|choose) (?:the )?[\"“'‘]?(.+?)[\"”'’]?(?: button| link)?$", text, re.I)
    if m:
        return [{"kind": "press", "control": _control(state, site, m.group(1), step)}]
    raise judgement


def _nav_link(state: _State, site: SiteModel, name: str, step: StepIn) -> dict[str, Any]:
    page = site.pages.get(state.path or "") or next(iter(site.pages.values()), None)
    for p in [page, *site.pages.values()]:
        if p is None:
            continue
        for text, href in p.nav:
            if _norm(text) == _norm(name):
                return {"type": "nav_link", "name": text, "page": p.path, "href": href}
    raise _Problem(
        "unresolved_control", f"Step {step.n} '{_quote(step.action)}': '{name}' is not in the discovered navigation"
    )


def _fill_target(state: _State, fl: FieldInfo) -> dict[str, Any]:
    assert state.form is not None
    return {"form": state.form.anchor, "field": fl.key, "label": fl.label, "field_type": fl.type}


def _value_ref(raw: str, data: DataInfo | None, step: StepIn) -> dict[str, Any]:
    if data is not None:
        if data.kind == "secret_ref":
            return {
                "data": data.lineage_id,
                "key": data.key,
                "secret": data.secret or "password",
                "altered": data.altered,
            }
        return {"data": data.lineage_id, "key": data.key}
    m = _QUOTED.fullmatch(raw.strip())
    if m:
        return {"literal": m.group(1)}
    raise _Problem("judgement", f"Step {step.n} '{_quote(step.action)}' doesn't say which value to enter")


# ------------------------------------------------------------------ expected results

_IDENTIFIED = re.compile(
    r"^(.+?) is identified as (required|an invalid email address|an invalid web address|too long|too short|"
    r"out of range|not matching the required format|invalid|missing)$",
    re.I,
)


def _form_for(state: _State, site: SiteModel) -> FormInfo:
    if state.form is not None:
        return state.form
    forms = site.forms_on(state.path or "")
    if len(forms) == 1:
        state.form = forms[0]
        return forms[0]
    raise _Problem("unresolved_form", "no form")


def _clauses(text: str) -> list[str]:
    parts = re.split(r",\s*and\s+|\s+and\s+(?=(?:the|a|an|no|it|they|submission|sign-in|only)\b|[A-Z])", text)
    return [p.strip().strip(",").strip() for p in parts if p.strip()]


def parse_expected(text: str, state: _State, site: SiteModel, *, where: str) -> list[dict[str, Any]]:
    """Assertions for an expected result ("" → none). `where` names it in problems ("Step 5" / "The expected
    result")."""
    raw = _clean(text)
    if not raw:
        return []
    judgement = _Problem("judgement", f"{where} '{_quote(text)}' needs human judgement")
    # Paths in brackets are part of the meaning; other brackets are notes ("(assumed: …)").
    m = re.match(r"^the (.+?) page \((/\S*)\) opens$", raw, re.I) or re.match(
        r"^the .+? page opens \(for example (/\S+)\)$", raw, re.I
    )
    if m:
        path = m.group(m.lastindex or 1)
        state.path = path.rstrip(")")
        return [{"kind": "url_is", "path": path.rstrip(")")}]
    stripped = _PAREN.sub("", raw).strip()
    whole: list[tuple[str, Any]] = [
        (r"^each field (?:of the .+? form )?announces its label", lambda _m: [_every_label(state, site)]),
        (r"^(?:every checked page|the page|each page) fits the screen width without horizontal scrolling",
         lambda _m: [{"kind": "no_horizontal_overflow"}]),
        (r"^no errors are written to the browser console", lambda _m: [{"kind": "no_console_errors"}]),
        (r"^(.+?) keeps only the first (\d+) characters and no validation message is shown$",
         lambda m: [_length(state, site, m.group(1), int(m.group(2)), False, True, where, text),
                    _accepted(state, site)]),
        (r"^(.+?) holds all (\d+) characters and is accepted without a validation message$",
         lambda m: [_length(state, site, m.group(1), int(m.group(2)), False, True, where, text),
                    _accepted(state, site)]),
        (r"^(.+?) holds at most (\d+) characters$",
         lambda m: [_length(state, site, m.group(1), int(m.group(2)), True, False, where, text)]),
        (r"^(.+?) is accepted: browsers remove spaces around an email address$", lambda _m: [_accepted(state, site)]),
        (r"^an? ['\"“](.+?)['\"”] button is visible and enabled$",
         lambda m: [{"kind": "control_enabled", "name": m.group(1)}]),
        (r"^the user is signed in and sees the signed-in area$", lambda _m: [{"kind": "signed_in"}]),
        (r"^sign-in is blocked and both fields are identified as required$",
         lambda _m: [_blocked(state, site), *[_flag(state, site, f.label, where, text)
                                              for f in _form_for(state, site).fields if f.required]]),
    ]  # fmt: skip
    for pattern, build in whole:
        m = re.match(pattern, stripped, re.I)
        if m:
            try:
                return list(build(m))
            except _Problem as p:
                if p.code == "unresolved_form":
                    raise judgement from None
                raise
    out: list[dict[str, Any]] = []
    for clause in _clauses(stripped):
        c = clause.strip().rstrip(".")
        cl = c.lower()
        try:
            if re.match(r"^(submission|sign-in|the submission) is blocked$", cl):
                out.append(_blocked(state, site))
            elif (m := _IDENTIFIED.match(c)) is not None:
                out.append(_flag(state, site, m.group(1), where, text))
            elif _accepts(c, cl, state):
                out.append(_accepted(state, site))
            elif (m := re.match(r"^the (.+?) form is shown$", c, re.I)) is not None:
                out.append(_shown(state, site, m.group(1), where, text))
            elif re.match(r"^the sign-in page is shown$|^(?:they are|the user is) asked to sign in$", cl):
                login = site.login_form
                if login is None:
                    raise judgement
                out.append({"kind": "form_shown", "form": login.anchor})
            elif re.match(r"^an? (?:generic )?error(?: message)? is shown$", cl):
                out.append({"kind": "error_shown"})
            elif re.match(
                r"^(?:the user|they|the visitor) (?:is|are) not signed in$|^the (?:signed-in )?content is not shown$",
                cl,
            ):
                out.append({"kind": "not_signed_in"})
            elif re.match(r"^(?:the user|they) (?:is|are) still signed in$", cl):
                out.append({"kind": "still_signed_in"})
            elif re.match(
                r"^the signed-in (?:page|content|area) is shown$|^(?:the user|they) (?:is|are) signed in$", cl
            ):
                out.append({"kind": "signed_in"})
            elif (
                m := re.match(r"^(?:the page shows |the text )?[\"“'](.+?)[\"”'](?: is shown| is visible)?$", c, re.I)
            ) is not None:
                out.append({"kind": "text_visible", "text": m.group(1)})
            elif (
                m := re.match(r"^(?:the user is (?:taken|redirected) to|the address is) (/\S*)$", c, re.I)
            ) is not None:
                out.append({"kind": "url_is", "path": m.group(1)})
            else:
                raise judgement
        except _Problem as p:
            if p.code == "unresolved_form":
                raise judgement from None
            raise
    return _dedupe(out)


def _dedupe(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: list[dict[str, Any]] = []
    for i in items:
        if i not in seen:
            seen.append(i)
    return seen


def _blocked(state: _State, site: SiteModel) -> dict[str, Any]:
    return {"kind": "submission_blocked", "form": _form_for(state, site).anchor}


def _accepted(state: _State, site: SiteModel) -> dict[str, Any]:
    return {"kind": "submission_accepted", "form": _form_for(state, site).anchor}


def _every_label(state: _State, site: SiteModel) -> dict[str, Any]:
    return {"kind": "every_field_labelled", "form": _form_for(state, site).anchor}


def _flag(state: _State, site: SiteModel, label: str, where: str, text: str) -> dict[str, Any]:
    form = _form_for(state, site)
    fl = form.field(label)
    if fl is None:
        raise _Problem("unresolved_field", f"{where} '{_quote(text)}': {label} is not a field of the {form.name} form")
    return {"kind": "field_flagged", "form": form.anchor, "field": fl.key, "label": fl.label}


def _length(
    state: _State, site: SiteModel, label: str, n: int, at_most: bool, before_press: bool, where: str, text: str
) -> dict[str, Any]:
    form = _form_for(state, site)
    fl = form.field(label)
    if fl is None:
        raise _Problem("unresolved_field", f"{where} '{_quote(text)}': {label} is not a field of the {form.name} form")
    out: dict[str, Any] = {"kind": "field_length", "form": form.anchor, "field": fl.key, "label": fl.label, "n": n,
                           "at_most": at_most}  # fmt: skip
    if before_press:
        out["before_press"] = True
    return out


def _shown(state: _State, site: SiteModel, name: str, where: str, text: str) -> dict[str, Any]:
    want = _norm(name)
    forms = site.forms_on(state.path or "") or site.forms
    for f in forms:
        if (
            _norm(f.name) == want
            or _norm(f.alias) == want
            or _norm(f.purpose) == want
            or (want in ("sign-in", "sign in", "login") and f.purpose == "login")
        ):
            state.form = f
            return {"kind": "form_shown", "form": f.anchor}
    if state.form is not None and len(site.forms_on(state.path or "")) == 1:
        return {"kind": "form_shown", "form": state.form.anchor}
    raise _Problem("unresolved_form", f"{where} '{_quote(text)}': no {name} form was discovered")


# ------------------------------------------------------------------ assessment


_STALE_QUESTION = re.compile(r"\basks whether\b", re.I)


def assess(case: CaseIn, site: SiteModel) -> Assessment:
    """Step model plus suitability (`suitable` / `partial` / `manual_only`) with reasons a non-QA reader follows."""
    state = _State()
    problems: list[_Problem] = []
    steps_out: list[dict[str, Any]] = []
    for step in case.steps:
        expected = step.expected
        if not case.open_question and _STALE_QUESTION.search(expected or ""):
            # The open question was answered in the overall expected result; the step still quotes the question.
            expected = case.expected_result
        entry: dict[str, Any] = {
            "n": step.n,
            "text": step.action,
            "expected": expected,
            "actions": [],
            "assertions": [],
        }
        try:
            entry["actions"] = parse_action(step, state, site)
        except _Problem as p:
            problems.append(p)
            steps_out.append(entry)
            continue
        if expected.strip():
            try:
                entry["assertions"] = parse_expected(expected, state, site, where=f"Step {step.n}")
            except _Problem as p:
                problems.append(_reword(p, step, expected))
        steps_out.append(entry)
    overall: list[dict[str, Any]] = []
    if case.expected_result.strip() and not case.open_question:
        try:
            overall = parse_expected(case.expected_result, state, site, where="The expected result")
        except _Problem as p:
            # Usually the last step's expected result again: name the problem once, at the step.
            said = {_norm(_PAREN.sub("", st["expected"] or "")) for st in steps_out}
            if _norm(_PAREN.sub("", case.expected_result)) not in said:
                problems.append(p)
    signs_in = state.signs_in
    for st in steps_out:
        for a in st["actions"]:
            if a["kind"] in ("fill", "paste") and a["value"].get("secret"):
                state.uses_credentials = True
            if a["kind"] == "press" and a["control"].get("type") == "submit":
                f = site.form(a["control"].get("form"))
                if f is not None and f.purpose == "login":
                    signs_in = True
    # The overall expected result usually repeats the last step's; assert it only where it adds something.
    asserted = [a for st in steps_out for a in st["assertions"]]
    overall_extra = [a for a in overall if a not in asserted]
    model = {
        "steps": steps_out,
        "overall": overall,
        "overall_extra": overall_extra,
        "forms": list(state.forms),
        "pages": list(state.pages),
        "signs_in": signs_in,
        "uses_credentials": state.uses_credentials,
    }
    reasons: list[str] = []
    blockers: list[dict[str, Any]] = []
    if case.open_question:
        reasons.append("The expected result is an open question")
        blockers.append({"code": "open_question", "message": reasons[-1]})
    for prob in problems:
        reasons.append(prob.message)
        blockers.append({"code": prob.code, "message": prob.message})
    if not problems and not case.open_question and not asserted and not overall:
        reasons.append("No step has an expected result that can be checked in the browser")
        blockers.append({"code": "no_assertion", "message": reasons[-1]})
    login_used = (
        signs_in
        or state.uses_credentials
        or any((site.form(a) or FormInfo("", "", "", "", "")).purpose == "login" for a in state.forms)
    )
    if login_used and site.captcha_login:
        reasons.append("The sign-in form is protected by a CAPTCHA")
        blockers.append({"code": "captcha", "message": reasons[-1]})
    if login_used and site.mfa_login:
        reasons.append("Signing in needs a one-time code (multi-factor authentication)")
        blockers.append({"code": "mfa", "message": reasons[-1]})
    if blockers:
        return Assessment(MANUAL_ONLY, reasons, blockers, model)
    if state.uses_credentials and not site.credentials_saved:
        return Assessment(PARTIAL, [NEEDS_CREDENTIALS], [{"code": "credentials", "message": NEEDS_CREDENTIALS}], model)
    return Assessment(SUITABLE, [SUITABLE_REASON], [], model)


def _reword(p: _Problem, step: StepIn, expected: str) -> _Problem:
    if p.code == "judgement":
        return _Problem("judgement", f"Step {step.n}'s expected result '{_quote(expected)}' needs human judgement")
    return p


def with_credentials(a: Assessment, saved: bool) -> Assessment:
    """Re-derives partial ↔ suitable when credentials are saved or removed (no new G5, no re-parse)."""
    if a.suitability == MANUAL_ONLY or not a.model.get("uses_credentials"):
        return a
    if saved:
        return Assessment(SUITABLE, [SUITABLE_REASON], [], a.model)
    return Assessment(PARTIAL, [NEEDS_CREDENTIALS], [{"code": "credentials", "message": NEEDS_CREDENTIALS}], a.model)
