# API server container for Open-Inspect Daytona infrastructure.
#
# Runs the FastAPI server that exposes the same HTTP API surface
# as the Modal version but uses the Daytona SDK for sandbox management
# and S3/MinIO for snapshot storage.

FROM python:3.12-slim

# Install git and Docker CLI (git for scheduler, docker for sandbox exec)
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates gnupg \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg \
    && . /etc/os-release && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy project definition and install dependencies
COPY pyproject.toml .
RUN pip install --no-cache-dir .

# Copy application source
COPY src/ src/

EXPOSE 8080

CMD ["uvicorn", "src.app:app", "--host", "0.0.0.0", "--port", "8080"]
