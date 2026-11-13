"""Heuristic detector for prompt-injection-like text on discovered pages. Informational: isolation is the control."""

from __future__ import annotations

import re
from dataclasses import dataclass

_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|preceding)\s+(instructions|prompts?|rules)",
        r"disregard\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|your)\s+(instructions|prompts?|rules)",
        r"forget\s+(all\s+)?(your|previous|prior)\s+(instructions|rules)",
        r"(new|updated)\s+system\s+(prompt|instructions)",
        r"\bsystem\s+prompt\b",
        r"you\s+are\s+now\s+(an?\s+)?(ai|assistant|chatbot|language model|different)",
        r"\b(ai|llm)\s+(agents?|assistants?|models?)\s*[:,]\s*\w+",
        r"mark\s+(all\s+)?(the\s+)?tests?\s+(as\s+)?(passed|passing|successful)",
        r"(report|say)\s+that\s+(there\s+are\s+)?no\s+(bugs|defects|issues)",
        r"<\s*/?\s*(system|assistant|instructions?)\s*>",
    )
)


@dataclass(frozen=True)
class InjectionMatch:
    excerpt: str
    pattern: str


def detect_injection(text: str, *, max_matches: int = 5) -> list[InjectionMatch]:
    matches: list[InjectionMatch] = []
    for pat in _PATTERNS:
        for m in pat.finditer(text):
            start, end = max(0, m.start() - 60), min(len(text), m.end() + 60)
            excerpt = " ".join(text[start:end].split())[:300]
            if not any(excerpt == x.excerpt for x in matches):
                matches.append(InjectionMatch(excerpt=excerpt, pattern=pat.pattern))
            if len(matches) >= max_matches:
                return matches
    return matches
