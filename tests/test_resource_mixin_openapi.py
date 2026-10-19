"""OpenAPI declarations written through resource_mixin (update_graph_from_resource_enum).

A fake session records every statement: the Cypher itself is exercised against
a real Neo4j in test_resource_enum_openapi_graph_integration.py. Here: which
parameters reach it, that a field the run did not declare is passed as null
(so the stored value survives), that every non-OpenAPI source passes
oa_declared_only = False, the path-parameter loop, and the per-source status.
"""
from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from graph_db.mixins.recon.resource_mixin import ResourceMixin  # noqa: E402

BASE = 'https://api.example.com'
DOC = 'https://docs.example.com/openapi.json'


class _Result:
    def single(self):
        return {'linked': 0}


class _Session:
    def __init__(self, calls):
        self.calls = calls

    def run(self, query, **params):
        self.calls.append((' '.join(query.split()), params))
        return _Result()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Driver:
    def __init__(self):
        self.calls = []

    def session(self):
        return _Session(self.calls)


def _write(by_base_url, openapi=None, domain='example.com'):
    mixin = ResourceMixin()
    mixin.driver = _Driver()
    resource_enum = {'by_base_url': by_base_url, 'forms': []}
    if openapi is not None:
        resource_enum['openapi'] = openapi
    stats = mixin.update_graph_from_resource_enum(
        {'domain': domain, 'subdomains': ['api.example.com', 'docs.example.com'],
         'resource_enum': resource_enum}, 'u1', 'p1')
    return stats, mixin.driver.calls


def _endpoint_calls(calls):
    return [p for q, p in calls if q.startswith('MERGE (e:Endpoint')]


def _declared_entry():
    return {
        'methods': ['GET'], 'sources': ['openapi'], 'category': 'api', 'declared_only': True,
        'openapi_path_templates': ['/users/{id}'],
        'parameters': {'query': [], 'body': [],
                       'path': [{'name': 'id', 'type': 'integer', 'category': 'other',
                                 'required': True, 'sample_values': ['7']}]},
        'parameter_count': {'query': 0, 'body': 0, 'path': 1, 'total': 1},
        'openapi': {'GET': {'operation_id': 'getUser', 'deprecated': False, 'security': ['oauth2'],
                            'tags': ['users'], 'spec_urls': [DOC]}},
    }


def test_a_declared_only_endpoint_carries_its_identifiers():
    stats, calls = _write({BASE: {'endpoints': {'/users/7': _declared_entry()}}})
    assert stats['errors'] == []
    params, = _endpoint_calls(calls)
    assert {k: v for k, v in params.items() if k.startswith('oa_')} == {
        'oa_declared_only': True, 'oa_declared': True, 'oa_templates': ['/users/{id}'],
        'oa_operation_id': 'getUser', 'oa_deprecated': False, 'oa_security': ['oauth2'],
        'oa_tags': ['users'], 'oa_spec_urls': [DOC], 'oa_spec': None, 'oa_spec_version': None,
        'oa_op_count': None,
    }


def test_a_crawled_endpoint_passes_null_for_every_openapi_field_and_clears_the_flag():
    entry = {'methods': ['GET'], 'sources': ['katana'], 'category': 'static',
             'parameters': {'query': [], 'body': [], 'path': []}, 'parameter_count': {'total': 0}}
    _, calls = _write({BASE: {'endpoints': {'/index.html': entry}}})
    params, = _endpoint_calls(calls)
    oa = {k: v for k, v in params.items() if k.startswith('oa_')}
    assert oa.pop('oa_declared_only') is False
    assert set(oa.values()) == {None}


def test_a_method_the_spec_did_not_declare_keeps_its_stored_identifiers():
    entry = _declared_entry()
    entry.update(methods=['GET', 'PUT'], declared_only=False)
    _, calls = _write({BASE: {'endpoints': {'/users/7': entry}}})
    by_method = {p['method']: p for p in _endpoint_calls(calls)}
    assert by_method['GET']['oa_operation_id'] == 'getUser'
    assert by_method['PUT']['oa_declared'] is None and by_method['PUT']['oa_operation_id'] is None
    assert by_method['PUT']['oa_declared_only'] is False


def test_the_spec_document_endpoint_records_its_version():
    entry = {'methods': ['GET'], 'sources': ['openapi'], 'category': 'api', 'declared_only': False,
             'parameters': {'query': [], 'body': [], 'path': []}, 'parameter_count': {'total': 0},
             'openapi_spec': {'version': '3.1.0', 'operation_count': 4}}
    _, calls = _write({'https://docs.example.com': {'endpoints': {'/openapi.json': entry}}})
    params, = _endpoint_calls(calls)
    assert (params['oa_spec'], params['oa_spec_version'], params['oa_op_count']) == (True, '3.1.0', 4)
    assert params['oa_declared'] is None


def test_the_statement_unions_spec_urls_and_never_marks_an_existing_node_declared_only():
    _, calls = _write({BASE: {'endpoints': {'/users/7': _declared_entry()}}})
    query = ' '.join(next(q for q, _ in calls if q.startswith('MERGE (e:Endpoint')).split())
    # A declared node created on an observed path stores false: left unset, the
    # declared-only predicate would fall back to openapi_declared and read true.
    assert ('ON CREATE SET e.openapi_declared_only = CASE WHEN $oa_declared_only THEN true '
            'WHEN $oa_declared THEN false ELSE null END') in query
    assert 'WHEN coalesce(e.openapi_declared, false) THEN true ELSE false END' in query
    assert '[u IN $oa_spec_urls WHERE NOT u IN coalesce(e.openapi_spec_urls, [])]' in query


def test_path_parameters_are_written_and_linked_to_every_method():
    entry = _declared_entry()
    entry['methods'] = ['GET', 'DELETE']
    entry['openapi']['DELETE'] = {'spec_urls': [DOC]}
    _, calls = _write({BASE: {'endpoints': {'/users/7': entry}}})
    merges = [p for q, p in calls if q.startswith('MERGE (p:Parameter') and p.get('position') == 'path']
    assert [(p['name'], p['sample_values'], p['required']) for p in merges] == [('id', ['7'], True)]
    links = [p for q, p in calls if 'MERGE (e)-[:HAS_PARAMETER]->(p)' in q and p.get('position') == 'path']
    assert sorted(p['method'] for p in links) == ['DELETE', 'GET']


def test_source_status_lands_on_the_runs_domain_and_an_empty_list_clears_it():
    status = ['src-1|0123456789ab|ok|2026-10-19T00:00:00Z']
    _, calls = _write({}, openapi={'source_status': status}, domain='ip-targets.p1')
    writes = [p for q, p in calls if 'SET d.openapi_source_status' in q]
    assert writes == [{'root': 'ip-targets.p1', 'user_id': 'u1', 'project_id': 'p1', 'status': status}]
    _, calls = _write({}, openapi={'source_status': []})
    assert [p['status'] for q, p in calls if 'SET d.openapi_source_status' in q] == [[]]


def test_a_run_without_openapi_leaves_the_status_alone():
    _, calls = _write({})
    assert not any('openapi_source_status' in q for q, _ in calls)
