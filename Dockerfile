# UssdGatewayTz — gateway image
#
# Slim runtime: python:3.12-slim + system deps for psycopg2-binary
# (it bundles libpq but still wants libssl in some envs). No build
# tools in the final image — we install wheels only.

FROM python:3.12-slim AS runtime

# APT_REFRESH is a cache-buster — pass any new value (date / CI run
# id) to force a fresh apt-get update layer for security fixes.
# Without the cache-bust + explicit `upgrade`, Debian fixes (e.g.
# CVE-2026-45447 openssl heap UAF, fixed at libssl3t64 3.5.6-1deb13u2)
# get silently skipped on rebuild because the RUN command bytes
# don't change.
ARG APT_REFRESH=build
RUN echo "apt-refresh=${APT_REFRESH}" > /etc/apt-refresh \
 && apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends \
        ca-certificates curl tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV TZ=Africa/Dar_es_Salaam \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY app/  /app/app/
COPY db/   /app/db/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
# docs/openapi.yaml is served by FastAPI as the /openapi.json source
# (overridden in app/main.py) so Swagger UI at /docs renders the
# hand-written MNO wire spec. Without this copy the gateway falls
# back to an empty stub.
COPY docs/ /app/docs/

# Uvicorn worker count tuned for a typical 2-vCPU container. Override
# via `command:` in compose if you scale up.
EXPOSE 8280
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "8280", \
     "--workers", "2", \
     "--proxy-headers", "--forwarded-allow-ips=*"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8280/healthz || exit 1
