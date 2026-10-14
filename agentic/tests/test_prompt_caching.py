"""Tests for the Anthropic prompt-caching infrastructure (FAPP-55).

Pins the contract: REACT_SYSTEM_PROMPT carries the THREE cache-tier markers at
the correct boundaries, in order, and splitting on them yields cached tiers that
contain only phase/session-stable interpolation (never per-iteration state) plus
an uncached suffix that holds the per-iteration Current State.

The runtime behaviour (cache_read > 0 on later iterations) is not tested here —
that needs a live Anthropic key and is verified at operator runtime.
"""

from __future__ import annotations

import os
import sys
import unittest

_agentic_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _agentic_dir)

from prompts.base import (  # noqa: E402
    REACT_SYSTEM_PROMPT,
    CACHE_MARKERS,
    CACHE_TIER0_END,
    CACHE_TIER1_END,
    CACHE_TIER2_END,
    CACHE_PREFIX_END_MARKER,
)


def _split_tiers(template: str):
    """Mirror think_node's split: 3 markers -> 4 ordered segments."""
    rest = template
    segments = []
    for marker in CACHE_MARKERS:
        head, sep, rest = rest.partition(marker)
        segments.append(head)
    segments.append(rest)
    return segments  # [tier0, tier1, tier2, suffix]


class PromptCachingMarkerTests(unittest.TestCase):

    def test_markers_are_three_distinct_opaque_strings(self):
        self.assertEqual(len(CACHE_MARKERS), 3)
        self.assertEqual(CACHE_MARKERS, (CACHE_TIER0_END, CACHE_TIER1_END, CACHE_TIER2_END))
        self.assertEqual(len(set(CACHE_MARKERS)), 3)
        for marker in CACHE_MARKERS:
            self.assertIsInstance(marker, str)
            self.assertGreater(len(marker), 8)
            self.assertIn("<<", marker)
            self.assertIn(">>", marker)
            # Shared prefix so skill-part validation forbids them with one entry.
            self.assertTrue(marker.startswith("<<REDAMON_CACHE_"))

    def test_backward_compat_alias_points_at_tier2_end(self):
        """The old single-marker name is kept as an alias for the end of the
        fully-cached prefix (Tier 2 end)."""
        self.assertEqual(CACHE_PREFIX_END_MARKER, CACHE_TIER2_END)

    def test_each_marker_present_exactly_once(self):
        for marker in CACHE_MARKERS:
            self.assertEqual(
                REACT_SYSTEM_PROMPT.count(marker), 1,
                f"marker {marker!r} must appear exactly once",
            )

    def test_markers_appear_in_tier_order(self):
        i0 = REACT_SYSTEM_PROMPT.index(CACHE_TIER0_END)
        i1 = REACT_SYSTEM_PROMPT.index(CACHE_TIER1_END)
        i2 = REACT_SYSTEM_PROMPT.index(CACHE_TIER2_END)
        self.assertLess(i0, i1)
        self.assertLess(i1, i2)

    def test_tier0_is_static_persona_and_rules(self):
        tier0, tier1, tier2, suffix = _split_tiers(REACT_SYSTEM_PROMPT)
        self.assertIn("You are RedAmon", tier0)
        self.assertIn("Your Operating Model", tier0)
        self.assertIn("Orchestrator Auto-Logic", tier0)
        # Workspace rules moved into the cached prefix.
        self.assertIn("{workspace_rules}", tier0)
        self.assertIn("{phase_definitions}", tier0)

    def test_tier1_is_session_stable(self):
        tier0, tier1, tier2, suffix = _split_tiers(REACT_SYSTEM_PROMPT)
        self.assertIn("{stealth_rules}", tier1)
        self.assertIn("{skill_selection_guide}", tier1)

    def test_tier2_has_phase_stuff_and_your_task(self):
        tier0, tier1, tier2, suffix = _split_tiers(REACT_SYSTEM_PROMPT)
        self.assertIn("## Current Phase: {current_phase}", tier2)
        self.assertIn("Available Tools", tier2)
        self.assertIn("{available_tools}", tier2)
        self.assertIn("{attack_path_behavior}", tier2)
        # Your Task (the static output contract) is cached at Tier 2.
        self.assertIn("## Your Task", tier2)
        self.assertIn("{tool_args_section}", tier2)

    def test_suffix_has_per_iteration_state(self):
        tier0, tier1, tier2, suffix = _split_tiers(REACT_SYSTEM_PROMPT)
        self.assertIn("Current State", suffix)
        for ph in ("{iteration}", "{chain_context}", "{todo_list}",
                   "{target_info}", "{qa_history}", "{objective}"):
            self.assertIn(ph, suffix)

    def test_cached_tiers_have_no_per_iteration_placeholders(self):
        """Critical: the cached region (tiers 0-2) must not contain any
        interpolation that varies per iteration — otherwise every call has a
        unique prefix and the cache never hits."""
        tier0, tier1, tier2, suffix = _split_tiers(REACT_SYSTEM_PROMPT)
        cached = tier0 + tier1 + tier2
        per_iteration_placeholders = [
            "{iteration}",
            "{max_iterations}",
            "{objective}",
            "{chain_context}",
            "{todo_list}",
            "{target_info}",
            "{qa_history}",
            "{objective_history_summary}",
            "{prior_chain_history}",
        ]
        for ph in per_iteration_placeholders:
            self.assertNotIn(
                ph, cached,
                f"per-iteration placeholder {ph!r} leaked into the cached "
                f"region — the cache would never hit",
            )


if __name__ == "__main__":
    unittest.main()
