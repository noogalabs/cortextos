import { neonQuery } from './neon.js';

export interface LogDecisionOpts {
  decidedAt?: string;
  rationale?: string;
  outcome?: string;
  outcomeRecordedAt?: string;
  status?: string;
  importance?: string;
  linkedEpisodeId?: number;
  tags?: string[];
  frameworkRoot?: string;
  org?: string;
}

export interface DecisionRow {
  id: number;
  agent: string;
  decided_at: string;
  decision_type: string;
  context: string;
  decision: string;
  rationale: string | null;
  outcome: string | null;
  outcome_recorded_at: string | null;
  status: string;
  importance: string;
  linked_episode_id: number | null;
  tags: string[] | null;
  source: string;
  created_at: string;
}

export async function logDecision(
  agent: string,
  decisionType: string,
  context: string,
  decision: string,
  opts: LogDecisionOpts = {},
): Promise<DecisionRow> {
  const sql = `
    INSERT INTO agent_decisions
      (agent, decided_at, decision_type, context, decision,
       rationale, outcome, outcome_recorded_at, status, importance,
       linked_episode_id, tags, source)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'cortextos_bus')
    RETURNING *
  `;
  const params = [
    agent,
    opts.decidedAt ?? new Date().toISOString(),
    decisionType,
    context,
    decision,
    opts.rationale ?? null,
    opts.outcome ?? null,
    opts.outcomeRecordedAt ?? null,
    opts.status ?? 'recorded',
    opts.importance ?? 'normal',
    opts.linkedEpisodeId ?? null,
    opts.tags && opts.tags.length > 0 ? opts.tags : null,
  ];
  const result = await neonQuery(sql, params, opts.frameworkRoot, opts.org);
  return result.rows[0] as unknown as DecisionRow;
}
