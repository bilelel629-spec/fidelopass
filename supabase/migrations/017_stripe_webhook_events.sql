create table if not exists public.stripe_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  event_type text not null,
  status text not null default 'processing' check (status in ('processing', 'processed', 'failed')),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_stripe_webhook_events_status
  on public.stripe_webhook_events(status);

create index if not exists idx_stripe_webhook_events_created_at
  on public.stripe_webhook_events(created_at desc);

alter table public.stripe_webhook_events enable row level security;

drop policy if exists "service role full access stripe webhook events" on public.stripe_webhook_events;
create policy "service role full access stripe webhook events"
  on public.stripe_webhook_events
  using (true)
  with check (true);
