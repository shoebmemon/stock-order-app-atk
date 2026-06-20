-- Run this in the Supabase SQL Editor

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.stocks(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  quantity numeric not null default 1,
  status text not null default 'active',  -- 'active' or 'completed'
  created_at timestamp with time zone default now()
);

-- Enable Row Level Security (recommended even for a single-shop app)
alter table public.stocks enable row level security;
alter table public.suppliers enable row level security;
alter table public.orders enable row level security;

-- Allow the anon key full read/write access (no login system in this app)
-- If you'd rather lock this down later with auth, we can tighten these.
create policy "Allow all access to stocks" on public.stocks
  for all using (true) with check (true);

create policy "Allow all access to suppliers" on public.suppliers
  for all using (true) with check (true);

create policy "Allow all access to orders" on public.orders
  for all using (true) with check (true);
