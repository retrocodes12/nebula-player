/**
 * ClearKey helpers for the web player.
 *
 * Convention (shared with the Android/TV builds): the decryption key rides on the
 * stream URL as a fragment so it is never sent to the server:
 *
 *   https://host/manifest.mpd#clearkey=<kidHex>:<keyHex>[,<kidHex>:<keyHex>...]
 *
 * A `clearkey` query parameter is also accepted (and stripped). Keys are 32-hex-char
 * (16-byte) values. Shaka Player consumes the resulting `{ kidHex: keyHex }` map directly.
 */

export interface ClearKeyParsed {
  /** URL with the clearkey material removed, safe to hand to the player/network. */
  playbackUrl: string;
  /** Map of hex keyId -> hex key, or null when the URL carries no ClearKey. */
  clearKeys: Record<string, string> | null;
}

const HEX_16_BYTES = /^[0-9a-f]{32}$/;

function normalizeHex(value: string): string {
  return value.trim().replace(/-/g, '').replace(/\s/g, '').toLowerCase();
}

export function parseClearKeyUrl(rawUrl: string): ClearKeyParsed {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { playbackUrl: rawUrl, clearKeys: null };
  }

  let raw: string | null = null;

  const hash = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
  if (hash.startsWith('clearkey=')) {
    raw = decodeURIComponent(hash.slice('clearkey='.length));
    u.hash = '';
  }

  if (raw === null && u.searchParams.has('clearkey')) {
    raw = u.searchParams.get('clearkey');
    u.searchParams.delete('clearkey');
  }

  if (raw === null) {
    return { playbackUrl: rawUrl, clearKeys: null };
  }

  const clearKeys: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const kid = normalizeHex(pair.slice(0, idx));
    const key = normalizeHex(pair.slice(idx + 1));
    if (HEX_16_BYTES.test(kid) && HEX_16_BYTES.test(key)) {
      clearKeys[kid] = key;
    }
  }

  if (Object.keys(clearKeys).length === 0) {
    return { playbackUrl: rawUrl, clearKeys: null };
  }

  return { playbackUrl: u.toString(), clearKeys };
}

export function hasClearKey(url: string): boolean {
  return parseClearKeyUrl(url).clearKeys !== null;
}
