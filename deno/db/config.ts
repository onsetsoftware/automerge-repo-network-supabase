import { Pool } from "../deps.ts";

export interface PGConfig {
  initPool(): Pool;
}

export function getDBConfig(): PGConfig {
  const supabaseServerConfig = getSupabaseServerConfig();

  return supabaseDBConfig(supabaseServerConfig);
}

const serverEnvVars = {
  url: (Deno.env.get("SUPABASE_DB_URL") ?? "").replace("localhost", "host.docker.internal").replace('5432/', '6543/'),
};

export type SupabaseServerConfig = typeof serverEnvVars;

export function getSupabaseServerConfig() {
  return validate(serverEnvVars);
}

function validate<T extends Record<string, string>>(vars: T) {
  for (const [, v] of Object.entries(vars)) {
    if (!v) {
      throw new Error(`Invalid Supabase config: SUPABASE_DB_URL must be set`);
    }
  }
  return vars;
}

export function supabaseDBConfig(config: SupabaseServerConfig) {
  const { url } = config;
  return new PostgresDBConfig(url);
}

export class PostgresDBConfig implements PGConfig {
  private _url: string;

  constructor(url: string) {
    this._url = url;
  }

  initPool(): Pool {
    return new Pool(this._url, 20, true);
  }
}
