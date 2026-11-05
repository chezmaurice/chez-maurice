#!/usr/bin/env python3
"""get_chapter_summary / get_chapter_text read only books the index knows.

    python tests/test_book_paths.py

Both tools take a path, because search_book_summaries hands one out; the path
comes back from the model or from an external MCP client. A path the index
has on record as a book summary — or the chapter that summary derives to —
is read. Anything else (another member's notes, the .env, /proc) is refused
before it is opened, even when it sits under a chapters/ folder.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parent
REPO = CORPUS.parents[1]
for p in (str(REPO), str(CORPUS)):
    if p not in sys.path:
        sys.path.insert(0, p)

from src.mcp_server import CorpusMCPServer  # noqa: E402

ROOT = Path(tempfile.mkdtemp(prefix="corpus-paths-"))
BOOK = ROOT / "artifacts" / "uuid-Le Rouge et le Noir"
SUMMARY = BOOK / "chapter_summaries" / "01.summary.txt"
CHAPTER = BOOK / "chapters" / "01.txt"
STRAY = ROOT / "gardens" / "alice" / "chapters" / "journal.txt"
ENV = ROOT / ".env"

for path, text in ((SUMMARY, "Julien arrive."), (CHAPTER, "Chapitre premier."), (STRAY, "privé"), (ENV, "KEY=sk")):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


class Indexer:
    """The shared pool holds the one book summary; the member's file nothing."""

    def count(self, *, where=None, member_id=None):
        known = {str(SUMMARY)} if member_id == "_default" else set()
        return int(where.get("source_type") == "book" and where.get("file_path") in known)


class Orchestrator:
    indexer = Indexer()


def server() -> CorpusMCPServer:
    s = object.__new__(CorpusMCPServer)
    s.orchestrator = Orchestrator()
    return s


def refused(fn) -> bool:
    try:
        fn()
    except PermissionError:
        return True
    return False


def test_a_known_summary_and_its_chapter_are_read():
    s = server()
    assert s._read_summary(str(SUMMARY))["summary"] == "Julien arrive."
    assert s._read_chapter_text({"chapter_path": str(CHAPTER)})["content"] == "Chapitre premier."
    assert s._read_chapter_text({"summary_path": str(SUMMARY)})["content"] == "Chapitre premier."


def test_any_other_path_is_refused():
    s = server()
    for raw in (str(ENV), "/etc/passwd", "/proc/self/environ", str(STRAY)):
        assert refused(lambda: s._read_summary(raw)), raw
        assert refused(lambda: s._read_chapter_text({"chapter_path": raw})), raw
        assert refused(lambda: s._read_chapter_text({"summary_path": raw})), raw


def test_traversal_out_of_a_known_book_is_refused():
    s = server()
    sneaky = str(BOOK / "chapters" / ".." / ".." / ".." / ".env")
    assert refused(lambda: s._read_chapter_text({"chapter_path": sneaky}))
    other = str(BOOK / "chapter_summaries" / "02.summary.txt")
    assert refused(lambda: s._read_summary(other))


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"ok   {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {t.__name__}: {exc!r}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
