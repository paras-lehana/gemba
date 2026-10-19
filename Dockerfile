# Gemba on Cloud Run: one container serves the API, the live streams and the web app.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY VERSION ./
COPY app ./app
COPY static ./static
RUN useradd --create-home gemba && mkdir -p /data && chown -R gemba /app /data
USER gemba
EXPOSE 8080
CMD exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips="*" --timeout-keep-alive 75
