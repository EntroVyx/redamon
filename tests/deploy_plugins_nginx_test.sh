#!/usr/bin/env bash
# =============================================================================
# The single-host nginx keeps the plugin platform's internal routes off the
# public edge (master plan step 3.7, R-15).
# Run:  bash tests/deploy_plugins_nginx_test.sh
#
# WHY THIS MATTERS: the deploy proxies all of /api/ to the webapp. Three plugin
# route families are meant for the container networks only: the Gateway that
# plugin code calls with a call token (/api/plugin-gateway/), the runner's run
# list behind the runner key (/api/plugin-runner/) and plugin reconciliation
# behind the internal key (/api/internal/plugins/). nginx forwards the headers
# they authenticate with, so without a deny the internet could probe those
# checks. A `^~` prefix location wins over regex locations; it must also come
# before `location /api/` in the file to read as intended.
#
# Static checks on both templates, then the rendered configs under a real nginx
# (Docker): `nginx -t`, and requests for every route family, URL-encoded and
# double-slash variants included, answered 404 by nginx itself while an
# ordinary /api/ path still reaches the proxy. Self-skips without Docker.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$REPO_ROOT/tooling/deploy/single-host"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s (got: %s want: %s)\n' "$1" "$2" "$3"; }
skip() { printf '  skip %s (%s)\n' "$1" "$2"; }
eq()   { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }

PREFIXES="/api/plugin-gateway/ /api/plugin-runner/ /api/internal/plugins/"

echo "== both templates deny the three prefixes, before location /api/ =="
for t in redamon.conf.tmpl redamon-http.conf.tmpl; do
    f="$DEPLOY/nginx/$t"
    api_line="$(grep -n '^    location /api/ {' "$f" | head -1 | cut -d: -f1)"
    for p in $PREFIXES; do
        line="$(grep -nF "    location ^~ $p { return 404; }" "$f" | head -1 | cut -d: -f1)"
        if [[ -z "$line" ]]; then
            bad "$t denies $p with ^~ and 404" "absent" "location ^~ $p { return 404; }"
        elif [[ -n "$api_line" && "$line" -lt "$api_line" ]]; then
            ok "$t denies $p before location /api/"
        else
            bad "$t denies $p before location /api/" "line $line" "before $api_line"
        fi
    done
done

# render <template>: the config modules/nginx.sh would install (ip_allowlist gate
# admitting loopback, so an ordinary /api/ request passes the gate inside the test).
render() {
    ( cd "$REPO_ROOT" && \
      GATE_MODE=ip_allowlist MCP_EDGE_ALLOW_BEARER=false MCP_CLIENT_CIDRS="" MCP_SERVER_ENABLED=false \
      OPERATOR_ALLOW_CIDRS="127.0.0.1/32" HTTP_PORT=8080 \
      SERVER_NAME=redamon.example SSL_CERT_REMOTE=/c.pem SSL_KEY_REMOTE=/k.pem \
      CSP_CONNECT="'self'" CSP_HEADER_NAME=Content-Security-Policy \
      WS_AUTH_REQUEST="" REDIRECT_HOST=redamon.example TLS_MODE=selfsigned \
      _NGINX_MOD="$DEPLOY/modules/nginx.sh" _TMPL="$1" \
      bash -c '
        set -uo pipefail
        is_true() { [[ "$(printf "%s" "${1:-}" | tr "[:upper:]" "[:lower:]")" == "true" || "${1:-}" == "1" ]]; }
        source "$_NGINX_MOD"
        _render_template "$_TMPL"
      ' 2>/dev/null )
}

echo
echo "== the rendered configs carry the denies =="
for t in redamon.conf.tmpl redamon-http.conf.tmpl; do
    r="$(render "$DEPLOY/nginx/$t")"
    eq "$t renders all three denies" "$(grep -cE 'location \^~ /api/(plugin-gateway|plugin-runner|internal/plugins)/ \{ return 404; \}' <<<"$r")" "3"
done

echo
echo "== under a real nginx =="
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    skip "nginx runs of the rendered configs" "docker unavailable"
else
    # The session scratchpad is not bind-mountable by every Docker CLI; stage in the repo.
    WORK="$REPO_ROOT/.plugins-nginx-check.$$"
    mkdir -p "$WORK/snip"
    trap 'rm -rf "$WORK"' EXIT
    render "$DEPLOY/nginx/redamon.conf.tmpl" > "$WORK/tls.conf"
    render "$DEPLOY/nginx/redamon-http.conf.tmpl" > "$WORK/http.conf"
    for _s in "$DEPLOY"/nginx/snippets/*.conf; do cp "$_s" "$WORK/snip/redamon-$(basename "$_s")"; done
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/k.pem" -out "$WORK/c.pem" \
        -days 1 -subj "/CN=test" >/dev/null 2>&1
    # Requests: method path expected; 404 from nginx itself for the denied families,
    # anything else for an ordinary API path (the gate passes loopback; the upstream
    # 127.0.0.1:3000 does not exist inside the container, so that one is a 502).
    OUT="$(docker run --rm -v "$WORK:/s:ro" --entrypoint sh nginx:alpine -c '
        mkdir -p /etc/nginx/snippets /var/www/certbot && cp /s/snip/*.conf /etc/nginx/snippets/
        cp /s/c.pem /c.pem && cp /s/k.pem /k.pem && touch /etc/nginx/.redamon_htpasswd
        for f in tls http; do
            cp /s/$f.conf /etc/nginx/conf.d/redamon.conf
            if nginx -t >/dev/null 2>&1; then echo "$f nginx-t OK"; else echo "$f nginx-t FAIL"; continue; fi
            nginx
            if [ $f = tls ]; then base="https://127.0.0.1:443"; else base="http://127.0.0.1:8080"; fi
            for p in /api/plugin-gateway/v1/data/get /api/plugin-runner/v1/run-list \
                     /api/internal/plugins/reconcile /api/%70lugin-gateway/v1/data/get \
                     /api//plugin-gateway/v1/data/get /api/plugin-runner/v1/../v1/run-list \
                     /api/internal/plugins/x?y=1 /api/health; do
                code=$(curl -sk -o /dev/null -w "%{http_code}" -H "Host: redamon.example" \
                       --path-as-is -X POST "$base$p")
                echo "$f $p $code"
            done
            nginx -s stop; sleep 0.5
            rm -f /etc/nginx/conf.d/redamon.conf
        done' 2>/dev/null)"
    for f in tls http; do
        eq "$f: nginx -t passes" "$(grep -c "^$f nginx-t OK" <<<"$OUT")" "1"
        for p in /api/plugin-gateway/v1/data/get /api/plugin-runner/v1/run-list \
                 /api/internal/plugins/reconcile /api/%70lugin-gateway/v1/data/get \
                 /api//plugin-gateway/v1/data/get /api/plugin-runner/v1/../v1/run-list \
                 "/api/internal/plugins/x?y=1"; do
            eq "$f: $p is refused by nginx" "$(grep -F "$f $p " <<<"$OUT" | awk '{print $3}')" "404"
        done
        code="$(grep -F "$f /api/health " <<<"$OUT" | awk '{print $3}')"
        [[ -n "$code" && "$code" != "404" ]] && ok "$f: an ordinary /api/ path still reaches the proxy ($code)" \
            || bad "$f: an ordinary /api/ path still reaches the proxy" "${code:-none}" "not 404"
    done
fi

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
