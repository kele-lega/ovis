/** Discovery uses a literal IP and a deliberately explicit remote account, never the server's user. */
export function tailnetDestination(user: string, address: string): string | null {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(user) ? `${user}@${address}` : null;
}

export type SshSetupFailure = "refused" | "timeout" | "authentication" | "dns";

/** Hints supplement the original SSH output; a timeout/refusal does not prove a single cause. */
export function sshSetupFailure(words: string): SshSetupFailure | null {
  if (/could not resolve hostname|name or service not known|nodename nor servname|temporary failure in name resolution|getaddrinfo.*(?:failed|not known)/i.test(words)) return "dns";
  if (/connection refused/i.test(words)) return "refused";
  if (/connection timed out|operation timed out|SSH connection timed out/i.test(words)) return "timeout";
  if (/permission denied \(|authentication failed|too many authentication failures|no supported authentication methods/i.test(words)) return "authentication";
  return null;
}
