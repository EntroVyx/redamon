# The plugin runner (supervisor + workers) and the plugin-gateway proxy: one image, two
# entrypoints (docker-compose.yml services plugin-runner and plugin-gateway).
#
# This image runs third-party plugin code, so the base is pinned by digest and the
# supervisor's dependencies by exact version (requirements.txt). Workers start with
# `python -I -S` and see none of them: only the standard library, sdk/ and the plugin.
FROM python:3.11-slim@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /opt/runner

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --no-deps -r /tmp/requirements.txt \
 && pip check \
 && rm /tmp/requirements.txt

COPY platform_version.py ./
COPY sdk/ ./sdk/
COPY worker/ ./worker/
COPY supervisor/ ./supervisor/
COPY gateway_proxy/ ./gateway_proxy/

# Readable by the worker UIDs, writable by nobody but root.
RUN chmod -R u=rwX,go=rX /opt/runner

# The plugins volume's mount point, owned like the webapp's /data/plugins: Docker copies
# the first mounting image's ownership onto an empty named volume, so both images must
# agree for the webapp (uid 1001) to stay able to write it (experiment E3, X22).
RUN mkdir -p /plugins && chown 1001:1001 /plugins && chmod 0755 /plugins

# No `no-new-privileges` in compose (experiment E2: it stops every exec on the reference
# host), so no binary may carry a setuid or setgid bit: a worker could otherwise regain
# the supervisor's SETUID/SETGID/KILL capabilities through one.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true

# Root, with every capability dropped but SETUID, SETGID and KILL (compose): the
# supervisor must start each worker under its own UID.
USER root
EXPOSE 7080
CMD ["python", "-m", "supervisor.app"]
