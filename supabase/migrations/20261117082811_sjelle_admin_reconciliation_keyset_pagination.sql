-- Replace the reconciliation API's fixed 1,000-row read with a bounded keyset page.
-- The summary and page are calculated in one SQL statement so they share one MVCC snapshot.
create index if not exists sjelle_ledger_entries_created_at_id_idx
  on public.sjelle_ledger_entries (created_at desc, id desc);

create or replace function public.sjelle_admin_reconciliation_page(
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer,
  p_cursor_created_at timestamptz,
  p_cursor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_total_entries text;
  v_summary jsonb;
  v_data jsonb;
  v_has_more boolean;
  v_next_cursor jsonb;
begin
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception using errcode = '22023', message = 'INVALID_DATE_RANGE';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 250 then
    raise exception using errcode = '22023', message = 'INVALID_PAGE_SIZE';
  end if;
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_RECONCILIATION_CURSOR';
  end if;
  if p_cursor_created_at is not null
    and (p_cursor_created_at < p_from or p_cursor_created_at >= p_to) then
    raise exception using errcode = '22023', message = 'INVALID_RECONCILIATION_CURSOR';
  end if;

  with summary_groups as (
    select
      account_type,
      count(*)::text as entry_count,
      coalesce(sum(amount_cents), 0)::text as net_amount_cents
    from public.sjelle_ledger_entries
    where created_at >= p_from and created_at < p_to
    group by account_type
  ),
  summary_totals as (
    select count(*)::text as total_entries
    from public.sjelle_ledger_entries
    where created_at >= p_from and created_at < p_to
  ),
  summary_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'account_type', account_type,
          'entry_count', entry_count,
          'net_amount_cents', net_amount_cents
        ) order by account_type
      ),
      '[]'::jsonb
    ) as summary
    from summary_groups
  ),
  page_rows as (
    select
      id,
      related_ride_id,
      related_order_id,
      account_type,
      account_user_id,
      amount_cents::text as amount_cents,
      currency::text as currency,
      entry_type,
      idempotency_key,
      metadata,
      created_at
    from public.sjelle_ledger_entries
    where created_at >= p_from and created_at < p_to
      and (
        p_cursor_created_at is null
        or (created_at, id) < (p_cursor_created_at, p_cursor_id)
      )
    order by created_at desc, id desc
    limit (p_limit + 1)
  ),
  visible_rows as (
    select *
    from page_rows
    order by created_at desc, id desc
    limit p_limit
  ),
  page_state as (
    select count(*) > p_limit as has_more
    from page_rows
  ),
  page_json as (
    select coalesce(
      jsonb_agg(to_jsonb(v) order by v.created_at desc, v.id desc),
      '[]'::jsonb
    ) as data
    from visible_rows v
  ),
  last_visible as (
    select created_at, id
    from visible_rows
    order by created_at asc, id asc
    limit 1
  )
  select
    totals.total_entries,
    summary.summary,
    page.data,
    state.has_more,
    case
      when state.has_more then (
        select jsonb_build_object('created_at', created_at, 'id', id)
        from last_visible
      )
      else null
    end
  into v_total_entries, v_summary, v_data, v_has_more, v_next_cursor
  from summary_totals totals
  cross join summary_json summary
  cross join page_json page
  cross join page_state state;

  return jsonb_build_object(
    'data', v_data,
    'summary', v_summary,
    'meta', jsonb_build_object(
      'total_entries', v_total_entries,
      'returned', jsonb_array_length(v_data),
      'limit', p_limit,
      'has_more', v_has_more,
      'next_cursor', v_next_cursor
    )
  );
end;
$function$;

revoke all on function public.sjelle_admin_reconciliation_page(timestamptz, timestamptz, integer, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.sjelle_admin_reconciliation_page(timestamptz, timestamptz, integer, timestamptz, uuid)
  to service_role;

comment on function public.sjelle_admin_reconciliation_page(timestamptz, timestamptz, integer, timestamptz, uuid)
  is 'Returns a bounded keyset page of Sjelle cash ledger entries and exact full-period totals for the authenticated admin API.';
