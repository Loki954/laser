#!/usr/bin/env python3
"""Build a single self-contained HTML file of the app (fonts, scripts, styles inlined).
Usage: python3 tools/build_single.py <path-to-esbuild> <out.html> [--fragment] [--version X]
--fragment omits <!doctype>/<html>/<head>/<body> (for hosts that add their own skeleton)."""
import base64, json, os, re, subprocess, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
esbuild, out = sys.argv[1], sys.argv[2]
fragment = '--fragment' in sys.argv
version = sys.argv[sys.argv.index('--version') + 1] if '--version' in sys.argv else 'single'
R = lambda p: open(os.path.join(root, p), encoding='utf-8').read()
js = subprocess.run([esbuild, os.path.join(root, 'js/main.js'), '--bundle', '--format=iife', '--minify', '--target=es2020'],
                    check=True, capture_output=True, text=True).stdout
js = js.replace("VERSION=\"dev\"", f"VERSION=\"{version}\"").replace("\"dev\"", f"\"{version}\"")
fonts = {}
for f in sorted(os.listdir(os.path.join(root, 'fonts'))):
    if f.endswith('.ttf'):
        fonts[f[:-4]] = base64.b64encode(open(os.path.join(root, 'fonts', f), 'rb').read()).decode()
icon = 'data:image/png;base64,' + base64.b64encode(open(os.path.join(root, 'icons/icon-192.png'), 'rb').read()).decode()
safe = lambda s: s.replace('</script', '<\\/script')
html = R('index.html')
body = html[html.index('<body>') + 6: html.index('<script src="vendor/opentype.min.js">')]
body = body.replace('icons/icon-192.png', icon)
head = ('<title>SculpFun Studio</title>\n<meta name="theme-color" content="#14161a">\n'
        f'<link rel="icon" href="{icon}">\n<style>\n{R("css/app.css")}\n</style>\n')
scripts = (f'<script>{safe(R("vendor/opentype.min.js"))}</script>\n'
           f'<script>window.__BUNDLED=true;window.__FONTDATA={json.dumps(fonts)};</script>\n'
           f'<script>{safe(js)}</script>\n')
if fragment:
    doc = head + body + scripts
else:
    doc = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
           '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">\n'
           + head + '</head>\n<body>' + body + scripts + '</body>\n</html>\n')
open(out, 'w', encoding='utf-8').write(doc)
print(out, round(len(doc) / 1024), 'KB')
