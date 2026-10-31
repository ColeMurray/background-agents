import { z } from "zod";

const sentryIdentifierSchema = z.union([z.string(), z.number()]).transform(String);

export const sentryIssueWebhookSchema = z.object({
  action: z.string(),
  data: z.object({
    issue: z.object({
      id: z.string(),
      shortId: z.string(),
      title: z.string(),
      culprit: z.string().nullish(),
      level: z.string(),
      count: z.union([z.string(), z.number()]).optional(),
      firstSeen: z.string().nullish(),
      project: z.object({
        slug: z.string(),
      }),
      web_url: z.string().optional(),
    }),
  }),
});

export const sentryIssueAlertSchema = z.object({
  action: z.string(),
  data: z.object({
    event: z.object({
      metadata: z.object({
        type: z.string().optional(),
        value: z.string().optional(),
        filename: z.string().optional(),
      }),
      exception: z
        .object({
          values: z.array(
            z.object({
              stacktrace: z
                .object({
                  frames: z.array(
                    z.object({
                      filename: z.string().optional(),
                      abs_path: z.string().optional(),
                      function: z.string().optional(),
                      lineno: z.number().optional(),
                    })
                  ),
                })
                .optional(),
            })
          ),
        })
        .optional(),
      tags: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    }),
    issue: z.object({
      id: z.string(),
      shortId: z.string(),
      title: z.string().optional(),
      culprit: z.string().nullish(),
      level: z.string(),
      count: z.union([z.string(), z.number()]).optional(),
      firstSeen: z.string().nullish(),
      status: z.string(),
      lastSeen: z.string(),
      project: z.object({
        slug: z.string(),
      }),
    }),
    triggered_rule: z.string(),
  }),
});

/**
 * Issue alert payload as Sentry actually sends it to an internal integration's alert action
 * (`Sentry-Hook-Resource: event_alert`, `action: "triggered"`). It has no `data.issue`: the issue
 * id and project come from the event (`issue_id`, and the project slug inside the API `url`).
 */
export const sentryEventAlertSchema = z.object({
  action: z.string(),
  data: z.object({
    event: z.object({
      issue_id: sentryIdentifierSchema,
      url: z.string(),
      web_url: z.string().optional(),
      title: z.string().optional(),
      culprit: z.string().nullish(),
      level: z.string().optional(),
      metadata: z
        .object({
          type: z.string().optional(),
          value: z.string().optional(),
          filename: z.string().optional(),
        })
        .optional(),
      exception: z
        .object({
          values: z.array(
            z.object({
              stacktrace: z
                .object({
                  frames: z.array(
                    z.object({
                      filename: z.string().nullish(),
                      abs_path: z.string().nullish(),
                      function: z.string().nullish(),
                      lineno: z.number().nullish(),
                    })
                  ),
                })
                .nullish(),
            })
          ),
        })
        .nullish(),
      tags: z.array(z.tuple([z.string(), z.string()])).optional(),
    }),
    triggered_rule: z.string(),
  }),
});

export const sentryMetricAlertSchema = z.object({
  action: z.string(),
  data: z.object({
    metric_alert: z.object({
      id: sentryIdentifierSchema,
      title: z.string(),
      date_started: z.string(),
      alert_rule: z.object({
        id: sentryIdentifierSchema,
      }),
      current_trigger: z.object({
        label: z.string(),
      }),
    }),
    web_url: z.string(),
    description_text: z.string(),
    description_title: z.string(),
  }),
});

export type SentryIssueWebhookPayload = z.infer<typeof sentryIssueWebhookSchema>;
export type SentryIssueAlertPayload = z.infer<typeof sentryIssueAlertSchema>;
export type SentryEventAlertPayload = z.infer<typeof sentryEventAlertSchema>;
export type SentryMetricAlertPayload = z.infer<typeof sentryMetricAlertSchema>;
