#!/usr/bin/env python3
"""Tiny PJLink projector simulator for verifying the native Linux engine.

  python3 simulator.py [port]

Speaks PJLINK 0 (passwordless) and the %1POWR/INPT/MUTE/LAMP/NAME commands.
This is test scaffolding only — not part of the installed application.
"""
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4352
STATE = {"POWR": "0", "INPT": "1", "MUTE": "0", "LAMP": "0 1234", "NAME": "POA Sim Projector"}


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b"PJLINK 0\r\n")
        while True:
            buf = bytearray()
            while True:
                ch = self.rfile.read(1)
                if not ch:
                    return
                if ch in (b"\r", b"\n"):
                    break
                buf += ch
            if not buf:
                continue
            cmd = buf.decode("ascii", "replace").strip()
            parts = cmd.split()
            if len(parts) != 2 or not parts[0].startswith("%1"):
                reply = "ERR3"
            else:
                key, val = parts[0][2:], parts[1]
                if val == "?":
                    reply = f"{key}={STATE.get(key, 'ERR3')}"
                elif key in STATE:
                    STATE[key] = val
                    reply = "OK"
                else:
                    reply = "ERR3"
            self.wfile.write((reply + "\r").encode("ascii"))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


with Server(("127.0.0.1", PORT), Handler) as srv:
    srv.serve_forever()
