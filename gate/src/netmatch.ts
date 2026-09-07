/**
 * Minimal trusted-proxy matching (BUN-B-009). Dependency-free: the gate
 * only needs to answer "is this socket peer allowed to set X-Real-IP?".
 *
 * Supports IPv4 addresses and IPv4 CIDRs, exact IPv6 addresses, and the
 * IPv4-mapped IPv6 form (`::ffff:1.2.3.4`) that Node reports when a v4 client
 * connects to a dual-stack socket. Anything it cannot parse is treated as
 * "not a match" — fail closed to counting by socket address.
 */

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let acc = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    acc = acc * 256 + n;
  }
  return acc >>> 0;
}

/** Strip the `::ffff:` prefix Node adds to IPv4-mapped IPv6 peers. */
function normalize(ip: string): string {
  const lower = ip.trim().toLowerCase();
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  return m ? (m[1] as string) : lower;
}

function matchOne(peer: string, entry: string): boolean {
  const p = normalize(peer);
  const e = normalize(entry);
  if (e.includes('/')) {
    const [base, bitsRaw] = e.split('/');
    const bits = Number(bitsRaw);
    const peerInt = ipv4ToInt(p);
    const baseInt = base === undefined ? undefined : ipv4ToInt(base);
    if (peerInt === undefined || baseInt === undefined) {
      // Non-IPv4 CIDR (e.g. ::1/128): fall back to exact base comparison.
      return p === base;
    }
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    return (peerInt & mask) === (baseInt & mask);
  }
  return p === e;
}

/** True when `peer` matches any trusted entry (IP or CIDR). */
export function isTrustedProxy(peer: string | undefined, trusted: string[] | undefined): boolean {
  if (!peer || !trusted) return false;
  return trusted.some((entry) => matchOne(peer, entry));
}
