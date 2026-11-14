"""Expected-value guard for AI-written scripts (P4-03b).

An AI rewrite of a rule script may change structure, never what the test checks: its assertion set must equal the
rule baseline's (`assertion_changed`). A script the AI writes for a case the rules couldn't translate has no
baseline, so each assertion must say which expected result it checks with a `// expects: step n` or
`// expects: overall` marker on the same line or the line above, naming a step that has an expected result
(`assertion_unmapped`).

Assertions are `qa.expect…(…)` helper calls and `expect(…)….toX(…)` matcher chains, compared with whitespace and
trailing commas removed and quotes normalised. This is a token-level scan with balanced brackets that skips strings
and comments, not a full TypeScript parse; spec-guard and tsc run on the same code first.

Pure code: no database, no model calls.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

_QA = re.compile(r"\bqa\s*\.\s*(expect[A-Za-z0-9_]*)\s*\(")
_EXPECT = re.compile(r"(?<![.\w])expect(?:\s*\.\s*(?:soft|poll))?\s*\(")
_MATCHER = re.compile(r"\s*\.\s*((?:not\s*\.\s*)?(?:to[A-Za-z0-9_]+|resolves|rejects))\s*")
_MARKER = re.compile(r"//\s*expects:\s*(step\s+(\d+)|overall)\b", re.I)


@dataclass(frozen=True)
class Assertion:
    text: str  # normalised call, e.g. qa.expectFieldFlagged("Message")
    line: int


def _strip_comments(code: str) -> str:
    """Blanks comments (keeping offsets and newlines) so markers and commented-out code are never read as calls."""
    out = list(code)
    i, n = 0, len(code)
    while i < n:
        ch = code[i]
        if ch in "\"'`":
            j = _skip_string(code, i)
            i = j
            continue
        if code.startswith("//", i):
            j = code.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        if code.startswith("/*", i):
            j = code.find("*/", i + 2)
            j = n if j < 0 else j + 2
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
            continue
        i += 1
    return "".join(out)


def _skip_string(code: str, i: int) -> int:
    quote, j, n = code[i], i + 1, len(code)
    while j < n:
        if code[j] == "\\":
            j += 2
            continue
        if code[j] == quote:
            return j + 1
        j += 1
    return n


def _balanced(code: str, open_at: int) -> int:
    """Index just past the bracket that closes the one at `open_at` (strings skipped)."""
    pairs = {"(": ")", "[": "]", "{": "}"}
    stack = [pairs[code[open_at]]]
    i, n = open_at + 1, len(code)
    while i < n and stack:
        ch = code[i]
        if ch in "\"'`":
            i = _skip_string(code, i)
            continue
        if ch in pairs:
            stack.append(pairs[ch])
        elif ch == stack[-1]:
            stack.pop()
        i += 1
    return i


def _norm(text: str) -> str:
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch in "\"'`":
            j = _skip_string(text, i)
            out.append('"' + text[i + 1 : j - 1].replace('"', '\\"') + '"')
            i = j
            continue
        if not ch.isspace():
            out.append(ch)
        i += 1
    s = "".join(out)
    return re.sub(r",([)\]}])", r"\1", s)


def assertions(code: str) -> list[Assertion]:
    clean = _strip_comments(code)
    found: list[tuple[int, int, str]] = []
    for m in _QA.finditer(clean):
        end = _balanced(clean, m.end() - 1)
        found.append((m.start(), end, _norm(clean[m.start() : end])))
    for m in _EXPECT.finditer(clean):
        if any(a <= m.start() < b for a, b, _t in found):
            continue
        end = _balanced(clean, m.end() - 1)
        while True:
            mm = _MATCHER.match(clean, end)
            if not mm:
                break
            end = mm.end()
            if end < len(clean) and clean[end] == "(":
                end = _balanced(clean, end)
        found.append((m.start(), end, _norm(clean[m.start() : end])))
    found.sort()
    return [Assertion(text, clean.count("\n", 0, start) + 1) for start, _end, text in found]


def assertion_set(code: str) -> Counter[str]:
    return Counter(a.text for a in assertions(code))


def changed(baseline: str, candidate: str) -> list[str]:
    """Assertions added or removed by the candidate (empty when it checks exactly what the baseline checks)."""
    a, b = assertion_set(baseline), assertion_set(candidate)
    return sorted([f"removed {t}" for t in (a - b).elements()] + [f"added {t}" for t in (b - a).elements()])


def unmapped(code: str, steps_with_expected: set[int], has_overall: bool) -> list[str]:
    """Messages for assertions without a valid `// expects:` marker (same line or the line above)."""
    lines = code.splitlines()
    out: list[str] = []
    found = assertions(code)
    if not found:
        return ["The script checks nothing: it has no assertion"]
    for a in found:
        marker = None
        for ln in (a.line, a.line - 1):
            if 1 <= ln <= len(lines) and (m := _MARKER.search(lines[ln - 1])):
                marker = m
                break
        if marker is None:
            out.append(f"Line {a.line}: the assertion has no '// expects: step n' marker")
        elif marker.group(2) is not None and int(marker.group(2)) not in steps_with_expected:
            out.append(f"Line {a.line}: step {marker.group(2)} has no expected result to check")
        elif marker.group(2) is None and not has_overall:
            out.append(f"Line {a.line}: the case has no overall expected result")
    return out
