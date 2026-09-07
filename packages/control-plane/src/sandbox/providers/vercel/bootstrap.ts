/** Runtime launch contract; image construction lives in packages/vercel-infra. */
import { SANDBOX_RUNTIME_VERSION } from "../../runtime-manifest";

export const VERCEL_SANDBOX_VERSION = SANDBOX_RUNTIME_VERSION;
export const VERCEL_PYTHON_BIN = "/usr/local/bin/python3";
export const DEFAULT_VERCEL_RUNTIME = "node24";
