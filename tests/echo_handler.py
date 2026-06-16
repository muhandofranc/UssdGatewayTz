"""Tiny stdlib HTTP server that mimics a USSD backend handler.

Useful for smoke-testing the gateway end-to-end without standing up
a real client app. Replies with a CON for the first call (text=='')
and END for any subsequent input, echoing back the UnifiedRequest
fields it received.

Usage (inside docker compose):
    The `echo-handler` service in docker-compose.yml runs this on
    port 8081. After `docker compose up -d`, register a shortcode
    pointing at  http://echo-handler:8081  and curl the gateway —
    the echo handler will see the unified JSON body in its log.

Usage (standalone, host):
    python tests/echo_handler.py
    # listens on 0.0.0.0:8081, JSON replies
"""
from __future__ import annotations

import json
import logging
from http.server import BaseHTTPRequestHandler, HTTPServer

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s: %(message)s")
LOGGER = logging.getLogger("echo_handler")


class _H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # silence the default access log; we log our own structured line.
        return

    def do_GET(self):
        self._reply({"action": "END", "message": "GET not supported by echo handler"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._reply({"action": "END", "message": "echo: invalid JSON"}, status=400)
            return

        LOGGER.info("echo got: %s", json.dumps(payload, separators=(",", ":")))
        auth = self.headers.get("Authorization", "")
        if auth:
            LOGGER.info("echo Authorization: %s", auth)

        ussd = (payload.get("ussd_string") or "").strip()
        msisdn = payload.get("msisdn", "?")
        operator = payload.get("operator", "?")

        if ussd == "":
            self._reply({
                "action": "CON",
                "message": (
                    f"Hi {msisdn} on {operator}.\n"
                    "1. Show my MSISDN\n"
                    "2. End session"
                ),
            })
            return
        if ussd in ("1", "1*"):
            self._reply({
                "action": "END",
                "message": f"Your number: {msisdn}",
            })
            return
        self._reply({
            "action": "END",
            "message": f"Thanks. Echoed: {ussd}",
        })

    def _reply(self, body: dict, status: int = 200) -> None:
        out = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def main() -> None:
    addr = ("0.0.0.0", 8081)
    LOGGER.info("echo handler listening on http://%s:%d", *addr)
    HTTPServer(addr, _H).serve_forever()


if __name__ == "__main__":
    main()
