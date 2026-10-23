"""Halotel push timing.

push_outbound() records how long Halotel took to ack the push in
`elapsed_ms`, on every outcome -- a normal ack, a timeout and a transport
error -- so a slowing USSDGW is visible in raw_response_payload before it
starts hitting HALOTEL_OUTBOUND_TIMEOUT_SECS.

The pushes go to a local stub server, never to Halotel.
"""
import asyncio
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.adapters.halotel import Halotel                    # noqa: E402
from app.config import HalotelConfig                        # noqa: E402
from app.unified import (                                   # noqa: E402
    Action, SessionEvent, UnifiedReply, UnifiedRequest,
)

_ACK = (b'<?xml version="1.0" encoding="utf-8"?>'
        b'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
        b'<soap:Body><ussdresponse><errorCode>0</errorCode></ussdresponse>'
        b'</soap:Body></soap:Envelope>')


def _stub(delay_secs):
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            time.sleep(delay_secs)
            self.send_response(200)
            self.send_header("Content-Type", "text/xml")
            self.send_header("Content-Length", str(len(_ACK)))
            self.end_headers()
            try:
                self.wfile.write(_ACK)
            except OSError:
                pass        # client already gave up (timeout case)

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _push(url, timeout_secs):
    adapter = Halotel()
    adapter._settings = HalotelConfig(
        inbound_user="", inbound_pass="", outbound_url=url,
        outbound_user="u", outbound_pass="p", ussdgw_id_default="1",
        outbound_timeout_secs=timeout_secs,
    )
    ur = UnifiedRequest(
        operator="halotel", msisdn="255600000000", session_id="W1-TEST-1",
        service_code="*147*03#", ussd_string="1", event=SessionEvent.INPUT,
        raw_payload={"requesttype": "101", "user": "u", "pass": "p"},
    )
    return asyncio.run(adapter.push_outbound(ur, UnifiedReply(Action.CON, "menu")))


def test_ack_records_elapsed():
    srv = _stub(0.2)
    try:
        out = _push(f"http://127.0.0.1:{srv.server_port}/", 2.0)
    finally:
        srv.shutdown()
    assert out["error_code"] == "0" and "error" not in out
    assert 200 <= out["elapsed_ms"] < 2000


def test_timeout_records_elapsed():
    srv = _stub(1.5)
    try:
        out = _push(f"http://127.0.0.1:{srv.server_port}/", 0.3)
    finally:
        srv.shutdown()
    assert out["error"] == "timeout"
    assert 300 <= out["elapsed_ms"] < 1500


def test_transport_error_records_elapsed():
    # A port nothing listens on: connection refused.
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    out = _push(f"http://127.0.0.1:{port}/", 2.0)
    assert out["error"] == "transport"
    assert 0 <= out["elapsed_ms"] < 2000
