/**
 * Quota helpers for the dashboard's quota-usage indicator.
 *
 * Reads the access token from
 * Claude Code's local credentials store, call Anthropic's OAuth usage API,
 * normalise to 0–1 utilization fractions.
 *
 * Adds a server-side last-good cache so transient 429s / network errors
 * don't blank the dashboard. On any failure we return the most recent
 * successful snapshot with `stale: true` and a `cache_age_ms` field;
 * the component renders an "Xm ago" suffix. Only when no cache exists
 * (cold boot) do we return null — that becomes "no data yet" in the UI.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_CREDS = path.join(os.homedir(), '.claude', '.credentials.json');

const CACHE_DIR = path.join(
  process.env.CTX_ROOT ?? path.join(os.homedir(), '.cortextos', 'default'),
  'state',
  'dashboard',
);
const CACHE_PATH = path.join(CACHE_DIR, 'quota-last-good.json');

export interface QuotaSnapshot {
  five_hour_remaining_pct: number;
  seven_day_remaining_pct: number;
  fetched_at: string;
  source: 'env' | 'credentials.json' | 'accounts.json';
}

export interface QuotaResponse extends QuotaSnapshot {
  /** True when the snapshot came from cache (API call failed). */
  stale: boolean;
  /** Milliseconds since the cached snapshot was originally fetched. 0 if fresh. */
  cache_age_ms: number;
}

const ACCOUNTS_PATH = path.join(
  process.env.CTX_ROOT ?? path.join(os.homedir(), '.cortextos', 'default'),
  'state',
  'oauth',
  'accounts.json',
);

/**
 * Token precedence matches the CLI's checkUsageApi: the ACTIVE per-instance
 * OAuth account first (so the indicator shows the quota of the account the
 * fleet is actually running on, not whatever token the dashboard process
 * happened to inherit), then the process env, then Claude Code's global
 * credentials file.
 */
function getOAuthToken(): { token: string; source: QuotaSnapshot['source'] } | null {
  if (fs.existsSync(ACCOUNTS_PATH)) {
    try {
      const raw = fs.readFileSync(ACCOUNTS_PATH, 'utf-8');
      const store = JSON.parse(raw) as {
        active?: string;
        accounts?: Record<string, { access_token?: string }>;
      };
      const token = store.active ? store.accounts?.[store.active]?.access_token : undefined;
      if (token) return { token, source: 'accounts.json' };
    } catch {
      /* fall through */
    }
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, source: 'env' };
  }
  if (fs.existsSync(CLAUDE_CREDS)) {
    try {
      const raw = fs.readFileSync(CLAUDE_CREDS, 'utf-8');
      const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
      const token = parsed.claudeAiOauth?.accessToken;
      if (token) return { token, source: 'credentials.json' };
    } catch {
      /* fall through */
    }
  }
  return null;
}

function readCache(): QuotaSnapshot | null {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as QuotaSnapshot;
  } catch {
    return null;
  }
}

function writeCache(snapshot: QuotaSnapshot): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(snapshot, null, 2));
  } catch {
    /* Best-effort: cache write failure shouldn't break the request. */
  }
}

async function fetchFresh(): Promise<QuotaSnapshot | null> {
  const auth = getOAuthToken();
  if (!auth) return null;

  const response = await fetch(ANTHROPIC_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (!response.ok) return null;

  // The Anthropic OAuth usage API actually returns NESTED objects:
  //   { five_hour: { utilization: 77.0, resets_at: "..." }, seven_day: {...}, ... }
  // We previously parsed flat fields (five_hour_utilization) which always
  // returned undefined → normalize → 0 → "100% remaining" regardless of
  // real usage. Hence the "stuck at 100%" UX bug. Keep the flat fallbacks
  // in case the API ever returns either shape.
  const data = (await response.json()) as {
    five_hour?: { utilization?: number };
    seven_day?: { utilization?: number };
    five_hour_utilization?: number;
    seven_day_utilization?: number;
    fiveHourUtilization?: number;
    sevenDayUtilization?: number;
  };

  // Nested shape is percent-scale by observation (utilization: 77.0 == 77%),
  // so it is ALWAYS divided by 100 — the >1 heuristic would misread a
  // genuinely-low nested reading (0.5 == 0.5% just after reset) as a 50%
  // fraction. The heuristic survives only for legacy flat fields.
  const fromPercent = (v: number | undefined): number | undefined =>
    v === undefined || v === null ? undefined : v / 100;
  const normalizeFlat = (v: number | undefined): number | undefined => {
    if (v === undefined || v === null) return undefined;
    return v > 1 ? v / 100 : v;
  };

  const fiveH =
    fromPercent(data.five_hour?.utilization)
    ?? normalizeFlat(data.five_hour_utilization ?? data.fiveHourUtilization)
    ?? 0;
  const sevenD =
    fromPercent(data.seven_day?.utilization)
    ?? normalizeFlat(data.seven_day_utilization ?? data.sevenDayUtilization)
    ?? 0;

  return {
    five_hour_remaining_pct: Math.round((1 - fiveH) * 100),
    seven_day_remaining_pct: Math.round((1 - sevenD) * 100),
    fetched_at: new Date().toISOString(),
    source: auth.source,
  };
}

/** Serve-from-cache window: many tabs poll each minute; one upstream call per
 * window serves them all instead of one call per mounted topbar. */
const FRESH_WINDOW_MS = 30_000;

/**
 * Fetch a quota response. Always returns the freshest available data:
 * a recent-enough cached snapshot (shared across dashboard clients), a fresh
 * API call when the cache is older, the cached last-good when the call fails
 * FOR ANY REASON (non-2xx, thrown network/DNS/timeout error, malformed JSON),
 * or null when nothing is available (cold-boot only).
 */
export async function fetchQuotaSnapshot(): Promise<QuotaResponse | null> {
  const recent = readCache();
  if (recent) {
    const ageMs = Date.now() - new Date(recent.fetched_at).getTime();
    if (ageMs >= 0 && ageMs < FRESH_WINDOW_MS) {
      return { ...recent, stale: false, cache_age_ms: ageMs };
    }
  }

  // A thrown fetch (network, DNS, timeout, bad JSON) must degrade to the
  // last-good cache exactly like a non-2xx response — never a 500.
  let fresh: QuotaSnapshot | null = null;
  try {
    fresh = await fetchFresh();
  } catch {
    fresh = null;
  }
  if (fresh) {
    writeCache(fresh);
    return { ...fresh, stale: false, cache_age_ms: 0 };
  }

  const cached = recent ?? readCache();
  if (cached) {
    const cacheAgeMs = Date.now() - new Date(cached.fetched_at).getTime();
    return { ...cached, stale: true, cache_age_ms: Math.max(0, cacheAgeMs) };
  }

  return null;
}
