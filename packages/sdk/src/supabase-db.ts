/**
 * The database address for a Supabase Edge Function that also works in the local stack (`supabase start`).
 *
 * Locally (Supabase CLI 2.95.4, edge-runtime v1.73.13) the CLI sets SUPABASE_DB_URL to the container `supabase_db_<project>`.
 * Deno's DNS resolver rejects names with an underscore ("Label contains invalid characters"); npm:postgres gets `getaddrinfo ENOTFOUND`.
 * Inside the stack network the same container is also called `db.supabase.internal` (and `db`), which Deno resolves. When hosted, the URL holds a valid name
 * (`db.<ref>.supabase.co`, the pooler), so the address stays as it is. Without an argument the function reads SUPABASE_DB_URL itself.
 */
const LOCAL_CONTAINER = /^supabase_db_[A-Za-z0-9_-]+$/;
export const LOCAL_DB_HOST = 'db.supabase.internal';

function envOf(name: string): string | undefined {
  const g = globalThis as { Deno?: { env?: { get?: (n: string) => string | undefined } }; process?: { env?: Record<string, string | undefined> } };
  try { return g.Deno?.env?.get?.(name) ?? g.process?.env?.[name]; } catch { return undefined; }
}

export function supabaseDbUrl(url: string | undefined = envOf('SUPABASE_DB_URL')): string {
  if (!url) throw new Error('SUPABASE_DB_URL is not set');
  // only the host name is replaced; credentials, port, database and parameters stay character for character
  const m = /^([a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?)([^:/?#]+)(.*)$/i.exec(url);
  if (!m || !LOCAL_CONTAINER.test(m[2]!)) return url;
  return `${m[1]}${LOCAL_DB_HOST}${m[3]}`;
}
