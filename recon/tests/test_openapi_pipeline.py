"""OpenAPI is a resource-enumeration source, merged after every crawler.

Drives the real run_resource_enum with every crawler off except a mocked
Kiterunner, and the HTTP transport mocked: no Docker, no network. Pins where
OpenAPI runs (after the Kiterunner merge, so no tool in the module ever
requests a declared path), what the run keeps (an inventory, never the
operations or their free text), and that an OpenAPI failure costs the run
nothing else.
"""
from __future__ import annotations

import hashlib
import json
import socket
from unittest import mock

import pytest

from recon.helpers.openapi import discovery
from recon.main_recon_modules import resource_enum

DOC = 'https://api.example.com/openapi.json'
SPEC = {
    'openapi': '3.0.3', 'info': {'title': 'Fixture', 'version': '1'},
    'servers': [{'url': 'https://api.example.com'}],
    'paths': {
        '/orders': {'post': {'operationId': 'createOrder', 'summary': 'FREE TEXT SUMMARY',
                             'responses': {}}},
        '/users/{id}': {'get': {'parameters': [{'name': 'id', 'in': 'path', 'required': True,
                                                'schema': {'type': 'integer', 'example': 7}}],
                                'responses': {}}},
    },
}
SETTINGS = {
    'TARGET_DOMAIN': 'example.com',
    'KATANA_ENABLED': False, 'HAKRAWLER_ENABLED': False, 'GAU_ENABLED': False,
    'PARAMSPIDER_ENABLED': False, 'JSLUICE_ENABLED': False, 'FFUF_ENABLED': False,
    'ARJUN_ENABLED': False, 'ZAP_AJAX_SPIDER_ENABLED': False,
    'RESOURCE_ENUM_AI_CLASSIFIER_ENABLED': False,
    'KITERUNNER_ENABLED': True, 'KITERUNNER_WORDLISTS': ['fixture'], 'KITERUNNER_DETECT_METHODS': False,
    'OPENAPI_ENABLED': True, 'OPENAPI_AUTO_DISCOVER': False,
    'OPENAPI_SOURCES': [{'id': 'src-1', 'url': DOC}],
}
KITERUNNER_HIT = [{'url': 'https://api.example.com/orders', 'path': '/orders', 'method': 'GET', 'status': 200}]


class _Response:
    def __init__(self, status, body=''):
        self.status_code = status
        self.headers = {}
        self.content = body.encode()

    def iter_content(self, chunk_size):
        yield self.content

    def close(self):
        pass


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    discovery._reset_pacer()
    monkeypatch.setattr(socket, 'getaddrinfo',
                        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('198.51.100.10', 0))])
    yield
    discovery._reset_pacer()


def _run(settings, **patches):
    sent, order = [], []

    def get(self, url, **kwargs):
        sent.append(url)
        return _Response(200, json.dumps(SPEC)) if url == DOC else _Response(404)

    real_kr, real_oa = resource_enum.merge_kiterunner_into_by_base_url, resource_enum.merge_openapi_into_by_base_url
    with mock.patch.object(resource_enum, 'is_docker_installed', return_value=True), \
         mock.patch.object(resource_enum, 'is_docker_running', return_value=True), \
         mock.patch.object(resource_enum, 'extract_targets_from_recon',
                           return_value=(set(), {'api.example.com'}, {})), \
         mock.patch.object(resource_enum, 'build_target_urls', return_value=['https://api.example.com']), \
         mock.patch.object(resource_enum, 'ensure_kiterunner_binary', return_value=('/kr', '/wordlist')), \
         mock.patch.object(resource_enum, 'run_kiterunner_discovery', return_value=list(KITERUNNER_HIT)), \
         mock.patch.object(resource_enum, 'merge_kiterunner_into_by_base_url',
                           side_effect=lambda *a, **k: order.append('kiterunner') or real_kr(*a, **k)), \
         mock.patch.object(resource_enum, 'merge_openapi_into_by_base_url',
                           side_effect=lambda *a, **k: order.append('openapi') or real_oa(*a, **k)), \
         mock.patch('requests.Session.get', patches.get('get', get)):
        out = resource_enum.run_resource_enum(
            {'domain': 'example.com', 'subdomains': ['api.example.com']}, settings=settings)
    return out['resource_enum'], sent, order


def test_openapi_merges_after_kiterunner_and_keeps_an_inventory_only():
    re_data, sent, order = _run(dict(SETTINGS))

    assert order == ['kiterunner', 'openapi']
    assert sent == [DOC]
    endpoints = re_data['by_base_url']['https://api.example.com']['endpoints']
    observed = endpoints['/orders']
    assert observed['declared_only'] is False
    assert observed['methods'] == ['GET', 'POST']
    assert observed['sources'] == ['kiterunner', 'openapi']
    declared = endpoints['/users/7']
    assert declared['declared_only'] is True
    assert declared['openapi_path_templates'] == ['/users/{id}']
    assert endpoints['/openapi.json']['openapi_spec']['version'] == '3.0.3'

    inventory = re_data['openapi']
    assert inventory['groups'] == [{'root': 'example.com', 'operations_count': 2, 'new_endpoints': 2,
                                    'documents': inventory['groups'][0]['documents']}]
    assert [d['url'] for d in inventory['groups'][0]['documents']] == [DOC]
    assert [(r['url'], r['code'], r['session_headers'], r['routed_via_capture'])
            for r in inventory['requests']] == [(DOC, 200, False, False)]
    digest = hashlib.sha256(DOC.encode()).hexdigest()[:12]
    assert [s.rsplit('|', 1)[0] for s in inventory['source_status']] == [f'src-1|{digest}|ok']
    assert re_data['scan_metadata']['openapi_enabled'] is True
    dumped = json.dumps(re_data)
    assert 'operations' not in inventory
    assert 'FREE TEXT SUMMARY' not in dumped


def test_openapi_disabled_sends_nothing():
    re_data, sent, order = _run({**SETTINGS, 'OPENAPI_ENABLED': False})
    assert sent == [] and order == ['kiterunner']
    assert 'openapi' not in re_data


def test_stealth_mode_sends_nothing():
    re_data, sent, _ = _run({**SETTINGS, 'STEALTH_MODE': True})
    assert sent == []
    assert re_data['openapi']['requests'] == []


def test_an_openapi_failure_leaves_resource_enumeration_intact(capsys):
    with mock.patch.object(discovery, 'run_openapi_discovery',
                           side_effect=RuntimeError('https://api.example.com/x?token=fixture-secret')):
        re_data, _, _ = _run(dict(SETTINGS))
    assert '/orders' in re_data['by_base_url']['https://api.example.com']['endpoints']
    assert 'openapi' not in re_data
    log = capsys.readouterr().out
    assert '[!][OpenAPI] Ingestion failed; resource enumeration continues' in log
    assert 'fixture-secret' not in log


def test_an_engine_error_is_contained_and_logged_without_its_message(capsys):
    with mock.patch.object(discovery, '_discover',
                           side_effect=RuntimeError('https://api.example.com/x?token=fixture-secret')):
        payload = discovery.run_openapi_discovery({'domain': 'example.com'}, dict(SETTINGS), [])
    assert payload['operations'] == [] and payload['documents'] == []
    assert [d['code'] for d in payload['diagnostics']] == ['ingestion_failed']
    assert 'fixture-secret' not in capsys.readouterr().out


def test_partial_dispatch_runs_the_openapi_partial_module(monkeypatch):
    import partial_recon
    called = []
    monkeypatch.setattr('recon.partial_recon_modules.openapi_recon.run_openapi_partial',
                        lambda config: called.append(config) or {'example.com': 'ok'})
    config = {'tool_id': 'OpenAPI', 'domains': ['example.com']}
    assert partial_recon._dispatch('OpenAPI', config) == {'example.com': 'ok'}
    assert called == [config]
