"""RoE excluded-host matching, independent of how a host or an exclusion is spelled.

An operator writes an exclusion once, in whatever form the engagement document
uses: a wildcard, upper case, a URL, a host with its port, a fully qualified
name with its trailing dot, an IPv6 address in long form. Every caller passes
hosts in its own shape too: AI Surface passes base URLs, the subdomain filters
pass bare names. A spelling difference on either side used to mean the host
was scanned anyway. The table is the contract; fixtures use reserved names
(example.com, 2001:db8::/32, 10.0.0.0/8) only.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from recon.helpers.roe_scope import _filter_roe_excluded, _is_roe_excluded  # noqa: E402

# (host, exclusion, excluded?)
MATCHING = [
    ("a.example.com", "*.example.com", True),
    ("example.com", "*.example.com", False),
    ("API.Example.com", "api.example.com", True),
    ("api.example.com", "API.EXAMPLE.COM", True),
    ("api.example.com:8443", "api.example.com", True),
    ("https://api.example.com/x", "api.example.com", True),
    ("api.example.com.", "api.example.com", True),
    ("[2001:db8::1]", "2001:db8::1", True),
    ("2001:0db8:0:0:0:0:0:1", "2001:db8::1", True),
    ("a.example.com", "https://example.com", True),
    ("pay.example.com", "example.com", True),
    ("10.0.0.5", "10.0.0.0/24", True),
    ("notexample.com", "example.com", False),
    # A string suffix is not an IP rule.
    ("10.0.0.5", "0.5", False),
]


@pytest.mark.parametrize("host,exclusion,excluded", MATCHING,
                         ids=[f"{h}|{e}" for h, e, _ in MATCHING])
def test_exclusion_matching(host, exclusion, excluded):
    assert _is_roe_excluded(host, [exclusion]) is excluded


def test_no_exclusions_or_no_host_excludes_nothing():
    assert _is_roe_excluded("a.example.com", []) is False
    assert _is_roe_excluded("", ["example.com"]) is False
    assert _is_roe_excluded(None, ["example.com"]) is False


def _settings(excluded, enabled=True):
    return {"ROE_ENABLED": enabled, "ROE_EXCLUDED_HOSTS": excluded}


def test_filter_drops_excluded_urls_as_ai_surface_passes_them():
    urls = [
        "https://chat.example.com",
        "https://API.example.com:8443",
        "http://[2001:db8::1]:8080",
        "https://www.example.org",
    ]
    kept = _filter_roe_excluded(urls, _settings(["*.example.com", "2001:0db8::1"]),
                                label="ai-surface url")
    assert kept == ["https://www.example.org"]


def test_filter_drops_excluded_bare_names_as_subdomain_filters_pass_them():
    names = ["www.example.com", "pay.example.com", "api.pay.example.com", "mail.example.com"]
    kept = _filter_roe_excluded(names, _settings(["PAY.example.com."]))
    assert kept == ["www.example.com", "mail.example.com"]


def test_filter_is_a_no_op_when_roe_is_off():
    names = ["pay.example.com"]
    assert _filter_roe_excluded(names, _settings(["example.com"], enabled=False)) == names
    assert _filter_roe_excluded(names, _settings([])) == names
