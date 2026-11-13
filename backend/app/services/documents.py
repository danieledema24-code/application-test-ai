"""Source documents (P2-08): type detection by magic bytes, bounded text extraction (PDF via pypdf, DOCX via
stdlib zipfile + XML, Markdown/text directly), section anchors and requirement-like statements.

Document text is data, never instructions: it reaches prompts only inside untrusted blocks, and injection
patterns are flagged on the document.
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass, field
from typing import Any
from xml.etree import ElementTree

from app.llm.injection import detect_injection

PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MARKDOWN = "text/markdown"
TEXT = "text/plain"
MAX_PAGES = 200
MAX_CHARS = 500_000
MAX_DOCX_UNCOMPRESSED = 20 * 1024 * 1024
NO_TEXT = "No extractable text (scanned documents need OCR, not supported yet)"
TOO_LARGE = "Document too large after decompression"
MISMATCH = "File content does not match a supported type"

STATEMENT = re.compile(
    r"\b(must|shall|should|will be able to|is required to|are required to)\b|^\s*as an? .{2,80}?,? i want\b",
    re.IGNORECASE,
)
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class DocumentError(Exception):
    pass


def sniff(data: bytes, filename: str) -> str:
    """Detects the type from content. Markdown vs plain text is decided by extension only for valid UTF-8 text."""
    if data.startswith(b"%PDF-"):
        return PDF
    if data.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                if "word/document.xml" in z.namelist():
                    return DOCX
        except zipfile.BadZipFile as exc:
            raise DocumentError(MISMATCH) from exc
        raise DocumentError(MISMATCH)
    head = data[:4096]
    if b"\x00" in head:
        raise DocumentError(MISMATCH)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise DocumentError(MISMATCH) from exc
    if re.match(r"\s*<(!doctype|html|\?xml|svg)", text[:200], re.IGNORECASE):
        raise DocumentError(MISMATCH)  # HTML/XML pretending to be a document
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext in ("pdf", "docx"):
        raise DocumentError(MISMATCH)
    return MARKDOWN if ext in ("md", "markdown") or re.search(r"^#{1,6} ", text, re.MULTILINE) else TEXT


@dataclass
class Section:
    anchor: str
    heading: str
    page: int | None
    start: int


@dataclass
class Extracted:
    text: str
    pages: int | None
    outline: list[Section] = field(default_factory=list)
    statements: list[dict[str, Any]] = field(default_factory=list)
    injection: list[dict[str, Any]] = field(default_factory=list)


def _pdf(data: bytes) -> tuple[list[tuple[int, str]], int]:
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(data))
        n = len(reader.pages)
        out: list[tuple[int, str]] = []
        total = 0
        for i, page in enumerate(reader.pages[:MAX_PAGES]):
            t = page.extract_text() or ""
            out.append((i + 1, t))
            total += len(t)
            if total > MAX_CHARS:
                break
        return out, n
    except Exception as exc:
        raise DocumentError("The PDF could not be read") from exc


def _docx(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if sum(i.file_size for i in z.infolist()) > MAX_DOCX_UNCOMPRESSED:
            raise DocumentError(TOO_LARGE)
        info = z.getinfo("word/document.xml")
        if info.file_size > MAX_DOCX_UNCOMPRESSED:
            raise DocumentError(TOO_LARGE)
        with z.open(info) as fh:
            raw = fh.read(MAX_DOCX_UNCOMPRESSED + 1)
        if len(raw) > MAX_DOCX_UNCOMPRESSED:
            raise DocumentError(TOO_LARGE)
    try:
        root = ElementTree.fromstring(raw)  # noqa: S314 - stdlib parser; entity expansion is not supported for DTD-less XML
    except ElementTree.ParseError as exc:
        raise DocumentError("The DOCX could not be read") from exc
    lines: list[str] = []
    for p in root.iter(f"{_W}p"):
        style = p.find(f"{_W}pPr/{_W}pStyle")
        text = "".join(t.text or "" for t in p.iter(f"{_W}t")).strip()
        if not text:
            continue
        sval = style.get(f"{_W}val", "") if style is not None else ""
        m = re.match(r"Heading(\d)", sval)
        lines.append(f"{'#' * int(m.group(1))} {text}" if m else text)
    return "\n\n".join(lines)


def extract(data: bytes, mime: str) -> Extracted:
    pages: int | None = None
    if mime == PDF:
        parts, pages = _pdf(data)
        text = ""
        outline: list[Section] = []
        for num, t in parts:
            outline.append(Section(f"p{num}", f"Page {num}", num, len(text)))
            text += t.strip() + "\n\n"
    else:
        text = _docx(data) if mime == DOCX else data.decode("utf-8", errors="replace")
        outline = []
    text = text[:MAX_CHARS]
    if not text.strip() or len(re.sub(r"\s", "", text)) < 20:
        raise DocumentError(NO_TEXT)
    if mime != PDF:
        path: list[str] = []
        counters: list[int] = []
        for m in re.finditer(r"^(#{1,6})\s+(.+)$", text, re.MULTILINE):
            level = len(m.group(1))
            path = [*path[: level - 1], m.group(2).strip()]
            counters = counters[:level] + [0] * max(0, level - len(counters))
            counters[level - 1] += 1
            outline.append(Section("§" + ".".join(str(c) for c in counters), " > ".join(path), None, m.start()))
    out = Extracted(text=text, pages=pages, outline=outline)
    out.statements = statements(text, outline)
    out.injection = [
        {"anchor": _section_at(outline, text.find(x.excerpt[:40])).anchor if outline else "", "excerpt": x.excerpt}
        for x in detect_injection(text)
    ]
    return out


def _section_at(outline: list[Section], offset: int) -> Section:
    best = Section("", "", None, 0)
    for s in outline:
        if s.start <= max(offset, 0):
            best = s
    return best


def statements(text: str, outline: list[Section]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in re.finditer(r"[^\n.!?]+[.!?]?", text):
        sentence = " ".join(m.group(0).split())
        if len(sentence) < 15 or sentence.startswith("#") or not STATEMENT.search(sentence):
            continue
        if detect_injection(sentence):
            continue  # instructions aimed at AI agents are flagged, never turned into requirements
        sec = _section_at(outline, m.start())
        out.append(
            {
                "text": sentence[:300],
                "anchor": sec.anchor,
                "heading": sec.heading,
                "page": sec.page,
                "offset": m.start(),
            }
        )
        if len(out) >= 100:
            break
    return out
