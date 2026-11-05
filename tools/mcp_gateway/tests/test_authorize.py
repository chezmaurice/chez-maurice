"""The connector's consent page: nothing from the URL runs, and the code only
goes back to a known MCP client.

/authorize is served on the household's own origin, so a value pasted into
the page unescaped would run with the member's session; and registration is
open, so a client's own redirect_uris prove nothing — the code may only go to
Claude or to the member's own machine.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from tools.mcp_gateway import oauth  # noqa: E402

CLAUDE = "https://claude.ai/api/mcp/auth_callback"
XSS = '"><script>alert(1)</script>'


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("MAURICE_OAUTH_REDIRECT_HOSTS", raising=False)
    oauth.registered_clients.clear()
    app = Starlette(routes=[
        Route("/authorize", oauth.authorize_get, methods=["GET"]),
        Route("/authorize", oauth.authorize_post, methods=["POST"]),
        Route("/register", oauth.register_endpoint, methods=["POST"]),
    ])
    return TestClient(app, follow_redirects=False)


def register(client, *uris: str, name: str = "Claude") -> str:
    resp = client.post("/register", json={"redirect_uris": list(uris), "client_name": name})
    return resp.json()["client_id"]


def test_nothing_from_the_url_runs(client):
    cid = register(client, CLAUDE, name="<img src=x onerror=alert(1)>")
    resp = client.get("/authorize", params={
        "client_id": cid, "redirect_uri": CLAUDE, "state": XSS, "scope": XSS,
        "code_challenge": XSS, "code_challenge_method": "S256",
    })
    assert resp.status_code == 200
    assert "<script>alert(1)</script>" not in resp.text
    assert "<img src=x" not in resp.text
    assert "&lt;script&gt;" in resp.text
    assert "default-src 'none'" in resp.headers["content-security-policy"]


def test_an_unregistered_client_is_refused(client):
    resp = client.get("/authorize", params={"client_id": "nobody", "redirect_uri": CLAUDE, "state": XSS})
    assert resp.status_code == 400
    assert "<script>" not in resp.text


def test_a_registered_attacker_host_is_refused(client):
    evil = "https://evil.example/cb"
    cid = register(client, evil)
    assert client.get("/authorize", params={"client_id": cid, "redirect_uri": evil}).status_code == 400
    resp = client.post("/authorize", data={"client_id": cid, "redirect_uri": evil, "token": "maur_x"})
    assert resp.status_code == 400
    assert "location" not in resp.headers


def test_a_redirect_the_client_never_registered_is_refused(client):
    cid = register(client, CLAUDE)
    other = "https://claude.ai/somewhere-else"
    assert client.get("/authorize", params={"client_id": cid, "redirect_uri": other}).status_code == 400


def test_lookalike_and_plain_http_hosts_are_refused(client):
    for uri in ("https://evilclaude.ai/cb", "https://claude.ai.evil.com/cb", "http://claude.ai/cb", "javascript:alert(1)"):
        cid = register(client, uri)
        assert client.get("/authorize", params={"client_id": cid, "redirect_uri": uri}).status_code == 400, uri


def test_claude_and_the_members_own_machine_are_allowed(client, monkeypatch):
    for uri in (CLAUDE, "https://claude.com/api/mcp/auth_callback", "http://localhost:53682/callback", "http://127.0.0.1:9/cb"):
        cid = register(client, uri)
        assert client.get("/authorize", params={"client_id": cid, "redirect_uri": uri}).status_code == 200, uri
    monkeypatch.setenv("MAURICE_OAUTH_REDIRECT_HOSTS", "chatgpt.com")
    uri = "https://chatgpt.com/connector/oauth/cb"
    cid = register(client, uri)
    assert client.get("/authorize", params={"client_id": cid, "redirect_uri": uri}).status_code == 200


def test_the_code_goes_back_with_state_encoded(client, monkeypatch):
    class Resp:
        status_code = 200

        def json(self):
            return {"id": "member-1"}

    class Http:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, *a, **k):
            return Resp()

    monkeypatch.setattr(oauth.httpx, "AsyncClient", Http)
    cid = register(client, CLAUDE)
    resp = client.post("/authorize", data={
        "client_id": cid, "redirect_uri": CLAUDE, "state": "a&b=c", "token": "maur_x", "code_challenge": "x",
    })
    assert resp.status_code == 302
    location = resp.headers["location"]
    assert location.startswith(CLAUDE + "?code=")
    assert location.endswith("&state=a%26b%3Dc")
