FROM python:3.13.5-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/device PORT=8787 WEB_CONCURRENCY=1
WORKDIR /app
COPY requirements-public.txt .
RUN pip install --no-cache-dir -r requirements-public.txt && useradd --uid 10001 --create-home hub
COPY device/ ./device/
COPY web/ ./web/
COPY deploy/ ./deploy/
COPY contracts/ ./contracts/
# Normalize copied upload modes before dropping privileges; keep sources
# root-owned and read-only for the runtime user, with traversable directories.
RUN find /app -type d -exec chmod 0755 {} + \
    && find /app -type f -exec chmod 0644 {} +
USER hub
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=8s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/ready', timeout=5)"
CMD ["python", "device/public_hub.py"]
