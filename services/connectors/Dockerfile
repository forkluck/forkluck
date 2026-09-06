FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd --system --create-home connectors
USER connectors
CMD ["gunicorn", "--bind", "0.0.0.0:8010", "--workers", "2", "--access-logfile", "-", "config.wsgi:application"]
