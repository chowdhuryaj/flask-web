#!/usr/bin/env python3
"""Local dev server with caching disabled.

Browsers heuristically cache ES modules aggressively (hours) even without
cache headers; this forces revalidation so edits show up on plain reload.
Production (GitHub Pages) relies on the ?v=N import-stamp scheme instead.
"""
import http.server
import os

os.chdir(os.path.dirname(os.path.abspath(__file__)))  # serve this dir regardless of cwd


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8137))
    print(f'Serving flask-web at http://localhost:{port}/ (Ctrl-C to stop)')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
