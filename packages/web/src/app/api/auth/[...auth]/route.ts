import { proxyBrowserAuthRequest } from "@/lib/browser-auth-proxy";

// Next.js requires a literal seconds value; leave headroom beyond the callback transport deadline.
export const maxDuration = 300;

export const GET = proxyBrowserAuthRequest;
export const POST = proxyBrowserAuthRequest;
