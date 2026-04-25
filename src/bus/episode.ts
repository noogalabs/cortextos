import { neonQuery } from './neon.js';

export interface LogEpisodeOpts {
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  status?: string;
  importance?: string;
  linkedTaskId?: string;
  linkedWorkorderId?: string;
  tags?: string[];
  frameworkRoot?: string;
  org?: string;
}

export interface EpisodeRow {
  id: number;
  agent: string;
  session_id: string | null;
  started_at: string;
  ended_at: string | null;
  episode_type: string;
  summary: string;
  status: string;
  importance: string;
  linked_task_id: string | null;
  linked_workorder_id: string | null;
  tags: string[] | null;
  source: string;
  created_at: string;
}

export async function logEpisode(
  agent: string,
  episodeType: string,
  summary: string,
  opts: LogEpisodeOpts = {},
): Promise<EpisodeRow> {
  const sql = `
    INSERT INTO agent_episodes
      (agent, session_id, started_at, ended_at, episode_type, summary,
       status, importance, linked_task_id, linked_workorder_id, tags, source)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'cortextos_bus')
    RETURNING *
  `;
  const params = [
    agent,
    opts.sessionId ?? null,
    opts.startedAt ?? new Date().toISOString(),
    opts.endedAt ?? null,
    episodeType,
    summary,
    opts.status ?? 'open',
    opts.importance ?? 'normal',
    opts.linkedTaskId ?? null,
    opts.linkedWorkorderId ?? null,
    opts.tags && opts.tags.length > 0 ? opts.tags : null,
  ];
  const result = await neonQuery(sql, params, opts.frameworkRoot, opts.org);
  return result.rows[0] as unknown as EpisodeRow;
}
