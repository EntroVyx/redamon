"""Every tool that writes an Endpoint clears its declared-only flag.

An Endpoint known only from an API specification (openapi_declared_only) is
requested with GET or HEAD only. Once any tool observes it, it is an ordinary
endpoint again, and only the writer can say so: the flag cannot be derived
from `sources`, which most writers do not maintain. resource_mixin, the
OpenAPI writer itself, sets the flag by its own rules; every other Cypher
statement that MERGEs an Endpoint must carry the clear line, in the same
statement, for the same variable. A new writer that forgets it keeps an
observed endpoint GET-only forever, so this scan fails it.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

MIXINS = Path(__file__).resolve().parents[2] / 'graph_db' / 'mixins'
OPENAPI_WRITER = MIXINS / 'recon' / 'resource_mixin.py'
MERGE_ENDPOINT = re.compile(r'MERGE\s*\(\s*(\w+)\s*:\s*Endpoint\b')


def _clear_line(var: str) -> re.Pattern:
    return re.compile(
        rf'SET\s+{var}\.openapi_declared_only\s*=\s*CASE\s+WHEN\s+coalesce\(\s*{var}\.openapi_declared_only\s*,'
        rf'\s*{var}\.openapi_declared\s*,\s*false\s*\)\s+THEN\s+false\s+ELSE\s+{var}\.openapi_declared_only\s+END')


def _endpoint_merges():
    for path in sorted(MIXINS.rglob('*.py')):
        if path == OPENAPI_WRITER:
            continue
        tree = ast.parse(path.read_text(encoding='utf-8'))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                for match in MERGE_ENDPOINT.finditer(node.value):
                    yield path, node.lineno, match.group(1), node.value


def test_the_scan_finds_the_known_writers():
    files = {path.name for path, *_ in _endpoint_merges()}
    # A rename that hid every writer from the scan would pass vacuously.
    assert {'http_mixin.py', 'vuln_mixin.py', 'js_recon_mixin.py', 'graphql_mixin.py',
            'cache_mixin.py', 'ai_surface_recon_mixin.py', 'osint_mixin.py'} <= files
    assert len(list(_endpoint_merges())) >= 13


def test_every_endpoint_writer_clears_the_declared_only_flag():
    missing = [f'{path.relative_to(MIXINS.parent.parent)}:{line} MERGE ({var}:Endpoint'
               for path, line, var, cypher in _endpoint_merges()
               if not _clear_line(var).search(cypher)]
    assert missing == [], 'Endpoint writers without the declared-only clear line:\n' + '\n'.join(missing)


def test_the_clear_line_comes_after_the_merge():
    for path, line, var, cypher in _endpoint_merges():
        merge_at = MERGE_ENDPOINT.search(cypher).start()
        clear = _clear_line(var).search(cypher)
        assert clear and clear.start() > merge_at, f'{path.name}:{line}'
