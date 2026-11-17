"""Who wrote a book, for the chapters the corpus indexes from it.

A chapter file sits under `<artifacts>/<uuid>-<title>/chapters/`, so its path
gives the book's title — with the ISBN Calibre appends — and its uuid, and
nothing about its author. Every other document in the corpus answers to
`title` and `author`, and the search tool tells the model to filter on them;
book chunks carried `book_title` alone, so `{"author": "Seth"}` or
`{"title": "Being You"}` returned no passage at all. On 17 November 2026 a turn
asked for the exact passages of *Being You*, filtered three times on those
keys, got three empty lists and ran out of searches.

The author lives in the Calibre library's `metadata.db`, keyed by the same
uuid. The library is not under the artifacts: at home it is wherever the
member pointed it (`calibre_libraries` in maurice.db), on a hosted household
it is `<dataDir>/calibre/library`, beside them. Both are looked in.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .conversations import default_db_path

# "Being You : A New Science of Consciousness (9780571337736)" — the ISBN
# Calibre puts in a title is not part of it.
_ISBN_SUFFIX = re.compile(r"\s*\((?:97[89])?\d{9}[\dXx]\)\s*$")

# One map per metadata.db, rebuilt when the file changes.
_cache: Dict[str, Tuple[float, Dict[str, Tuple[str, str]]]] = {}


def clean_title(title: str) -> str:
    return _ISBN_SUFFIX.sub("", title or "").strip()


def _author_name(name: str) -> str:
    """Calibre stores a comma in an author's name as `|`: "Seth| Anil" is
    "Seth, Anil", which a reader writes "Anil Seth"."""
    name = (name or "").strip()
    if "|" in name:
        last, _, first = name.partition("|")
        return f"{first.strip()} {last.strip()}".strip()
    return name


def _library_roots(artifacts_root: Optional[Path]) -> List[Path]:
    roots: List[Path] = []
    db = default_db_path()
    if db.exists():
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            try:
                rows = con.execute("SELECT DISTINCT library_root FROM calibre_libraries").fetchall()
            finally:
                con.close()
            roots.extend(Path(r[0]) for r in rows if r and r[0])
        except sqlite3.Error:
            pass
    if artifacts_root is not None:
        roots.append(artifacts_root.parent / "library")
    seen: set[str] = set()
    return [r for r in roots if not (str(r) in seen or seen.add(str(r)))]


def _books(metadata_db: Path) -> Dict[str, Tuple[str, str]]:
    """uuid → (title, authors) for one library, cached on the file's mtime."""
    try:
        mtime = metadata_db.stat().st_mtime
    except OSError:
        return {}
    key = str(metadata_db)
    hit = _cache.get(key)
    if hit and hit[0] == mtime:
        return hit[1]
    books: Dict[str, Tuple[str, str]] = {}
    try:
        con = sqlite3.connect(f"file:{metadata_db}?mode=ro", uri=True)
        try:
            rows = con.execute(
                "SELECT b.uuid, b.title, a.name FROM books b "
                "LEFT JOIN books_authors_link l ON l.book = b.id "
                "LEFT JOIN authors a ON a.id = l.author "
                "ORDER BY b.id, l.id"
            ).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return {}
    authors: Dict[str, List[str]] = {}
    titles: Dict[str, str] = {}
    for uuid, title, author in rows:
        if not uuid:
            continue
        titles[uuid] = title or ""
        if author:
            authors.setdefault(uuid, []).append(_author_name(author))
    for uuid, title in titles.items():
        books[uuid] = (title, " & ".join(authors.get(uuid, [])))
    _cache[key] = (mtime, books)
    return books


def book_identity(book_uuid: str, book_title: str = "", artifacts_root: Optional[Path] = None) -> Dict[str, str]:
    """`title` and, when the library knows the book, `author` — the keys a
    search filters on. The title falls back to the one in the path."""
    out: Dict[str, str] = {}
    for root in _library_roots(artifacts_root):
        found = _books(root / "metadata.db").get(book_uuid)
        if found:
            title, author = found
            out["title"] = clean_title(title)
            if author:
                out["author"] = author
            break
    if not out.get("title") and book_title:
        out["title"] = clean_title(book_title)
    return out


__all__ = ["book_identity", "clean_title"]
