/** Provider overlay only; the packed recipe owns all dependencies. */
export const DEFAULT_VERCEL_RUNTIME = "node24";
export const VERCEL_RUNTIME_WORKDIR = "/tmp/open-inspect-runtime";
export const VERCEL_LOCAL_RUNTIME_EXTRACT_DIR = `${VERCEL_RUNTIME_WORKDIR}/packages`;

export function buildVercelBootstrapScript(params: { runtimeExtractDir?: string } = {}): string {
  const directory = params.runtimeExtractDir || VERCEL_LOCAL_RUNTIME_EXTRACT_DIR;
  const script = `${directory}/packages/sandbox-images/install/install.sh`;
  return `set -euo pipefail\nsudo -E bash '${script.replace(/'/g, `'\\''`)}'`;
}
