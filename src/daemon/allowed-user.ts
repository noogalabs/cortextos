/**
 * Normalize ALLOWED_USER into the daemon gate's canonical comma-separated form.
 * Whitespace and empty comma segments are tolerated; any non-numeric token
 * rejects the whole value.
 */
export function normalizeAllowedUser(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0 || !ids.every((id) => /^\d+$/.test(id))) {
    return null;
  }
  return ids.join(',');
}
