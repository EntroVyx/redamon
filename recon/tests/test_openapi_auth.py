"""OpenAPI downloads use the scoped project session for the exact origin only."""
import json
import socket

import pytest

from recon.helpers.openapi.discovery import _reset_pacer, run_openapi_discovery


@pytest.fixture(autouse=True)
def _public_dns(monkeypatch):
    # The address guard resolves discovered names and the gate has no DNS:
    # every name resolves to a documentation address.
    monkeypatch.setattr(socket, 'getaddrinfo',
                        lambda host, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('198.51.100.10', 0))])


@pytest.fixture(autouse=True)
def _fresh_pacer():
    # The request clock is process-wide; each test starts with its own ceiling.
    _reset_pacer()
    yield
    _reset_pacer()


def discover(recon_data, settings):
    """The engine as resource enumeration calls it: every probed and crawled URL is a seed."""
    seeds = list((recon_data.get('http_probe') or {}).get('by_url') or {})
    for base, data in ((recon_data.get('resource_enum') or {}).get('by_base_url') or {}).items():
        seeds.append(base)
        seeds.extend(base.rstrip('/') + path for path in data.get('endpoints') or {})
    return run_openapi_discovery(recon_data, settings, seeds)


class Response:
    status_code = 200
    headers = {}

    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def iter_content(self, chunk_size):
        yield self.body

    def close(self):
        pass


@pytest.mark.parametrize('discovery', [False, True])
def test_profile_authenticates_sources_discovery_and_references(monkeypatch, discovery):
    calls = []
    document = {'openapi': '3.0.3', 'info': {'title': 'Fixture', 'version': '1'},
                'paths': {'/widgets': {'get': {
        'parameters': [{'$ref': '/params#/id'}], 'responses': {}}}}}

    def get(self, url, **kwargs):
        calls.append((url, kwargs['headers']))
        return Response({'id': {'name': 'id', 'in': 'query'}} if url.endswith('/params') else document)

    monkeypatch.setattr('requests.Session.get', get)
    result = discover({'http_probe': {'by_url': {'https://api.example.com': {}}}}, {
        'TARGET_DOMAIN': 'example.com', 'OPENAPI_AUTO_DISCOVER': discovery,
        'OPENAPI_DISCOVERY_PATHS': ['/spec'],
        'OPENAPI_SOURCES': [] if discovery else [{'url': 'https://api.example.com/spec'}],
        'AUTH_PROFILE': {'authType': 'bearer', 'authValue': 'fixture-session',
                         'extraHeaders': {'X-Tenant': 'fixture-tenant'}},
    })
    assert len(result['operations']) == 1
    assert [url for url, _ in calls] == ['https://api.example.com/spec', 'https://api.example.com/params']
    assert all(headers == {'Authorization': 'Bearer fixture-session', 'X-Tenant': 'fixture-tenant'}
               for _, headers in calls)
    assert 'fixture-session' not in json.dumps(result)
