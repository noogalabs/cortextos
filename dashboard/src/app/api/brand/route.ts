// GET /api/brand — returns the default brand for this dashboard instance.
//
// Used by unauthenticated surfaces (login page, splash) that need branding
// before an org is selected. Resolves per the rules in getDefaultBrand():
// CTX_DEFAULT_ORG env var → single-org fallback → cortextOS framework default.

import { NextResponse } from 'next/server';
import { getDefaultBrand, getOrgBrand } from '@/lib/data/organization';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const org = url.searchParams.get('org');

  // When called with ?org=<name>, return that specific org's brand.
  // Otherwise fall back to the dashboard's default brand.
  const brand = org ? getOrgBrand(org) : getDefaultBrand();

  return NextResponse.json(brand);
}
