"""The D15 predicates in a real Neo4j, and two graph builders that use them.

Integration tier: needs NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD and skips
without them. It writes and deletes one fixture tenant, so point it only at a
disposable database (see test_resource_enum_openapi_graph_integration.py for
the commands), never a stack's own Neo4j.
"""
from __future__ import annotations

import os
import unittest

import pytest

pytestmark = pytest.mark.integration

UID, PID = 'fixture-user-d15', 'fixture-project-d15'
BASE = 'https://api.example.com'


@unittest.skipUnless(os.getenv('NEO4J_URI') and os.getenv('NEO4J_PASSWORD'),
                     'NEO4J_URI / NEO4J_PASSWORD not set (integration tier)')
class TestDeclaredOnlyPredicates(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        from graph_db import Neo4jClient
        cls.client = Neo4jClient()

    @classmethod
    def tearDownClass(cls):
        cls._run('MATCH (n {user_id: $u, project_id: $p}) DETACH DELETE n')
        cls.client.close()

    @classmethod
    def _run(cls, query, **params):
        with cls.client.driver.session() as session:
            return session.run(query, u=UID, p=PID, base=BASE, **params).data()

    def setUp(self):
        self._run('MATCH (n {user_id: $u, project_id: $p}) DETACH DELETE n')
        self._run('''
            MERGE (d:Domain {name: 'example.com', user_id: $u, project_id: $p})
            MERGE (b:BaseURL {url: $base, user_id: $u, project_id: $p})
            WITH b
            UNWIND [
              {path: '/orders',   method: 'POST', declared: true,  only: true},
              {path: '/orders/1', method: 'GET',  declared: true,  only: true},
              {path: '/legacy',   method: 'POST', declared: true,  only: null},
              {path: '/login',    method: 'POST', declared: null,  only: null},
              {path: '/users/7',  method: 'POST', declared: true,  only: false}
            ] AS row
            MERGE (e:Endpoint {path: row.path, method: row.method, baseurl: $base, user_id: $u, project_id: $p})
            SET e.openapi_declared = row.declared, e.openapi_declared_only = row.only
            MERGE (b)-[:HAS_ENDPOINT]->(e)
            WITH b, e WHERE row.path IN ['/orders', '/orders/1']
            MERGE (q:Parameter {name: 'q', position: 'query', endpoint_path: e.path, baseurl: $base,
                                user_id: $u, project_id: $p})
            SET q.sample_values = ['1']
            MERGE (e)-[:HAS_PARAMETER]->(q)
        ''')

    def _paths(self, predicate):
        rows = self._run(f'MATCH (e:Endpoint {{user_id: $u, project_id: $p}}) WHERE NOT {predicate} '
                         'RETURN e.path AS path ORDER BY path')
        return [r['path'] for r in rows]

    def test_get_consumers_drop_declared_only_non_get_endpoints_including_older_ones(self):
        from recon.partial_recon_modules.graph_builders import declared_only_unsafe
        self.assertEqual(self._paths(declared_only_unsafe('e')), ['/login', '/orders/1', '/users/7'])

    def test_a_tool_that_posts_reads_no_declared_only_path(self):
        from recon.partial_recon_modules.graph_builders import declared_only
        self.assertEqual(self._paths(declared_only('e')), ['/login', '/users/7'])

    def test_the_vuln_scan_builder_keeps_only_the_get_parameterised_url(self):
        from recon.partial_recon_modules.graph_builders import _build_vuln_scan_data_from_graph
        data = _build_vuln_scan_data_from_graph(['example.com'], UID, PID)
        urls = data['resource_enum']['discovered_urls']
        self.assertEqual([u for u in urls if '?q=' in u], [f'{BASE}/orders/1?q=1'])

    def test_the_graphql_and_cache_builder_lists_no_declared_only_post(self):
        from recon.partial_recon_modules.graph_builders import _build_graphql_data_from_graph
        data = _build_graphql_data_from_graph(['example.com'], UID, PID)
        endpoints = {(e['path'], e['method']) for e in data['resource_enum']['endpoints'].get(BASE, [])}
        self.assertEqual(endpoints, {('/orders/1', 'GET'), ('/login', 'POST'), ('/users/7', 'POST')})


if __name__ == '__main__':
    unittest.main()
