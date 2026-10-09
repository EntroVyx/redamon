"""The shared redaction cases (TD-25, R-32).

The plugin platform masks session transcripts with a TypeScript port of
`redact_secret_shapes` (webapp/src/lib/plugins/redact.ts) before plugin code sees them.
Both implementations assert every case of one fixture file, so the two can only drift
together: change the Python function, regenerate `expected` from it, and the port's test
(redact.parity.test.ts) turns red until it follows.
"""

import json
import os
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cypherfix_triage.evidence import redact_secret_shapes  # noqa: E402

_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "redaction_vectors.json"
VECTORS = json.loads(_FIXTURE.read_text(encoding="utf-8"))["vectors"]


class TestRedactionVectors(unittest.TestCase):
    def test_every_vector(self):
        for v in VECTORS:
            with self.subTest(v["name"]):
                self.assertEqual(redact_secret_shapes(v["input"]), v["expected"])

    def test_redaction_is_idempotent_on_every_vector(self):
        for v in VECTORS:
            with self.subTest(v["name"]):
                self.assertEqual(redact_secret_shapes(v["expected"]), v["expected"])

    def test_the_fixture_is_synthetic_and_covers_the_unicode_rules(self):
        names = [v["name"] for v in VECTORS]
        self.assertEqual(len(names), len(set(names)))
        self.assertGreaterEqual(len(VECTORS), 40)
        # The cases where a naive JavaScript port differs from Python's Unicode regex.
        for needle in ("İ", "ı", "ſ", "K", "\x1c", "﻿", " ", "éAKIA"):
            self.assertTrue(any(needle in v["input"] for v in VECTORS), needle)
        # Only documentation hosts and addresses (rule P3).
        for v in VECTORS:
            for host in re.findall(r"https?://(?:[^@/\s]+@)?([^/\s:]+)", v["input"]):
                self.assertIn(host, ("example.com", "github.com"), v["name"])
            for ip in re.findall(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", v["input"]):
                self.assertTrue(ip.startswith(("192.0.2.", "198.51.100.")), v["name"])


if __name__ == "__main__":
    unittest.main()
