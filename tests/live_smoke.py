"""End-to-end smoke against a real server: Node process, real cookie session,
real queue, real model call, real browser.

The other two smokes drive the Pages demo with its deterministic simulator, and
the Node suite imports modules directly. Neither can catch the class of fault
that actually bit us: a server that boots with a stale key, a container holding
month-old code, or a sign-in flow that only works because a fixture seeded a
session. This script starts `src/server.js` exactly as an operator would, points
it at a fake OpenAI-compatible endpoint, and drives the real UI in a browser.

Run: python3 tests/live_smoke.py          (add --keep to leave the server up)
No network, no credentials, nothing is sent to X. The model is a local stub.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = 'live-smoke-pass-1'
MODEL = 'smoke-model'
# What the stub answers. Distinctive enough that a template draft or a cached
# page could never produce it.
REPLY = 'stub-reply: local models are cheap enough to run the loop yourself'
KEEP = '--keep' in sys.argv


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Stub:
    """Minimal OpenAI-compatible chat completions endpoint that records traffic."""

    def __init__(self):
        self.requests = []
        # Flip to 'error' to prove a bad key surfaces instead of hanging.
        self.mode = 'ok'
        stub = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_):
                pass

            def _send(self, payload, status=200):
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path.endswith('/models'):
                    return self._send({'object': 'list', 'data': [{'id': MODEL, 'object': 'model'}]})
                self._send({'error': {'message': 'not found'}}, 404)

            def do_POST(self):
                length = int(self.headers.get('content-length') or 0)
                raw = self.rfile.read(length).decode('utf-8', 'replace')
                try:
                    body = json.loads(raw)
                except json.JSONDecodeError:
                    body = {'raw': raw}
                stub.requests.append({'path': self.path, 'auth': self.headers.get('authorization'), 'body': body})
                if not self.path.endswith('/chat/completions'):
                    return self._send({'error': {'message': 'not found'}}, 404)
                if stub.mode == 'error':
                    return self._send({'error': {'message': 'Incorrect API key provided: smoke-***'}}, 401)
                self._send({
                    'id': 'chatcmpl-smoke',
                    'object': 'chat.completion',
                    'created': int(time.time()),
                    'model': body.get('model') or MODEL,
                    'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': REPLY}, 'finish_reason': 'stop'}],
                    'usage': {'prompt_tokens': 12, 'completion_tokens': 8, 'total_tokens': 20},
                })

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    @property
    def base(self):
        return f'http://127.0.0.1:{self.port}/v1'

    def close(self):
        self.httpd.shutdown()


def wait_health(base, seconds=30):
    deadline = time.time() + seconds
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f'{base}/api/health', timeout=2) as res:
                if res.status == 200:
                    return json.loads(res.read())
        except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
            last = error
        time.sleep(0.25)
    raise RuntimeError(f'server never became healthy: {last}')


def start_server(tmp, stub):
    port = free_port()
    env = {
        **os.environ,
        'PORT': str(port),
        'HOST': '127.0.0.1',
        'DATA_FILE': str(tmp / 'state.json'),
        'DASHBOARD_PASSWORD': PASSWORD,
        'AI_BASE_URL': stub.base,
        'AI_API_KEY': 'smoke-key',
        'AI_MODEL': MODEL,
        'AI_API_STYLE': 'chat',
        'AI_TIMEOUT_MS': '15000',
        # A real operator's .env must never leak into the test.
        'AGENT_SKIP_DOTENV': '1',
    }
    log = open(tmp / 'server.log', 'w')
    proc = subprocess.Popen(
        ['node', '--experimental-sqlite', 'src/server.js'],
        cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
    )
    base = f'http://127.0.0.1:{port}'
    wait_health(base)
    return proc, base, log


def sign_in(page, base):
    """Sign in. The boot fetch of /api/state answers 401 while signed out: that
    is the intended "you are not signed in" signal, so it is the one failure the
    caller tolerates, and only in this phase."""
    page.goto(f'{base}/index.html')
    page.locator('#login-form input[name=password]').fill(PASSWORD)
    page.locator('#login-form button[type=submit]').click()
    page.locator('.chat-row').first.wait_for()


def run(base, stub, errors, bad):
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={'width': 1360, 'height': 860})
        # The signed-out state request prints one 401 line; drop it so the
        # console assertion stays strict about everything else.
        page.on('console', lambda m: errors.append(m.text)
                if m.type == 'error' and 'status of 401' not in m.text else None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        # A failing request is a defect even when the UI recovers from it: the
        # console only says "401", so record the URL that produced it.
        phase = {'signed_in': False}
        page.on('response', lambda r: bad.append((phase['signed_in'], f'{r.status} {r.url}')) if r.status >= 400 else None)

        sign_in(page, base)
        phase['signed_in'] = True

        # The first-run workspace seeds the X-engage team; if that ever stops
        # happening, a brand new install opens on an empty screen.
        team = page.locator('.chat-row[data-id="team-x-engage"]')
        expect(team).to_have_count(1)
        team.click()

        composer = page.locator('#chat-form textarea[name=message]')
        composer.fill('Draft a short reply about local models and cost.')
        composer.press('Enter')
        expect(page.locator('#chat-space')).to_contain_text('local models and cost')

        # The whole point: a bot answers, which means session → route → queue →
        # model call → store → render all worked in one pass.
        expect(page.locator('#chat-space')).to_contain_text(REPLY, timeout=45000)

        # The provider saw a real request, with the key and a chat body.
        assert stub.requests, 'the app never called the model endpoint'
        last = stub.requests[-1]
        assert last['path'].endswith('/chat/completions'), f"unexpected path {last['path']}"
        assert last['auth'] == 'Bearer smoke-key', f"unexpected auth header {last['auth']!r}"
        assert last['body'].get('model') == MODEL, f"unexpected model {last['body'].get('model')!r}"
        messages = last['body'].get('messages') or []
        assert messages and any('local models and cost' in json.dumps(m) for m in messages), \
            'the user message never reached the model'

        # One message runs the group chain (scout -> ranker -> ... -> reviewer),
        # so several calls are expected. Identical bodies would mean the app
        # retried the same request instead of advancing, which looks like work
        # in the run log and costs money.
        bodies = [json.dumps(r['body'], sort_keys=True) for r in stub.requests]
        assert len(set(bodies)) == len(bodies), \
            f'the app sent {len(bodies) - len(set(bodies))} identical request(s): a retry storm'
        assert all(any(m.get('role') == 'system' and m.get('content') for m in r['body'].get('messages') or [])
                   for r in stub.requests), 'a model call carried no instructions'

        # Persistence: a reload must show the same conversation, not a rebuild.
        page.reload()
        expect(page.locator('#chat-space')).to_contain_text(REPLY, timeout=20000)
        phase['signed_in'] = True

        # A provider that rejects the key must say so in the conversation. A
        # silent failure is the worst outcome: the run log looks busy forever
        # and the operator blames the network.
        stub.mode = 'error'
        before = len(stub.requests)
        composer = page.locator('#chat-form textarea[name=message]')
        composer.fill('A second question that the provider will reject.')
        composer.press('Enter')
        expect(page.locator('#chat-space')).to_contain_text('A second question', timeout=20000)
        # Look for the provider's own words, not ours: matching /reject/ would
        # pass on the user's own message text and assert nothing.
        page.wait_for_function(
            '''() => /Incorrect API key|401/i.test(
                [...document.querySelectorAll('#chat-space *')]
                  .filter(n => !n.closest('form') && !n.matches('.msg-user, .msg-user *'))
                  .map(n => n.textContent).join(' '))''',
            timeout=45000,
        )
        assert len(stub.requests) > before, 'the failing message never reached the provider'
        log_text = page.locator('#chat-space').inner_text()
        print('    error surfaced as: ' + ' | '.join(
            line.strip() for line in log_text.splitlines() if 'key' in line.lower() or '401' in line)[:200])
        stub.mode = 'ok'
        browser.close()

    return len(stub.requests), log_text


def main():
    errors, bad = [], []
    tmp, proc, stub, log = Path(tempfile.mkdtemp(prefix='ac-live-')), None, None, None
    try:
        stub = Stub()
        proc, base, log = start_server(tmp, stub)
        calls, _ = run(base, stub, errors, bad)
        print(f'  ok   server booted, signed in, bot answered ({calls} model call(s))')
        print(f'  ok   provider saw the key, the model id and the user message')
        print(f'  ok   {calls} distinct calls, each carrying its instructions')
        print(f'  ok   reply survived a reload')
        # While signed out the only acceptable failure is the 401 that means
        # "no session". Anything else, or anything after signing in, is a bug.
        # The rejected key legitimately produces a 401 from the provider; the
        # browser never sees it (server-to-server), so nothing to allow here.
        tolerated = {f'401 {base}/api/state'}
        unexpected = [f'{"after" if after else "before"} sign-in: {what}' for after, what in bad
                      if after or what not in tolerated]
        if unexpected:
            raise AssertionError('failed requests: ' + '; '.join(unexpected[:5]))
        print(f'  ok   a rejected key surfaces in the conversation')
        print(f'  ok   no unexpected request failures (only the signed-out 401)')
        print(f'LIVE SMOKE PASS: real server on {base}, stub model, {calls} call(s)')
        return 0
    except Exception as error:  # noqa: BLE001 - report everything, exit non-zero
        print(f'  FAIL {error.__class__.__name__}: {error}')
        traceback.print_exc()
        if log:
            log.flush()
            tail = (tmp / 'server.log').read_text()[-4000:]
            print('--- server log tail ---')
            print(tail)
        return 1
    finally:
        if proc and not KEEP:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        if stub:
            stub.close()
        if not KEEP:
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            print(f'kept: {tmp}')


if __name__ == '__main__':
    sys.exit(main())
