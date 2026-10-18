#!/usr/bin/env python3
"""Serve the static atlas on loopback; open a browser without dependencies."""
from pathlib import Path
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import webbrowser
root=Path(__file__).resolve().parent.parent
handler=partial(SimpleHTTPRequestHandler,directory=str(root))
for port in range(8765,8785):
    try:
        server=ThreadingHTTPServer(('127.0.0.1',port),handler)
        break
    except OSError:
        continue
else:
    raise SystemExit('No available local port in 8765–8784.')
url=f'http://127.0.0.1:{port}/'
print(f'3D UMAP: {url}\nKeep this window open. Press Ctrl+C to stop.',flush=True)
webbrowser.open(url)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
