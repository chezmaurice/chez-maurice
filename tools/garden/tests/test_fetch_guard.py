"""The garden tool fetches only the open web.

URLs reach it from pages, mails and the model (an article's og:image, a
cover), and what it downloads lands where it can be read back. So a file://
URL, or a name that leads to the machine itself, is refused before anything
is read — the check is on the connected socket, so a redirect or a DNS name
pointing home is caught too.
"""

from __future__ import annotations

import http.server
import os
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
os.environ.setdefault("MAURICE_GARDENS_DIR", tempfile.mkdtemp(prefix="garden-fetch-test-"))

from tools.garden import server as g  # noqa: E402


@pytest.fixture(autouse=True)
def no_relay(monkeypatch):
    monkeypatch.delenv("MAURICE_METADATA_RELAY_URL", raising=False)
    monkeypatch.delenv("MAURICE_METADATA_RELAY_TOKEN", raising=False)


@pytest.fixture
def local_server():
    """A server on loopback that would hand out a secret if asked."""

    class Handler(http.server.BaseHTTPRequestHandler):
        hits = 0

        def do_GET(self):  # noqa: N802
            Handler.hits += 1
            if self.path == "/hop":
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/secret")
                self.end_headers()
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"OPENAI_API_KEY=sk-secret")

        def log_message(self, *args):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv, Handler
    srv.shutdown()


def test_file_urls_are_refused(tmp_path):
    secret = tmp_path / ".env"
    secret.write_text("OPENAI_API_KEY=sk-secret")
    with pytest.raises(PermissionError):
        g._urlopen(f"file://{secret}")
    with pytest.raises(PermissionError):
        g._urlopen(urllib.request.Request(f"file://{secret}"))


def test_loopback_is_refused(local_server):
    srv, handler = local_server
    # urllib wraps the refusal in a URLError, which callers already handle.
    for path in ("/secret", "/hop"):
        for host in ("127.0.0.1", "localhost"):
            with pytest.raises(OSError, match="private address"):
                g._urlopen(f"http://{host}:{srv.server_port}{path}", timeout=5)
    # Refused at connect, before the request went out.
    assert handler.hits == 0


def test_metadata_address_is_refused():
    with pytest.raises((PermissionError, OSError)):
        g._urlopen("http://169.254.169.254/latest/meta-data/", timeout=2)


def test_download_image_cannot_copy_a_local_file(tmp_path):
    secret = tmp_path / ".env"
    secret.write_text("OPENAI_API_KEY=sk-secret")
    dest = tmp_path / "cover.jpg"
    try:
        g._download_image(f"file://{secret}", dest)
    except Exception:  # noqa: BLE001 — refusing is the point
        pass
    assert not dest.exists() or b"sk-secret" not in dest.read_bytes()


def test_the_relay_may_be_private(monkeypatch, local_server):
    srv, _ = local_server
    monkeypatch.setenv("MAURICE_METADATA_RELAY_URL", f"http://127.0.0.1:{srv.server_port}")
    monkeypatch.setenv("MAURICE_METADATA_RELAY_TOKEN", "t")
    with g._urlopen(f"http://127.0.0.1:{srv.server_port}/v1/tmdb/x", timeout=5) as resp:
        assert resp.status == 200
