-- Index the Sjelle cash-handover administrator foreign key for efficient auth-user checks/deletes.
create index if not exists sjelle_cash_handovers_received_by_idx
  on public.sjelle_cash_handovers (received_by);
