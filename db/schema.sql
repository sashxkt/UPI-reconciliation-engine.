-- upi-reconciliation schema (PostgreSQL 16)
-- All money is in paise (bigint). All timestamps are timestamptz.

create table bills (
  id           bigserial primary key,
  reference    text not null unique,
  patient_name text not null,
  amount_paise bigint not null check (amount_paise > 0),
  status       text not null default 'pending'
               check (status in ('pending', 'paid', 'refunded', 'cancelled')),
  created_at   timestamptz not null default now(),
  paid_at      timestamptz
);

-- Every webhook we accept, stored as it came in.
-- The unique provider_event_id is duplicate guard #1.
create table webhook_events (
  id                bigserial primary key,
  provider_event_id text not null unique,
  event_type        text not null,
  payload           jsonb not null,
  result            text,
  received_at       timestamptz not null default now()
);

-- One row per financial year ('2026-27'). Its row lock is what makes
-- receipt numbers come out one at a time with no gaps.
create table receipt_counters (
  fy      text primary key,
  last_no integer not null
);

-- Money that matched a bill. The unique utr is duplicate guard #2.
create table payments (
  id           bigserial primary key,
  bill_id      bigint not null unique references bills (id),
  utr          text not null unique,
  amount_paise bigint not null check (amount_paise > 0),
  payer_vpa    text,
  paid_at      timestamptz not null,
  receipt_fy   text not null,
  receipt_no   integer not null,
  source       text not null check (source in ('webhook', 'reconciliation')),
  created_at   timestamptz not null default now(),
  unique (receipt_fy, receipt_no)
);

-- Money that fits no bill. A human has to look at these.
create table unmatched_payments (
  id           bigserial primary key,
  utr          text not null unique,
  amount_paise bigint not null,
  reference    text,
  payer_vpa    text,
  paid_at      timestamptz not null,
  reason       text not null
               check (reason in ('unknown_reference', 'amount_mismatch', 'double_payment')),
  source       text not null check (source in ('webhook', 'reconciliation')),
  created_at   timestamptz not null default now()
);

create table audit_log (
  id           bigserial primary key,
  action       text not null,
  bill_id      bigint,
  utr          text,
  amount_paise bigint,
  details      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);

create function audit_log_is_append_only() returns trigger as $$
begin
  raise exception 'audit_log is append-only: % is not allowed', tg_op;
end;
$$ language plpgsql;

create trigger audit_log_no_changes
  before update or delete on audit_log
  for each row execute function audit_log_is_append_only();

create table recon_runs (
  id              bigserial primary key,
  settlement_date date not null,
  bank_lines      integer not null,
  summary         jsonb not null,
  created_at      timestamptz not null default now()
);

create table recon_items (
  id                bigserial primary key,
  run_id            bigint not null references recon_runs (id),
  utr               text not null,
  status            text not null check (status in (
                      'matched', 'recovered', 'amount_mismatch',
                      'unmatched_known', 'not_in_settlement')),
  bank_amount_paise bigint,
  our_amount_paise  bigint,
  reference         text,
  note              text
);

create index recon_items_run_id on recon_items (run_id);
create index payments_paid_at on payments (paid_at);
create index unmatched_payments_paid_at on unmatched_payments (paid_at);
