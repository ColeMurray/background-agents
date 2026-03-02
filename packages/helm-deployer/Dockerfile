FROM node:22-alpine

# Install Helm
RUN apk add --no-cache curl bash && \
    curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Install kubectl
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && mv kubectl /usr/local/bin/

WORKDIR /app

# Copy the Helm chart
COPY ../helm-chart /charts/open-inspect-sandbox

# Copy the deployer service
COPY package.json index.mjs ./

ENV PORT=8090
ENV CHART_PATH=/charts/open-inspect-sandbox

EXPOSE 8090

CMD ["node", "index.mjs"]
