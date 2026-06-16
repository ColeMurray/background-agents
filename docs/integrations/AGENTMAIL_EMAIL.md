# AgentMail Email Bot

The email bot lets one generic agent inbox route inbound email to deterministic OpenInspect
workflows.

For the SPI pilot, the intended setup is:

```text
Lawrence -> agent@taskark.com
AgentMail webhook -> email-bot
email-bot route by sender/domain -> taskark/spi
OpenInspect session -> completion callback
email-bot replies in the same AgentMail thread
```

## Worker

Package: `packages/email-bot`

Routes:

- `GET /health`
- `POST /webhooks/agentmail`
- `POST /callbacks/complete`
- `POST /callbacks/tool_call`

## Routing Config

Set `EMAIL_ROUTES_JSON` on the worker:

```json
{
  "routes": [
    {
      "id": "spi-training-content-update",
      "clientId": "spi",
      "repoOwner": "taskark",
      "repoName": "spi",
      "branch": "main",
      "workflow": "training-content-update",
      "skill": "spi-content-update",
      "recipientAddresses": ["agent@taskark.com"],
      "allowedSenders": ["lawrence_tan@spi.edu.sg"],
      "allowedDomains": ["spi.edu.sg", "sp.edu.sg"],
      "model": "claude-sonnet-4-6",
      "reasoningEffort": "medium"
    }
  ]
}
```

Routing is deterministic. If no route matches, the message is skipped. If multiple routes match, the
message is skipped as ambiguous.

## Required Secrets

- `AGENTMAIL_API_KEY`
- `AGENTMAIL_WEBHOOK_SECRET`
- `INTERNAL_CALLBACK_SECRET`

## AgentMail Setup

1. Verify `agents.taskark.com` or configure `agent@taskark.com` in AgentMail.
2. Create an inbox for the generic agent address.
3. Register `message.received` webhook to `/webhooks/agentmail`.
4. Store the Svix webhook secret as `AGENTMAIL_WEBHOOK_SECRET`.
5. Set allowlists in AgentMail and mirror them in `EMAIL_ROUTES_JSON`.

The model never chooses the route or recipient. It only produces work and an email-ready response;
the worker sends replies only to the original AgentMail thread.
