"""AI Surface's RoE exclusion filter fails closed.

The filter used to sit in ``except Exception: pass``: any error inside it left
every candidate in place, so an RoE-excluded host was probed with chat, MCP and
spec requests. Every other caller of the filter lets an error propagate. Here an
error drops every candidate and the vector-DB reads, and the source is reported
degraded so the end-of-run prune keeps its previous findings.
"""
from __future__ import annotations

from unittest import mock

from recon.helpers import circuit_breaker as cb
from recon.main_recon_modules import ai_surface_recon as ais


def _settings():
    return {
        "AI_SURFACE_RECON_ENABLED": True,
        "ROE_ENABLED": True,
        "ROE_EXCLUDED_HOSTS": ["excluded.example.test"],
    }


def _candidates():
    return {
        "https://excluded.example.test": {"host_is_ai": True, "endpoints": []},
        "https://chat.example.test": {"host_is_ai": True, "endpoints": []},
    }


def _run(filter_side_effect=None):
    pool = mock.MagicMock()
    vector_reads = mock.MagicMock(return_value=[])
    patches = [
        mock.patch.object(ais, "_gather_candidates", return_value=_candidates()),
        mock.patch.object(ais, "ThreadPoolExecutor", pool),
        mock.patch.object(ais, "as_completed", return_value=[]),
        mock.patch.object(ais, "_confirm_vector_dbs", vector_reads),
    ]
    if filter_side_effect is not None:
        patches.append(mock.patch("recon.helpers.roe_scope._filter_roe_excluded",
                                  side_effect=filter_side_effect))
    for p in patches:
        p.start()
    try:
        out = ais.run_ai_surface_recon({"metadata": {}}, settings=_settings())
    finally:
        for p in reversed(patches):
            p.stop()
    submitted = [c.args[1] for c in pool.return_value.__enter__.return_value.submit.call_args_list]
    return out, submitted, vector_reads


def test_a_failing_roe_filter_probes_no_candidate(capsys):
    out, submitted, vector_reads = _run(filter_side_effect=RuntimeError("broken matcher"))

    assert submitted == []
    vector_reads.assert_not_called()
    assert out["ai_surface_recon"]["by_url"] == {}
    log = capsys.readouterr().out
    assert "[!][AISurfaceRecon] RoE filter failed; skipping AI surface probes: RuntimeError" in log
    # The exception text is not logged: it could carry a host or a URL.
    assert "broken matcher" not in log
    assert "ai_surface_recon" in cb.coverage_report().degraded_sources


def test_a_working_roe_filter_still_drops_only_the_excluded_host():
    # Control: the same run with the real filter submits the allowed host,
    # so the empty submission above is the fail-closed branch, not a no-op.
    _, submitted, vector_reads = _run()

    assert submitted == ["https://chat.example.test"]
    vector_reads.assert_called_once()
