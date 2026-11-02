import { isIPv4, isIPv6 } from 'node:net';

const MAPPED_IPV4 = /^::ffff:/i;

/** Expands an IPv6 address (with `::` and an optional embedded IPv4 tail) to its eight 16-bit groups. */
function expandIPv6(address: string): string[] {
  let text = address.split('%', 1)[0] as string;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (isIPv4(tail)) {
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const first = head === '' ? [] : head.split(':');
  const last = rest === undefined || rest === '' ? [] : rest.split(':');
  const fill = rest === undefined ? [] : Array<string>(8 - first.length - last.length).fill('0');
  return [...first, ...fill, ...last].map((group) => group.toLowerCase().padStart(4, '0'));
}

/**
 * The rate limit subject of a client address. IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`) become
 * the plain IPv4 address, and an IPv6 address is reduced to its /64 prefix (a single subscriber
 * controls a whole /64, so per-address counters would be trivial to dodge). Anything that is not an
 * IP address (for example `unknown`) is returned unchanged.
 *
 * @param ip The address as reported by `req.ip`.
 * @returns The key to count.
 * @example
 * clientIpKey('::ffff:203.0.113.7'); // '203.0.113.7'
 * clientIpKey('::ffff:0102:0304');   // '1.2.3.4'
 * clientIpKey('2001:db8::1');         // '2001:0db8:0000:0000::/64'
 */
export function clientIpKey(ip: string): string {
  const unmapped = MAPPED_IPV4.test(ip) && isIPv4(ip.replace(MAPPED_IPV4, '')) ? ip.replace(MAPPED_IPV4, '') : ip;
  if (!isIPv6(unmapped)) {
    return unmapped;
  }
  const groups = expandIPv6(unmapped);
  if (groups.slice(0, 5).every((group) => group === '0000') && groups[5] === 'ffff') {
    // Mapped IPv4 written in hex (::ffff:0102:0304).
    const [high, low] = [parseInt(groups[6] as string, 16), parseInt(groups[7] as string, 16)];
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return `${groups.slice(0, 4).join(':')}::/64`;
}
