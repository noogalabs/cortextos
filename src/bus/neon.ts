import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

function parseEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      let val = trimmed.slice(idx + 1);
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[trimmed.slice(0, idx)] = val;
    }
  }
  return vars;
}

export function resolveNeonUrl(frameworkRoot?: string, org?: string): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const candidatePaths: string[] = [];
  if (frameworkRoot && org) {
    candidatePaths.push(join(frameworkRoot, 'orgs', org, 'secrets.env'));
  }

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      const vars = parseEnvFile(p);
      if (vars.DATABASE_URL) return vars.DATABASE_URL;
    }
  }

  throw new Error('DATABASE_URL not set. Add it to orgs/{org}/secrets.env or set DATABASE_URL env var.');
}

export async function neonQuery(
  sql: string,
  params: unknown[],
  frameworkRoot?: string,
  org?: string,
): Promise<{ rows: Record<string, unknown>[] }> {
  const connectionString = resolveNeonUrl(frameworkRoot, org);
  const pool = new Pool({ connectionString, max: 1, idleTimeoutMillis: 5000 });
  try {
    const result = await pool.query(sql, params);
    return { rows: result.rows };
  } finally {
    await pool.end();
  }
}
