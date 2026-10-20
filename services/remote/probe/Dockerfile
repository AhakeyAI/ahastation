FROM python:3.13.5-slim-bookworm
WORKDIR /app
COPY probe/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home probe
COPY probe/ ./probe/
USER probe
ENV PORT=8787 PYTHONUNBUFFERED=1
EXPOSE 8787
CMD ["python", "probe/app.py"]
