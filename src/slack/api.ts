/**
 * Minimal Slack Web API client using built-in fetch (Node 20+).
 */

export interface SlackMessage {
  ts: string;
  user?: string;
  username?: string;
  text: string;
  type: string;
}

export class SlackAPI {
  private readonly baseUrl = 'https://slack.com/api';
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async postMessage(channel: string, text: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/chat.postMessage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel, text }),
    });
    const data = await response.json() as { ok: boolean; error?: string };
    if (!data.ok) {
      throw new Error(`Slack postMessage failed: ${data.error ?? 'unknown'}`);
    }
  }

  async getHistory(channel: string, oldest: string): Promise<SlackMessage[]> {
    const params = new URLSearchParams({ channel, oldest, limit: '50', inclusive: 'false' });
    const response = await fetch(`${this.baseUrl}/conversations.history?${params}`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });
    const data = await response.json() as { ok: boolean; messages?: SlackMessage[]; error?: string };
    if (!data.ok) {
      throw new Error(`Slack conversations.history failed: ${data.error ?? 'unknown'}`);
    }
    return (data.messages ?? []).reverse();
  }

  async getUserName(userId: string): Promise<string> {
    try {
      const params = new URLSearchParams({ user: userId });
      const response = await fetch(`${this.baseUrl}/users.info?${params}`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const data = await response.json() as { ok: boolean; user?: { real_name?: string; name?: string } };
      if (data.ok && data.user) {
        return data.user.real_name ?? data.user.name ?? userId;
      }
    } catch { /* fall through */ }
    return userId;
  }
}
