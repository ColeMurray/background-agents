/**
 * Strip every value of an env map from provider error text before it can
 * escape into a persisted/broadcast failure reason. A sandbox create request
 * carries secrets (SANDBOX_AUTH_TOKEN, user secrets, build callback tokens);
 * if a provider ever echoes request values in an error body, the echo must die
 * here. Each value is matched raw and through two levels of JSON escaping — the
 * shapes an echo can take in a parsed message or in raw body text that itself
 * quotes the encoded request. Every non-empty value is scrubbed: user secrets
 * are arbitrary-length, so there is no "too short to matter" — the cost is that
 * incidental text matching a config value ("true", a port) is redacted too,
 * which is the right failure direction for an error path.
 */
export function scrubEnvValues(text: string, envVars: Record<string, string>): string {
  const needles = new Set<string>();
  for (const value of Object.values(envVars)) {
    if (!value) continue;
    let form = value;
    for (let i = 0; i < 3; i++) {
      needles.add(form);
      form = JSON.stringify(form).slice(1, -1);
    }
  }
  let scrubbed = text;
  // Longest first, so a short needle cannot split a longer one mid-replacement.
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    scrubbed = scrubbed.split(needle).join("[redacted]");
  }
  return scrubbed;
}
