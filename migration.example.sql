begin;
-- remove the supabase_realtime publication
drop publication if exists supabase_realtime;

-- re-create the supabase_realtime publication with no tables
create publication supabase_realtime;
commit;

CREATE EXTENSION IF NOT EXISTS moddatetime
    SCHEMA extensions
    VERSION "1.0";

CREATE TABLE IF NOT EXISTS public.documents
(
    id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT (now() AT TIME ZONE 'utc'::text),
    updated_at timestamp with time zone DEFAULT (now() AT TIME ZONE 'utc'::text),
    changed boolean,
    updated_by_peer uuid,
    data bytea,
    CONSTRAINT documents_pkey PRIMARY KEY (id)
)

    TABLESPACE pg_default;

ALTER TABLE IF EXISTS public.documents
    OWNER to postgres;

GRANT ALL ON TABLE public.documents TO anon;

GRANT ALL ON TABLE public.documents TO authenticated;

GRANT ALL ON TABLE public.documents TO postgres;

GRANT ALL ON TABLE public.documents TO service_role;

CREATE TRIGGER handle_updated_at
    BEFORE UPDATE
    ON public.documents
    FOR EACH ROW
EXECUTE FUNCTION extensions.moddatetime('updated_at');

alter publication supabase_realtime add table documents;

-- enable row level security
alter table "public"."documents" enable row level security;

-- add a policy to allow anyone to view and edit documents
-- this is the default policy, but it's here for reference
-- Something less permissive should be used for production

create policy "Anyone can edit and view documents."
    on "public"."documents"
    as permissive
    for all
    to authenticated, anon
    using (true);

-- make sure that postgres can set local roles for RLS
grant anon, authenticated to postgres;
