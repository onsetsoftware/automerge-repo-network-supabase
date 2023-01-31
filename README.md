# Automerge Repo Network Supabase

A Supabase network adapter for [automerge-repo](https://github.com/automerge/automerge-repo). It comprises a client library for the browser and a Deno package for use in a Supabase edge function.

> **Warning**
> This package is under active development and is not quite ready for production use. However, it is fully intended to be used in production soon. Please feel free to try it out and report any issues you find.

## Client

### Installation

```bash
npm install @onsetsoftware/automerge-repo-network-supabase
```

### Usage

```typescript

import { SupabaseNetworkAdapter } from '@onsetsoftware/automerge-repo-network-supabase';
import { createClient } from "@supabase/supabase-js";
export { v4 as uuid } from "uuid";

// create a supabase client with your public URL and anon key
const supabase = createClient({SUPABASE_PUBLIC_URL}, {SUPABASE_ANON_KEY});

// create a network adapter with the supabase client and the name of supabase edge function you are using
const supabaseAdapter = new SupabaseNetworkAdapter(supabase, "changes");

// pass the adapter to the repo
const repo = new Repo({
  storage: new LocalForageStorageAdapter(),
  network: [
    supabaseAdapter,
  ],
  // we need to use uuids as the peerId is stored as a uuid type in the database
  peerId: uuid() as PeerId
});

// use the repo as normal
```

## Edge Function

### Usage

```typescript

import { serve } from "https://deno.land/std@0.175.0/http/server.ts"

import { defaultCorsHeaders, handleRequest } from "https://deno.land/x/automerge_repo_network_supabase@v0.1.0/mod.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: defaultCorsHeaders });
  }
  
  return handleRequest(req);
});

```

## Database Setup

You will need to create a documents table in your Supabase database and ensure that realtime replication is enabled.

An example migration file can be found in the [migration.example.sql](./migration.example.sql) file.
