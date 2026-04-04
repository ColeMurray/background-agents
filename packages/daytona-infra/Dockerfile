FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV OPEN_INSPECT_REPO_ROOT=/app
ENV HOME=/home/openinspect

COPY packages/daytona-infra /app/packages/daytona-infra
COPY packages/sandbox-runtime /app/packages/sandbox-runtime

RUN pip install --upgrade pip && \
    pip install ./packages/daytona-infra && \
    groupadd --system openinspect && \
    useradd --system --gid openinspect --create-home --home-dir "$HOME" openinspect && \
    chown -R openinspect:openinspect /app "$HOME"

USER openinspect

CMD ["uvicorn", "src.app:app", "--host", "0.0.0.0", "--port", "8080"]
