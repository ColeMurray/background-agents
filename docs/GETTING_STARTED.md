# Getting Started with Open-Inspect

This guide walks you through deploying your own instance of Open-Inspect on Kubernetes.

> **Important**: This system is designed for **single-tenant deployment only**. All users share the
> same GitHub App credentials and can access any repository the App is installed on. See the
> [Security Model](../README.md#security-model-single-tenant-only) for details.

---

## Overview

Open-Inspect runs on open-source infrastructure deployed to any Kubernetes cluster:

| Component        | Technology         | Purpose                                |
| ---------------- | ------------------ | -------------------------------------- |
| **Rivet Engine** | Rust on K8s        | Actor orchestration, state persistence |
| **NATS**         | Message bus        | Inter-service communication            |
| **PostgreSQL**   | Database           | Session index, repo metadata, secrets  |
| **Redis**        | Cache              | Repository list caching                |
| **Control Plane**| Hono + Rivet Actors| HTTP API + session management          |
| **Web Frontend** | Next.js            | Web client UI                          |

**Your job**: Set up a K8s cluster, gather credentials, and configure secrets.
**Kubernetes' job**: Run all infrastructure components.

---

## Prerequisites

### Required Accounts

| Service                                          | Purpose                   |
| ------------------------------------------------ | ------------------------- |
| [GitHub](https://github.com/settings/developers) | OAuth + repository access |
| [Anthropic](https://console.anthropic.com)       | Claude API                |
| [Slack](https://api.slack.com/apps) _(optional)_ | Slack bot integration     |

### Required Tools

```bash
# kubectl (1.28+)
brew install kubectl

# Docker (for building images)
brew install docker

# Node.js (22+)
brew install node@22

# Helm (optional, for chart-based deployment)
brew install helm
```

### Required Infrastructure

- Kubernetes cluster (1.28+) - any provider: EKS, GKE, AKS, k3s, kind, etc.
- Docker registry for custom images (Docker Hub, ECR, GCR, etc.)
- kubectl configured to access your cluster

---

## Step 1: Clone the Repository

```bash
git clone https://github.com/YOUR-USERNAME/open-inspect.git
cd open-inspect
npm install

# Build the shared package
npm run build -w @open-inspect/shared
```

---

## Step 2: Create GitHub App

You only need **one GitHub App** - it handles both user authentication (OAuth) and repository access.

1. Go to [GitHub Apps](https://github.com/settings/apps)
2. Click **"New GitHub App"**
3. Fill in the basics:
   - **Name**: `Open-Inspect-YourName` (must be globally unique)
   - **Homepage URL**: Your deployment URL
   - **Webhook**: Uncheck "Active" (not needed)
4. Configure **Identifying and authorizing users** (OAuth):
   - **Callback URL**: `https://YOUR-DOMAIN/api/auth/callback/github`
5. Set **Repository permissions**:
   - Contents: **Read & Write**
   - Pull requests: **Read & Write**
   - Metadata: **Read-only**
6. Click **"Create GitHub App"**
7. Note the **App ID** (shown at top of settings page)
8. Under **"Client secrets"**, click **"Generate a new client secret"** and note the **Client
   Secret**
9. Scroll down to **"Private keys"** and click **"Generate a private key"** (downloads a .pem file)
10. **Install the app** on your account/organization:
    - Click "Install App" in the sidebar
    - Select the repositories you want Open-Inspect to access
11. Note the **Installation ID** from the URL after installing:
    ```
    https://github.com/settings/installations/INSTALLATION_ID
    ```

You should now have:

- **App ID** (e.g., `123456`)
- **Client ID** (e.g., `Iv1.abc123...`)
- **Client Secret** (e.g., `abc123...`)
- **Private Key** (PEM format)
- **Installation ID** (e.g., `12345678`)

---

## Step 3: Get Anthropic API Key

1. Go to [Anthropic Console](https://console.anthropic.com)
2. Create an API key
3. Note the **API Key** (starts with `sk-ant-`)

---

## Step 4: Generate Security Secrets

Generate these random secrets:

```bash
# Token encryption key (for encrypting OAuth tokens at rest)
echo "TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)"

# Repo secrets encryption key (for encrypting repo-scoped secrets)
echo "REPO_SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)"

# Internal API secret (for sandbox-to-control-plane auth)
echo "INTERNAL_API_SECRET=$(openssl rand -hex 32)"

# NextAuth secret (for web session encryption)
echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)"
```

Save these values securely.

---

## Step 5: Build Docker Images

### Sandbox Runtime Image

```bash
cd packages/sandbox-runtime
docker build -t your-registry/open-inspect-sandbox:latest .
docker push your-registry/open-inspect-sandbox:latest
```

### Control Plane Image

```bash
cd packages/control-plane
docker build -t your-registry/open-inspect-control-plane:latest .
docker push your-registry/open-inspect-control-plane:latest
```

### Web Frontend Image

```bash
cd packages/web
docker build -t your-registry/open-inspect-web:latest .
docker push your-registry/open-inspect-web:latest
```

---

## Step 6: Configure Kubernetes Secrets

Update the secret files in `k8s/` with your values:

### Control Plane Secret (`k8s/control-plane/secret.yaml`)

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: control-plane-secret
  namespace: open-inspect
type: Opaque
stringData:
  TOKEN_ENCRYPTION_KEY: "your-generated-value"
  REPO_SECRETS_ENCRYPTION_KEY: "your-generated-value"
  INTERNAL_API_SECRET: "your-generated-value"
  GITHUB_CLIENT_ID: "Iv1.abc123..."
  GITHUB_CLIENT_SECRET: "your-client-secret"
  GITHUB_APP_ID: "123456"
  GITHUB_APP_PRIVATE_KEY: |
    -----BEGIN RSA PRIVATE KEY-----
    ... your key here ...
    -----END RSA PRIVATE KEY-----
  GITHUB_APP_INSTALLATION_ID: "12345678"
  ANTHROPIC_API_KEY: "sk-ant-..."
```

### PostgreSQL Secret (`k8s/postgres/secret.yaml`)

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: postgres-secret
  namespace: open-inspect
type: Opaque
stringData:
  POSTGRES_USER: "openinspect"
  POSTGRES_PASSWORD: "your-secure-password"
  POSTGRES_DB: "openinspect"
```

### Web Secret (`k8s/web/configmap.yaml`)

Update `NEXTAUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and URLs.

---

## Step 7: Update ConfigMaps

### Control Plane (`k8s/control-plane/configmap.yaml`)

Update the `SANDBOX_IMAGE` to point to your sandbox image:

```yaml
SANDBOX_IMAGE: "your-registry/open-inspect-sandbox:latest"
```

### Web Frontend (`k8s/web/configmap.yaml`)

Update URLs to match your deployment:

```yaml
CONTROL_PLANE_URL: "http://control-plane:3001"
NEXT_PUBLIC_WS_URL: "ws://your-domain/ws"
NEXTAUTH_URL: "https://your-domain"
```

---

## Step 8: Deploy to Kubernetes

```bash
# Create namespace and deploy all components
kubectl apply -k k8s/

# Wait for infrastructure
kubectl -n open-inspect wait --for=condition=ready pod -l app=postgres --timeout=300s
kubectl -n open-inspect wait --for=condition=ready pod -l app=nats --timeout=300s
kubectl -n open-inspect wait --for=condition=ready pod -l app=redis --timeout=300s

# Wait for Rivet Engine
kubectl -n open-inspect wait --for=condition=ready pod -l app=rivet-engine --timeout=300s

# Wait for application
kubectl -n open-inspect wait --for=condition=ready pod -l app=control-plane --timeout=300s
kubectl -n open-inspect wait --for=condition=ready pod -l app=web --timeout=300s

# Verify all pods are running
kubectl -n open-inspect get pods
```

---

## Step 9: Configure Ingress

Update `k8s/ingress.yaml` with your domain and TLS configuration:

```yaml
spec:
  rules:
    - host: your-domain.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: control-plane
                port:
                  number: 3001
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 3000
```

Apply:

```bash
kubectl apply -f k8s/ingress.yaml
```

---

## Step 10: Verify Deployment

```bash
# Port-forward control plane for testing
kubectl -n open-inspect port-forward svc/control-plane 3001:3001 &

# Health check
curl http://localhost:3001/health

# Port-forward web app
kubectl -n open-inspect port-forward svc/web 3000:3000 &

# Visit http://localhost:3000
```

### Test the Full Flow

1. Visit your web app URL (or localhost:3000)
2. Sign in with GitHub
3. Create a new session with a repository
4. Send a prompt and verify the sandbox starts

---

## Updating Your Deployment

```bash
# Pull latest changes
git pull origin main

# Rebuild images
docker build -t your-registry/open-inspect-sandbox:latest packages/sandbox-runtime/
docker build -t your-registry/open-inspect-control-plane:latest packages/control-plane/
docker build -t your-registry/open-inspect-web:latest packages/web/

# Push images
docker push your-registry/open-inspect-sandbox:latest
docker push your-registry/open-inspect-control-plane:latest
docker push your-registry/open-inspect-web:latest

# Rolling restart
kubectl -n open-inspect rollout restart deployment/control-plane
kubectl -n open-inspect rollout restart deployment/web
```

---

## Troubleshooting

### Pods not starting

```bash
# Check pod status
kubectl -n open-inspect get pods

# Check pod events
kubectl -n open-inspect describe pod <pod-name>

# Check logs
kubectl -n open-inspect logs <pod-name>
```

### GitHub App authentication fails

1. Verify the private key is correct in the K8s secret
2. Check the Installation ID matches your installation
3. Ensure the app has required permissions on the repository

### Sandbox pods fail to connect

1. Verify CONTROL_PLANE_URL is correct in the control plane configmap
2. Check network policies allow sandbox pods to reach the control plane
3. Check sandbox pod logs: `kubectl -n open-inspect logs job/sandbox-<id>`

### PostgreSQL connection errors

```bash
# Check PostgreSQL is running
kubectl -n open-inspect get pods -l app=postgres

# Test connection
kubectl -n open-inspect exec -it deploy/control-plane -- \
  node -e "const pg = require('pg'); const c = new pg.Client(process.env.DATABASE_URL); c.connect().then(() => console.log('OK')).catch(console.error)"
```

### Rivet Engine health check fails

```bash
# Check engine logs
kubectl -n open-inspect logs -l app=rivet-engine

# Check NATS connectivity
kubectl -n open-inspect logs -l app=nats
```

---

## Security Notes

- **Never commit** K8s secrets to source control
- Use a secrets manager (e.g., Sealed Secrets, External Secrets Operator) for production
- Rotate secrets periodically by updating K8s secrets and restarting pods
- Review the [Security Model](../README.md#security-model-single-tenant-only)
- Deploy behind SSO/VPN for production use

---

## Architecture Reference

For details on how Open-Inspect works, see:

- [HOW_IT_WORKS.md](./HOW_IT_WORKS.md) - Architecture and design overview
- [README.md](../README.md) - System overview and quick start
