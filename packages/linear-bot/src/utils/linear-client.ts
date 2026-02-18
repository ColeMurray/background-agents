/**
 * Linear API client utilities.
 */

const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * Verify Linear webhook signature.
 * Linear signs webhooks with HMAC-SHA256 using the webhook secret.
 */
export async function verifyLinearWebhook(
  body: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const expectedSig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expectedHex = Array.from(new Uint8Array(expectedSig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return signature === expectedHex;
}

/**
 * Post a comment on a Linear issue.
 */
export async function postIssueComment(
  apiKey: string,
  issueId: string,
  body: string
): Promise<{ success: boolean }> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({
      query: `
        mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
          }
        }
      `,
      variables: {
        input: {
          issueId,
          body,
        },
      },
    }),
  });

  if (!response.ok) {
    return { success: false };
  }

  const result = (await response.json()) as {
    data?: { commentCreate?: { success: boolean } };
  };

  return { success: result.data?.commentCreate?.success ?? false };
}

/**
 * Update issue state in Linear.
 */
export async function updateIssueState(
  apiKey: string,
  issueId: string,
  stateId: string
): Promise<{ success: boolean }> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({
      query: `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
          }
        }
      `,
      variables: {
        id: issueId,
        input: { stateId },
      },
    }),
  });

  if (!response.ok) {
    return { success: false };
  }

  const result = (await response.json()) as {
    data?: { issueUpdate?: { success: boolean } };
  };

  return { success: result.data?.issueUpdate?.success ?? false };
}

/**
 * Add a label to a Linear issue.
 */
export async function addIssueLabel(
  apiKey: string,
  issueId: string,
  labelId: string
): Promise<{ success: boolean }> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({
      query: `
        mutation IssueAddLabel($id: String!, $labelId: String!) {
          issueAddLabel(id: $id, labelId: $labelId) {
            success
          }
        }
      `,
      variables: { id: issueId, labelId },
    }),
  });

  if (!response.ok) {
    return { success: false };
  }

  const result = (await response.json()) as {
    data?: { issueAddLabel?: { success: boolean } };
  };

  return { success: result.data?.issueAddLabel?.success ?? false };
}
