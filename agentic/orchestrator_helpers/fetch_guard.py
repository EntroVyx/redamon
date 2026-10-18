"""Strict SSRF egress guard for agent-initiated fetches of EXTERNAL content
(STRIDE I18 — tradecraft crawl).

Unlike ``llm_url_guard`` (which deliberately *allows* loopback / RFC-1918 so the
self-hosted-model feature works), this guard is for fetching untrusted TARGET
web content: it must reject every internal destination. A crawl seed or a
redirect ``Location`` that points at loopback, an RFC-1918 host, link-local /
cloud metadata (``169.254.169.254``), CGNAT, or any non-global address is an
SSRF and is refused.

Reuses ``llm_url_guard._resolve_ips`` for DNS resolution (handles literal IPs,
IPv6 scope ids). Checking a URL up front is not enough on its own: httpx resolves
the name again when it connects, so a rebinding DNS answer slips through. Use
``pinned_async_transport()`` for the request itself; it judges the address at
connect time and dials exactly the address it judged (CVE-2026-111323).
"""

from __future__ import annotations

import asyncio
import ipaddress
from typing import Tuple
from urllib.parse import urlparse

import httpcore
import httpx

from .llm_url_guard import _resolve_ips, _BLOCKED_HOSTNAMES

_CGNAT = ipaddress.ip_network("100.64.0.0/10")


class UnsafeFetchURLError(ValueError):
    """Raised when a URL is not safe to fetch (SSRF into an internal address)."""


def _is_disallowed_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # unparseable → refuse
    # Judge IPv4-mapped IPv6 (::ffff:10.0.0.1) on the embedded v4 value.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
        or ip in _CGNAT
    )


def is_safe_fetch_url(url: str) -> bool:
    try:
        assert_safe_fetch_url(url)
        return True
    except UnsafeFetchURLError:
        return False


def assert_safe_fetch_url(url: str) -> None:
    """Raise ``UnsafeFetchURLError`` if ``url`` must not be fetched.

    An unresolvable host is allowed (it cannot be an SSRF into a known internal
    IP, and the request will simply fail); every resolved address must be a
    global/public IP.
    """
    parsed = urlparse((url or "").strip())
    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        raise UnsafeFetchURLError(
            f"refusing to fetch non-http(s) URL (scheme '{scheme or 'none'}')"
        )

    host = parsed.hostname
    if not host:
        raise UnsafeFetchURLError("refusing to fetch URL with no host")

    if host.lower().rstrip(".") in _BLOCKED_HOSTNAMES:
        raise UnsafeFetchURLError("refusing to fetch cloud-metadata host")

    for ip in _resolve_ips(host):
        if _is_disallowed_ip(ip):
            raise UnsafeFetchURLError(
                f"refusing to fetch URL resolving to non-public address {ip} "
                "(loopback / private / link-local / metadata)"
            )


class _PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Resolves, judges and dials in one step, for every TCP connection.

    That closes the rebinding window (one DNS answer for the check, another for
    the connect) and covers redirect hops without re-checking URLs, since each
    hop opens its connection here. TLS still verifies the original hostname:
    httpcore takes SNI from the request origin, not from the address dialled.

    ``UnsafeFetchURLError`` is not an httpcore exception, so httpx re-raises it
    unmapped and callers can tell "refused" apart from "network failed".
    """

    def __init__(self, inner: httpcore.AsyncNetworkBackend) -> None:
        self._inner = inner

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        if host.lower().rstrip(".") in _BLOCKED_HOSTNAMES:
            raise UnsafeFetchURLError("refusing to connect to cloud-metadata host")
        ips = list(dict.fromkeys(await asyncio.to_thread(_resolve_ips, host)))
        if not ips:
            raise httpcore.ConnectError(f"could not resolve {host}")
        for ip in ips:
            if _is_disallowed_ip(ip):
                raise UnsafeFetchURLError(
                    f"refusing to connect to {host}: it resolves to non-public "
                    f"address {ip} (loopback / private / link-local / metadata)"
                )
        last_error: Exception = httpcore.ConnectError(f"could not connect to {host}")
        for ip in ips:
            try:
                return await self._inner.connect_tcp(
                    ip, port, timeout=timeout,
                    local_address=local_address, socket_options=socket_options,
                )
            except httpcore.ConnectError as e:
                last_error = e
        raise last_error

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise UnsafeFetchURLError("refusing to connect to a unix socket")

    async def sleep(self, seconds):
        await self._inner.sleep(seconds)


def pinned_async_transport() -> httpx.AsyncHTTPTransport:
    """An httpx transport whose every connection passes the egress check.

    httpx has no public hook for the network backend, so this wraps the one the
    connection pool dials with. If a future httpcore renames that attribute,
    this raises instead of handing back an unguarded transport.
    """
    transport = httpx.AsyncHTTPTransport()
    pool = transport._pool
    if not isinstance(getattr(pool, "_network_backend", None), httpcore.AsyncNetworkBackend):
        raise RuntimeError("httpcore pool has no _network_backend; cannot pin egress")
    pool._network_backend = _PinnedNetworkBackend(pool._network_backend)
    return transport


# Run by the execute_playwright MCP tool in script mode, which provides `page`.
# Two layers, because page.route() never sees HTTP redirect hops: Chromium
# follows a 302 internally, even one fulfilled from inside the handler
# (measured on Playwright 1.63). The route handler stops JS navigations and
# subresources aimed at internal hosts; the redirect chain is checked after
# load, and a page that crossed an internal hop is never printed. What stays
# open: the browser resolves names itself, so rebinding inside the browser, and
# the blind GET a redirect hop makes before the post-load check, are not closed.
_BROWSER_GUARD_SCRIPT = '''\
import ipaddress as _rd_ipaddress
import socket as _rd_socket
import urllib.parse as _rd_urlparse
_rd_blocked_names = {blocked_names}
_rd_cgnat = _rd_ipaddress.ip_network("100.64.0.0/10")
_rd_verdicts = {{}}
def _rd_host_public(host):
    if host in _rd_blocked_names:
        return False
    try:
        infos = _rd_socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        ip = _rd_ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.version == 6 and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified or ip in _rd_cgnat):
            return False
    return True
def _rd_public(url):
    parts = _rd_urlparse.urlsplit(url)
    if parts.scheme in ("data", "blob"):
        return True
    host = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme not in ("http", "https") or not host:
        return False
    if host not in _rd_verdicts:
        _rd_verdicts[host] = _rd_host_public(host)
    return _rd_verdicts[host]
def _rd_route(route):
    if _rd_public(route.request.url):
        route.continue_()
    else:
        route.abort("blockedbyclient")
page.route("**/*", _rd_route)
try:
    _rd_resp = page.goto({url}, wait_until="networkidle", timeout=30000)
except Exception as _rd_exc:
    print("[ERROR] Navigation failed: " + str(_rd_exc).splitlines()[0])
else:
    _rd_hops = [page.url]
    _rd_req = _rd_resp.request if _rd_resp is not None else None
    while _rd_req is not None:
        _rd_hops.append(_rd_req.url)
        _rd_req = _rd_req.redirected_from
    _rd_bad = [h for h in _rd_hops if not _rd_public(h)]
    if _rd_bad:
        print("[BLOCKED] navigation reached a non-public address: " + _rd_bad[0])
    else:
        print(page.content()[:40000])
'''


def guarded_browser_script(url: str) -> str:
    """execute_playwright ``script`` that renders ``url`` and returns its HTML,
    refusing to return a page reached through an internal address."""
    # ascii() gives a literal with every non-ASCII character escaped, so the
    # URL can neither break out of the string nor split the line when the MCP
    # wrapper re-indents the script with str.splitlines().
    return _BROWSER_GUARD_SCRIPT.format(
        url=ascii(url),
        blocked_names=ascii(frozenset(_BLOCKED_HOSTNAMES)),
    )


def parse_guarded_browser_output(output: str) -> Tuple[str, str]:
    """Split guarded_browser_script output into (html, blocked_reason)."""
    text = (output or "").strip()
    if text.startswith("[BLOCKED]"):
        return "", text[len("[BLOCKED]"):].strip()
    if text.startswith(("[ERROR]", "[INFO]")):
        return "", ""
    return output or "", ""
