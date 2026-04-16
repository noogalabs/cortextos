'use client';

import { useEffect, useState } from 'react';
import { useOrg } from './use-org';

interface Brand {
  /** Full brand name for titles, headers, metadata. */
  name: string;
  /** Short name for compact slots (favicons, mobile nav, PWA title). */
  shortName: string;
  /** True when the brand resolved from an org (not the framework default). */
  isOrgBrand: boolean;
}

const DEFAULT_BRAND: Brand = {
  name: 'cortextOS',
  shortName: 'cortextOS',
  isOrgBrand: false,
};

/**
 * Resolves the active brand from the currently selected org.
 *
 * Resolution order per org:
 *   1. `brand_name` / `brand_short_name` explicitly set in context.json
 *   2. Fallback: smart-cased `name` (e.g. "ascendops" → "AscendOps")
 *   3. Fallback: "cortextOS" framework default
 *
 * When no org is selected (currentOrg === 'all') or org context lookup
 * fails, falls back to the cortextOS default so the framework identity
 * is preserved in cross-org views.
 */
export function useBrand(): Brand {
  const { currentOrg } = useOrg();
  const [brand, setBrand] = useState<Brand>(DEFAULT_BRAND);

  useEffect(() => {
    if (!currentOrg || currentOrg === 'all') {
      setBrand(DEFAULT_BRAND);
      return;
    }

    let cancelled = false;
    fetch(`/api/org/config?org=${encodeURIComponent(currentOrg)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (cancelled || !data) return;
        const name =
          (typeof data.brand_name === 'string' && data.brand_name.trim()) ||
          smartCase(data.name || currentOrg) ||
          DEFAULT_BRAND.name;
        const shortName =
          (typeof data.brand_short_name === 'string' && data.brand_short_name.trim()) ||
          name;
        setBrand({ name, shortName, isOrgBrand: true });
      })
      .catch(() => {
        // Silent fallback — never crash UI on brand lookup failure
        if (!cancelled) setBrand(DEFAULT_BRAND);
      });

    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  return brand;
}

/** Convert "ascendops" → "AscendOps", "acme-corp" → "Acme Corp". */
function smartCase(raw: string): string {
  if (!raw) return '';
  return raw
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
