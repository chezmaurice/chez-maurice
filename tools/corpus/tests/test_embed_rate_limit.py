#!/usr/bin/env python3
"""An indexing batch waits out the provider's per-minute quota; a query does not.

    python tests/test_embed_rate_limit.py

Scaleway says when its window reopens in `x-ratelimit-reset-tokens`, which the
OpenAI client does not read. The embedder reads it and sleeps that long.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parent
REPO = CORPUS.parents[1]
for p in (str(REPO), str(CORPUS)):
    if p not in sys.path:
        sys.path.insert(0, p)

import httpx  # noqa: E402
from openai import RateLimitError  # noqa: E402

import src.embedder as embedder  # noqa: E402
from src.config import EmbeddingConfig  # noqa: E402
from src.embedder import Embedder, _reset_seconds  # noqa: E402

# The durations Scaleway sends.
assert _reset_seconds({"x-ratelimit-reset-tokens": "44s702ms", "x-ratelimit-reset-requests": "200ms"}) == 45.202
assert _reset_seconds({"x-ratelimit-reset-tokens": "1m2s"}) == 62.5
assert _reset_seconds({"retry-after": "3"}) == 3.5
assert _reset_seconds({}) == 10.0


def limited(reset: str) -> RateLimitError:
    request = httpx.Request("POST", "https://api.scaleway.ai/v1/embeddings")
    response = httpx.Response(429, request=request, headers={"x-ratelimit-reset-tokens": reset})
    return RateLimitError("quota", response=response, body=None)


class Embeddings:
    def __init__(self, refusals: int, reset: str) -> None:
        self.refusals, self.reset, self.calls = refusals, reset, 0

    async def create(self, **kwargs):
        self.calls += 1
        if self.calls <= self.refusals:
            raise limited(self.reset)
        return SimpleNamespace(data=[SimpleNamespace(embedding=[0.0] * 4) for _ in kwargs["input"]])


slept: list[float] = []


async def fake_sleep(seconds: float) -> None:
    slept.append(seconds)


embedder.asyncio.sleep = fake_sleep  # type: ignore[assignment]

provider = Embedder(
    EmbeddingConfig(provider="openai", model="qwen3-embedding-8b", api_key="k", base_url="https://api.scaleway.ai/v1", vector_size=4)
)

# Indexing: two refusals, two waits of the announced length, then the vectors.
provider.client = SimpleNamespace(embeddings=Embeddings(refusals=2, reset="20s"))
result = asyncio.run(provider.embed_batch(["a", "b"]))
assert len(result.vectors) == 2 and slept == [20.5, 20.5], slept

# A query: a member's turn is waiting, so a long window is not waited for.
slept.clear()
provider.client = SimpleNamespace(embeddings=Embeddings(refusals=1, reset="40s"))
try:
    asyncio.run(provider.embed_query("q"))
except RateLimitError:
    pass
else:
    raise AssertionError("a query waited out a 40-second window")
assert slept == [], slept

# A query and a short window: it waits and answers.
provider.client = SimpleNamespace(embeddings=Embeddings(refusals=1, reset="1s"))
assert asyncio.run(provider.embed_query("q")) is not None and slept == [1.5], slept

# Requests stay under the model's context: the limit counts the whole input.
class Counting:
    def __init__(self) -> None:
        self.sizes: list[int] = []

    async def create(self, **kwargs):
        self.sizes.append(sum(provider.count_tokens(t) for t in kwargs["input"]))
        return SimpleNamespace(data=[SimpleNamespace(embedding=[0.0] * 4) for _ in kwargs["input"]])


counting = Counting()
provider.client = SimpleNamespace(embeddings=counting)
paragraph = "Une phrase de conversation, assez longue pour peser. " * 80
result = asyncio.run(provider.embed_batch([paragraph] * 50))
assert len(result.vectors) == 50, len(result.vectors)
assert len(counting.sizes) > 1 and max(counting.sizes) <= embedder._REQUEST_TOKENS, counting.sizes

# A single text past the context is cut, not refused.
counting.sizes.clear()
result = asyncio.run(provider.embed_batch(["mot " * 60_000]))
assert len(result.vectors) == 1 and counting.sizes[0] <= embedder._REQUEST_TOKENS, counting.sizes

print("ok")
