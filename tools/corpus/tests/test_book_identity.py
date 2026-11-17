#!/usr/bin/env python3
"""A book's chapters answer to `title` and `author`.

    python tests/test_book_identity.py

The chapter path gives the title with its ISBN and the uuid; the author comes
from the Calibre library's metadata.db — the one maurice.db points at, or the
one beside the artifacts — with Calibre's "Last| First" read as "First Last".
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parent
REPO = CORPUS.parents[1]
for p in (str(REPO), str(CORPUS)):
    if p not in sys.path:
        sys.path.insert(0, p)

ROOT = Path(tempfile.mkdtemp(prefix="corpus-identity-"))
os.environ["MAURICE_DATA_DIR"] = str(ROOT / "data")
(ROOT / "data").mkdir()

from src.calibre_meta import book_identity, clean_title  # noqa: E402

UUID = "b77cc664-f948-48f2-81e1-fe958832c864"
TWO = "11111111-2222-3333-4444-555555555555"


def library(root: Path) -> None:
    root.mkdir(parents=True)
    con = sqlite3.connect(root / "metadata.db")
    con.executescript(
        """
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, uuid TEXT);
        CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
        """
    )
    con.execute("INSERT INTO books VALUES (1, 'Being You : A New Science of Consciousness (9780571337736)', ?)", (UUID,))
    con.execute("INSERT INTO books VALUES (2, 'Irreducible Mind', ?)", (TWO,))
    con.executemany("INSERT INTO authors VALUES (?, ?)", [(1, "Seth| Anil"), (2, "Edward F. Kelly"), (3, "Emily Williams Kelly")])
    con.executemany("INSERT INTO books_authors_link VALUES (?, ?, ?)", [(1, 1, 1), (2, 2, 2), (3, 2, 3)])
    con.commit()
    con.close()


assert clean_title("Being You : A New Science of Consciousness (9780571337736)") == "Being You : A New Science of Consciousness"
assert clean_title("Nineteen Eighty-Four (1984)") == "Nineteen Eighty-Four (1984)", "a year is not an ISBN"

# A hosted household: the library sits beside the artifacts.
artifacts = ROOT / "calibre" / "artifacts"
artifacts.mkdir(parents=True)
library(ROOT / "calibre" / "library")

got = book_identity(UUID, "Being You : A New Science of Consciousness (9780571337736)", artifacts)
assert got == {"title": "Being You : A New Science of Consciousness", "author": "Anil Seth"}, got

got = book_identity(TWO, "Irreducible Mind", artifacts)
assert got["author"] == "Edward F. Kelly & Emily Williams Kelly", got

# A book the library does not know keeps the path's title, without an author.
got = book_identity("ffffffff-0000-0000-0000-000000000000", "Le Rouge et le Noir (9782070360024)", artifacts)
assert got == {"title": "Le Rouge et le Noir"}, got

# At home: the library is wherever maurice.db says, not beside the artifacts.
elsewhere = ROOT / "media" / "Livres"
library(elsewhere)
con = sqlite3.connect(ROOT / "data" / "maurice.db")
con.execute("CREATE TABLE calibre_libraries (id TEXT, account_id TEXT, name TEXT, library_root TEXT, is_default INTEGER, created_at TEXT)")
con.execute("INSERT INTO calibre_libraries VALUES ('l', 'm', 'Library', ?, 1, '')", (str(elsewhere),))
con.commit()
con.close()
got = book_identity(UUID, "", ROOT / "nowhere" / "artifacts")
assert got["author"] == "Anil Seth", got

print("ok")
