// Low-level config and utilities for Postgres.

import { type Payload, Pool, QueryObjectResult } from "../deps.ts";
import { getDBConfig } from "./config.ts";

export function getPool(reset = false) {
  const global = globalThis as unknown as {
    _pool: Pool;
  };
  if (!global._pool || reset) {
    global._pool = initPool();
  }
  return global._pool;
}

function initPool() {
  console.log("creating global pool");

  const dbConfig = getDBConfig();
  return dbConfig.initPool();
}

export async function withExecutor<R>(f: (executor: Executor) => R) {
  const p = getPool();
  return await withExecutorAndPool(f, p);
}

let brokenPipeFound = false;

async function withExecutorAndPool<R>(
  f: (executor: Executor) => R,
  p: Pool
): Promise<R> {
  try {
    const client = await p.connect();

    await client.queryObject(
      "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE"
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const executor: Executor = async (sql: string, params?: any[]) => {
      try {
        return await client.queryObject(sql, params);
      } catch (e) {
        // console.log(
        //   // eslint-disable-next-line @typescript-eslint/no-explicit-any
        //   `Error executing SQL: ${sql}: ${(e as unknown as any).toString()}. Rolling back.`
        // );
        
        throw e;
      }
    };

    try {
      return await f(executor);
    } finally {
      client.release();
    }
  } catch (e) {
    if (e.toString().includes("Broken pipe")) {
      console.log("Broken pipe, resetting pool");
      await p.end();
      p = getPool(true);
      if (brokenPipeFound) {
        brokenPipeFound = false;
        throw e;
      } else {
        brokenPipeFound = true;
        return withExecutorAndPool(f, p);
      }
      
    }
    throw e;
  }
}

export type Executor = <T>(
  sql: string,
  params?: any[]
) => Promise<QueryObjectResult<T>>;
export type TransactionBodyFn<R> = (executor: Executor) => Promise<R>;

/**
 * Invokes a supplied function within a transaction.
 * @param body Function to invoke. If this throws, the transaction will be rolled
 * back. The thrown error will be re-thrown.
 * @param auth
 */
export async function transact<R>(body: TransactionBodyFn<R>, auth?: Payload) {
  return await withExecutor(async (executor) => {
    return await transactWithExecutor(executor, body, auth);
  });
}

async function transactWithExecutor<R>(
  executor: Executor,
  body: TransactionBodyFn<R>,
  auth?: Payload
) {
  for (let i = 0; i < 10; i++) {
    try {
      await executor("begin");
      try {
        if (auth) {
          await executor(`set local role = ${auth.role}`);
          await executor(
            `set local request.jwt.claims = '${JSON.stringify(auth)}'`
          );
        }
        const r = await body(executor);
        await executor("commit");
        return r;
      } catch (e) {
        await executor("rollback");
        throw e;
      }
    } catch (e) {
      if (shouldRetryTransaction(e)) {

        continue;
      }
      
      if (e.toString().includes("violates row-level security policy")) {
        console.log("row-level security policy violation - rolling back");
      } else {
        // this logs all errors caught, whether we retry or not
        console.log("caught error", e, "rolling back");
      }
      throw e;
    }
  }
  throw new Error("Tried to execute transaction too many times. Giving up.");
}

//stackoverflow.com/questions/60339223/node-js-transaction-coflicts-in-postgresql-optimistic-concurrency-control-and
function shouldRetryTransaction(err: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const code = typeof err === "object" ? String((err as any).code) : null;
  return code === "40001" || code === "40P01" || ((err as any).toString().includes("could not serialize access due to concurrent update")) || (err as any).toString().includes("Broken pipe");
}
