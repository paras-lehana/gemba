"""Simple in-memory rate limits for the endpoints that call a model (walk, ask, inspect, voice).

A public demo link must not be able to burn the model quota. Limits are per client IP and per window; the walk also
has a global cap on concurrent runs. On Cloud Run the client IP is the first X-Forwarded-For hop.
"""
import time
from collections import defaultdict, deque

LIMITS = {"walk": (4, 600), "ask": (20, 600), "inspect": (20, 600), "voice": (30, 600)}
MAX_CONCURRENT_WALKS = 4
_HITS: dict = defaultdict(deque)


def client_ip(request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "?")


def check(request, kind: str) -> str | None:
    """Return a message when the caller is over the limit, else record the hit and return None."""
    n, window = LIMITS[kind]
    key = (client_ip(request), kind)
    q = _HITS[key]
    now = time.time()
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= n:
        wait = int(window - (now - q[0])) + 1
        return f"Too many requests for this demo ({n} per {window // 60} min). Please try again in about {max(1, wait // 60)} min."
    q.append(now)
    return None
