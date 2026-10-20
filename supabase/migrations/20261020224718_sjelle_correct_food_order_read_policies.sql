-- Restrict food order and item visibility to actual order participants.
drop policy if exists sjelle_food_orders_select_participant on public.sjelle_food_orders;
create policy sjelle_food_orders_select_participant
on public.sjelle_food_orders
for select
to authenticated
using (
  customer_id = (select auth.uid())
  or exists (
    select 1 from public.sjelle_restaurants r
    where r.id = sjelle_food_orders.restaurant_id
      and r.owner_id = (select auth.uid())
  )
  or exists (
    select 1 from public.sjelle_restaurant_staff rs
    where rs.restaurant_id = sjelle_food_orders.restaurant_id
      and rs.user_id = (select auth.uid())
      and rs.can_manage_orders = true
  )
  or exists (
    select 1 from public.sjelle_delivery_jobs dj
    where dj.order_id = sjelle_food_orders.id
      and dj.driver_id = (select auth.uid())
  )
);

drop policy if exists sjelle_food_order_items_select_participant on public.sjelle_food_order_items;
create policy sjelle_food_order_items_select_participant
on public.sjelle_food_order_items
for select
to authenticated
using (
  exists (
    select 1 from public.sjelle_food_orders o
    where o.id = sjelle_food_order_items.order_id
      and (
        o.customer_id = (select auth.uid())
        or exists (
          select 1 from public.sjelle_restaurants r
          where r.id = o.restaurant_id and r.owner_id = (select auth.uid())
        )
        or exists (
          select 1 from public.sjelle_restaurant_staff rs
          where rs.restaurant_id = o.restaurant_id
            and rs.user_id = (select auth.uid())
            and rs.can_manage_orders = true
        )
        or exists (
          select 1 from public.sjelle_delivery_jobs dj
          where dj.order_id = o.id and dj.driver_id = (select auth.uid())
        )
      )
  )
);
