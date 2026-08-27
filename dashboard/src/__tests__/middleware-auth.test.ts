import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getToken } = vi.hoisted(() => ({ getToken: vi.fn() }));

vi.mock('next-auth/jwt', () => ({ getToken }));

import { middleware } from '../middleware';

describe('dashboard middleware session authentication', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = 'test-auth-secret';
    getToken.mockReset();
  });

  afterEach(() => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
  });

  it('test_named_fake_session_cookie_does_not_bypass_verified_auth', async () => {
    getToken.mockResolvedValue(null);
    const request = new NextRequest('http://localhost:3000/api/approvals', {
      headers: { cookie: 'authjs.session-token=attacker-controlled' },
    });

    const response = await middleware(request);

    expect(getToken).toHaveBeenCalledOnce();
    expect(response.status).toBe(401);
  });

  it('test_named_workflow_health_remains_auth_required', async () => {
    getToken.mockResolvedValue(null);
    const request = new NextRequest('http://localhost:3000/api/workflows/health');

    const response = await middleware(request);

    expect(getToken).toHaveBeenCalledOnce();
    expect(response.status).toBe(401);
  });

  it('accepts a session token verified by NextAuth', async () => {
    getToken.mockResolvedValue({ sub: 'operator' });
    const request = new NextRequest('http://localhost:3000/api/approvals', {
      headers: { cookie: 'authjs.session-token=issued-token' },
    });

    const response = await middleware(request);

    expect(response.status).toBe(200);
  });
});
