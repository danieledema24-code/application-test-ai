"""Possible side effects of running a case, from its step model (P4-05, decision D12).

What a test **may** do on the target, not what it expects to happen: pressing the submit control of a form counts
as a submission even when the case expects the submission to be blocked, because an application defect would let
it through (exactly the demo's empty-Message bug). Only external transactions and destructive actions need a
separate approval; submissions, sign-in and data creation are listed in the G7 summary and covered by G7.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.domain.automation.steps import SiteModel

SUBMITS_FORM = "submits_form"
SIGNS_IN = "signs_in"
CREATES_DATA = "creates_data"
EXTERNAL_TRANSACTION = "external_transaction"
DESTRUCTIVE = "destructive"
NEEDS_APPROVAL = (EXTERNAL_TRANSACTION, DESTRUCTIVE)
APPROVAL_TITLES = {
    EXTERNAL_TRANSACTION: "External transaction (payment or purchase)",
    DESTRUCTIVE: "Destructive action (delete, cancel or close something)",
}
# Pressed controls and step actions only; never expected results ("Deleted items are shown" is not an action).
DESTRUCTIVE_WORDS = re.compile(
    r"\b(delete|remove|cancel (?:my |the |an? )?(?:order|subscription|booking|account)|close (?:my |the )?account|"
    r"unsubscribe|deactivate|erase|destroy)\b",
    re.I,
)
TRANSACTION_WORDS = re.compile(
    r"\b(pay|pay now|place (?:the |my )?order|buy now|purchase|confirm order|complete (?:the )?purchase)\b", re.I
)


@dataclass
class Effect:
    kind: str
    step: int | None = None
    form: str | None = None  # form anchor
    form_name: str | None = None
    quote: str | None = None  # the step text that caused it ("Press Delete account")
    blocked_expected: bool = False  # the case expects the submission to be blocked ("may submit")


@dataclass
class CaseEffects:
    effects: list[Effect] = field(default_factory=list)

    @property
    def kinds(self) -> list[str]:
        return sorted({e.kind for e in self.effects})

    @property
    def needs_approval(self) -> list[str]:
        return [k for k in NEEDS_APPROVAL if k in self.kinds]

    def as_list(self) -> list[dict[str, Any]]:
        return [
            {k: v for k, v in e.__dict__.items() if v not in (None, False)} | {"kind": e.kind} for e in self.effects
        ]


def is_destructive(text: str) -> bool:
    return bool(DESTRUCTIVE_WORDS.search(text or ""))


def effects_of(model: dict[str, Any], site: SiteModel) -> CaseEffects:
    out = CaseEffects()

    def add(e: Effect) -> None:
        if not any(x.kind == e.kind and x.form == e.form for x in out.effects):
            out.effects.append(e)

    blocked = {
        a.get("form")
        for st in model.get("steps", [])
        for a in st.get("assertions", [])
        if a.get("kind") == "submission_blocked"
    } | {a.get("form") for a in model.get("overall", []) if a.get("kind") == "submission_blocked"}
    for st in model.get("steps", []):
        n = st.get("n")
        text = str(st.get("text") or "")
        for a in st.get("actions", []):
            kind = a.get("kind")
            if kind == "sign_in":
                add(Effect(SIGNS_IN, n, quote=text))
                continue
            if kind not in ("press", "press_twice"):
                continue
            control = a.get("control") or {}
            name = str(control.get("name") or "")
            if is_destructive(name) or is_destructive(text):
                add(Effect(DESTRUCTIVE, n, quote=text))
            if control.get("type") != "submit":
                if TRANSACTION_WORDS.search(name):
                    add(Effect(EXTERNAL_TRANSACTION, n, quote=text))
                continue
            form = site.form(control.get("form"))
            if form is None or form.purpose in ("search", "filter"):
                continue
            if form.purpose == "login":
                add(Effect(SIGNS_IN, n, form.anchor, form.name, text))
                continue
            add(Effect(SUBMITS_FORM, n, form.anchor, form.name, text, blocked_expected=form.anchor in blocked))
            if form.purpose == "registration":
                add(Effect(CREATES_DATA, n, form.anchor, form.name, text))
            if form.purpose == "checkout" or form.card_like or TRANSACTION_WORDS.search(form.submit_label):
                add(Effect(EXTERNAL_TRANSACTION, n, form.anchor, form.name, text))
    return out


def summary_lines(per_case: dict[str, CaseEffects], form_names: dict[str, str]) -> list[dict[str, Any]]:
    """G7 summary lines (design P4 §7.2), grouped by form, with the case keys behind each line."""
    groups: dict[tuple[str, str], list[str]] = {}
    for key, ce in per_case.items():
        for e in ce.effects:
            if e.kind == SUBMITS_FORM:
                sub = "may_submit" if e.blocked_expected else "submits"
                groups.setdefault((sub, e.form or ""), []).append(key)
            elif e.kind in (SIGNS_IN, CREATES_DATA):
                groups.setdefault((e.kind, (e.form or "") if e.kind == CREATES_DATA else ""), []).append(key)
    order = {"may_submit": 0, "submits": 1, SIGNS_IN: 2, CREATES_DATA: 3}
    lines: list[dict[str, Any]] = []
    for (sub, anchor), keys in sorted(groups.items(), key=lambda kv: (order[kv[0][0]], kv[0][1])):
        keys = sorted(set(keys))
        name = form_names.get(anchor, "")
        if sub == "may_submit":
            text = f"May submit the {name} form (if the application does not block it)"
        elif sub == "submits":
            text = f"Submits the {name} form"
        elif sub == SIGNS_IN:
            text = "Signs in with the saved test account"
        else:
            text = f"Creates data on the site: {name} form ({len(keys)} test{'s' if len(keys) != 1 else ''})"
        lines.append({"kind": sub, "form": anchor or None, "text": text, "count": len(keys), "case_keys": keys})
    return lines
