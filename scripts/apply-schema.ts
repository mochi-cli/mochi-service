import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { env } from '../src/lib/env.ts';

/**
 * Applies src/lib/schema.sql.
 *
 * Not `psql -f`, which the README used to say: that needs Postgres installed
 * locally to talk to a database that is not local, and on a machine without it
 * the documented setup step simply does not run. This uses the driver the
 * service already depends on, so the only requirement is DATABASE_URL.
 *
 * Statements go one at a time because Neon's HTTP endpoint takes one per
 * request. Comments are stripped before splitting, since `--` lines in this
 * file contain semicolons and splitting first would cut a statement in half.
 *
 * Every statement is `IF NOT EXISTS`, so running this twice is a no-op rather
 * than an error — which matters, because the alternative is people hesitating
 * to run it when they are unsure whether they already did.
 */

function statements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const path = new URL('../src/lib/schema.sql', import.meta.url);
const parsed = statements(readFileSync(path, 'utf8'));
console.log(`${parsed.length} statements to apply\n`);

const sql = neon(env.databaseUrl);
for (const statement of parsed) {
  const name = statement.match(/(?:TABLE|INDEX)(?: IF NOT EXISTS)? ([a-z_]+)/i)?.[1] ?? '?';
  await sql(statement);
  console.log(`  ok  ${name}`);
}
console.log('\nDone. `curl $SERVICE_ORIGIN/health` should now report no missing tables.');
