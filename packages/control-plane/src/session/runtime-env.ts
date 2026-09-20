import type { Env } from "../types";

export type CallbackBindings =
  | "SLACK_BOT"
  | "LINEAR_BOT"
  | "SERVICE_AUTH_SECRET_SLACK_BOT"
  | "SERVICE_AUTH_SECRET_LINEAR_BOT";

/** Bot delivery belongs to the jobs consumer, not a resident session. */
export type SessionRuntimeEnv = Omit<Env, CallbackBindings> & {
  [K in CallbackBindings]?: never;
};

export function createSessionRuntimeEnv<T extends Pick<Env, CallbackBindings>>(
  env: T
): Omit<T, CallbackBindings> {
  const {
    SLACK_BOT: _slack,
    LINEAR_BOT: _linear,
    SERVICE_AUTH_SECRET_SLACK_BOT: _slackSecret,
    SERVICE_AUTH_SECRET_LINEAR_BOT: _linearSecret,
    ...runtimeEnv
  } = env;
  return runtimeEnv;
}
