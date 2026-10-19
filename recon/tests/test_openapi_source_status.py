"""The per-source status (D19) and the request ledger (D20) of an OpenAPI run.

Each configured document gets one "<id>|<sha256(public url)[:12]>|<code>|<time>"
string: a fixed code, never a URL or a query (a document URL can carry a token).
The ledger records every request actually sent, with no header value and no
query string. requests.Session.get and DNS are patched: nothing leaves.
"""
from __future__ import annotations

import hashlib
import json
import socket

import pytest
import requests

from recon.helpers import circuit_breaker as cb
from recon.helpers.openapi.discovery import _reset_pacer, run_openapi_discovery

DOC = 'https://docs.example.com/openapi.json'
SPEC = {'openapi': '3.0.3', 'info': {'title': 'Fixture', 'version': '1'},
        'servers': [{'url': 'https://api.example.com'}],
        'paths': {'/users': {'get': {'responses': {}}}}}


class _Response:
    def __init__(self, status=200, body='', headers=None):
        self.status_code = status
        self.headers = headers or {}
        self.content = (body if isinstance(body, str) else json.dumps(body)).encode()

    def iter_content(self, chunk_size):
        yield self.content

    def close(self):
        pass


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    _reset_pacer()
    monkeypatch.setattr(socket, 'getaddrinfo',
                        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('198.51.100.10', 0))])
    yield
    _reset_pacer()


def _run(monkeypatch, routes, sources, **settings):
    sent = []

    def get(self, url, **kwargs):
        sent.append((url, dict(kwargs.get('headers') or {})))
        route = routes.get(url, _Response(404))
        if isinstance(route, Exception):
            raise route
        return route

    monkeypatch.setattr('requests.Session.get', get)
    config = {'TARGET_DOMAIN': 'example.com', 'OPENAPI_AUTO_DISCOVER': False, 'OPENAPI_SOURCES': sources, **settings}
    return run_openapi_discovery({'domain': 'example.com', 'subdomains': ['api.example.com']}, config, []), sent


def _status(payload):
    out = {}
    for entry in payload['source_status']:
        source_id, digest, code, at = entry.split('|')
        out[source_id] = (digest, code)
        assert at.endswith('Z')
    return out


def _hash(url):
    return hashlib.sha256(url.encode()).hexdigest()[:12]


def test_an_imported_document_reads_ok_with_the_hash_of_its_public_url(monkeypatch):
    payload, _ = _run(monkeypatch, {DOC + '?token=fixture-secret': _Response(200, SPEC)},
                      [{'id': 's1', 'url': DOC + '?token=fixture-secret'}])
    assert _status(payload) == {'s1': (_hash(DOC), 'ok')}
    assert 'fixture-secret' not in json.dumps(payload['source_status'])
    assert 'docs.example.com' not in json.dumps(payload['source_status'])


@pytest.mark.parametrize('route,code', [
    (_Response(404), 'http_404'),
    (_Response(401), 'http_401'),
    (_Response(200, '<html>login</html>'), 'invalid_document'),
    (_Response(200, {'openapi': '3.2.0', 'info': {}, 'paths': {}}), 'unsupported_version'),
    (requests.ConnectionError('refused'), 'transport_error'),
])
def test_each_failure_has_its_fixed_code(monkeypatch, route, code):
    payload, _ = _run(monkeypatch, {DOC: route}, [{'id': 's1', 'url': DOC}])
    assert _status(payload) == {'s1': (_hash(DOC), code)}


def test_a_source_outside_the_scope_is_reported_and_never_fetched(monkeypatch):
    payload, sent = _run(monkeypatch, {}, [{'id': 's1', 'url': 'https://elsewhere.example.org/spec.json'}])
    assert sent == []
    assert _status(payload)['s1'][1] == 'out_of_scope'


def test_a_host_found_down_is_skipped(monkeypatch):
    for _ in range(3):
        cb.host_health.record_failure(DOC, requests.ConnectionError('x'))
    payload, sent = _run(monkeypatch, {DOC: _Response(200, SPEC)}, [{'id': 's1', 'url': DOC}])
    assert sent == []
    assert _status(payload)['s1'][1] == 'host_down'


def test_a_source_the_budget_never_reached_reads_limit_reached(monkeypatch):
    other = 'https://docs.example.com/v2.json'
    payload, _ = _run(monkeypatch, {DOC: _Response(200, SPEC), other: _Response(200, SPEC)},
                      [{'id': 's1', 'url': DOC}, {'id': 's2', 'url': other}], OPENAPI_MAX_DOCUMENTS=1)
    assert {k: v[1] for k, v in _status(payload).items()} == {'s1': 'ok', 's2': 'limit_reached'}


def test_a_swagger_ui_page_reads_ok_when_its_linked_document_imports(monkeypatch):
    page = 'https://docs.example.com/swagger/'
    payload, _ = _run(monkeypatch, {
        page: _Response(200, '<script>SwaggerUIBundle({url: "/swagger/v1.json"})</script>'),
        'https://docs.example.com/swagger/v1.json': _Response(200, SPEC),
    }, [{'id': 's1', 'url': page}])
    assert _status(payload)['s1'][1] == 'ok'


def test_a_disabled_source_gets_no_status_and_no_request(monkeypatch):
    payload, sent = _run(monkeypatch, {DOC: _Response(200, SPEC)}, [{'id': 's1', 'url': DOC, 'enabled': False}])
    assert sent == [] and payload['source_status'] == []


def test_the_ledger_records_each_request_without_secrets(monkeypatch):
    payload, sent = _run(monkeypatch, {
        DOC + '?token=fixture-secret': _Response(302, headers={'Location': '/current.json?token=fixture-secret'}),
        'https://docs.example.com/current.json?token=fixture-secret': _Response(200, SPEC),
    }, [{'id': 's1', 'url': DOC + '?token=fixture-secret'}],
        AUTH_PROFILE={'authType': 'bearer', 'authValue': 'fixture-session'})
    ledger = payload['requests']
    assert [(r['url'], r['code'], r['session_headers'], r['routed_via_capture']) for r in ledger] == [
        (DOC, 302, True, False), ('https://docs.example.com/current.json', 200, True, False)]
    dumped = json.dumps(ledger)
    assert 'fixture-secret' not in dumped and 'fixture-session' not in dumped
    # The session header did go to the document's own origin.
    assert all(headers.get('Authorization') == 'Bearer fixture-session' for _, headers in sent)


def test_the_ledger_is_bounded(monkeypatch):
    from recon.helpers.openapi import discovery
    monkeypatch.setattr(discovery, 'MAX_LEDGER', 2)
    payload, sent = _run(monkeypatch, {}, [], OPENAPI_AUTO_DISCOVER=True,
                         OPENAPI_DISCOVERY_PATHS=['/a', '/b', '/c'])
    assert payload['requests'] == []  # no seed origin, no request
    payload, sent = _run(monkeypatch, {}, [{'id': f's{i}', 'url': f'https://docs.example.com/{i}.json'} for i in range(4)])
    assert len(sent) == 4 and len(payload['requests']) == 2
