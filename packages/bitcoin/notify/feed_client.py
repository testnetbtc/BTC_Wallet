# Drop-in producer client for chainwatch detectors to hand public-feed events
# to the Olesia platform bot. Detectors keep running exactly as they are; this
# just adds a second, fire-and-forget delivery path so events reach subscribed
# users (with per-user size filters) instead of only a broadcast channel.
#
# Config comes from the environment so no secret is hard-coded:
#   OLESIA_INTAKE_URL    e.g. http://127.0.0.1:8791/event
#   OLESIA_INTAKE_TOKEN  the intakeToken from notify-node.json
#
# Design rules: never raise into the detector, always short-timeout, never block
# the detector's own channel/alert path. A dead platform must not affect chainwatch.
import json
import os
import urllib.request

_URL = os.environ.get("OLESIA_INTAKE_URL", "http://127.0.0.1:8791/event")
_TOKEN = os.environ.get("OLESIA_INTAKE_TOKEN", "")

# feed keys must match the FEEDS registry in bot.mjs
FEEDS = ("coldcard", "whales", "satoshi", "ofac")


def emit(feed, key, title=None, body=None, link=None, btc=None, timeout=2.0):
    """Fire-and-forget a feed event to the platform. Returns delivered count or None.

    feed: one of FEEDS. key: unique dedup id (usually txid). btc: float size,
    REQUIRED for filtered feeds (whales) so per-user thresholds work.
    """
    if not _TOKEN or feed not in FEEDS:
        return None
    payload = {"feed": feed, "key": str(key)}
    if title is not None:
        payload["title"] = title
    if body is not None:
        payload["body"] = body
    if link is not None:
        payload["link"] = link
    if btc is not None:
        payload["btc"] = float(btc)
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        _URL, data=data, method="POST",
        headers={"content-type": "application/json", "x-intake-token": _TOKEN},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read() or b"{}")
            return out.get("delivered")
    except Exception:
        return None  # never let delivery problems touch the detector
