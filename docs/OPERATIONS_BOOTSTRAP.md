# Sjelle operations bootstrap

This guide is for the project owner. The operations portal is at `/admin/` once the Cloudflare Worker and customer assets have been deployed.

## 1. Configure secrets and providers

For both staging and production Worker environments, set:

- `SUPABASE_URL=https://saavqlbwffrwxingbnri.supabase.co`
- `SUPABASE_PUBLISHABLE_KEY` as a non-secret Worker variable
- `SUPABASE_SERVICE_ROLE_KEY` as a secret
- `ALLOWED_ORIGIN` to the exact public origin serving the customer site
- `ROUTING_API_URL` to an OSRM-compatible routing service base URL
- `GEOCODING_API_URL` to a Nominatim-compatible geocoding service base URL
- `ROUTING_API_KEY` and `GEOCODING_API_KEY` as secrets if required by the providers

Do not use a public demo router for production traffic. The customer ride quote flow fails closed if accurate route distance/time cannot be obtained. Geocoding and routing providers must be configured before address-based ride quotes work.

## 2. Assign the first administrator

1. Create and verify your own customer account through the main Sjelle website.
2. In Supabase SQL Editor for the existing `zikos` project, replace the placeholder email below with the exact email used by that account and run:

```sql
insert into public.sjelle_user_roles (user_id, role)
select id, 'admin'
from auth.users
where lower(email) = lower('REPLACE_WITH_YOUR_VERIFIED_EMAIL')
on conflict (user_id, role) do nothing;
```

3. Sign in again and open `/admin/`.

This role is stored in the database. Do not grant it from user-editable signup metadata or expose service-role credentials in a browser.

## 3. Configure city pricing

For each city, use **Operations → Tarifat dhe shërbimet**:

1. Enter actual approved delivery fee, service fee, minimum order and ride pricing in euro (the API stores integer euro cents).
2. Use a new pricing version when prices change.
3. Activate the pricing record only after the values are reviewed.
4. Create fixed routes with reviewed endpoints, coordinates, vehicle type and fare. New routes start inactive.
5. Activate each route only after checking both endpoints and the fare.

No sample fares are seeded, because they would be real customer prices if accidentally activated.

## 4. Onboard restaurants

1. A restaurant owner creates an account and applies at `/merchant/`.
2. Admin reviews the application and approves it. Approval does not open the restaurant automatically.
3. The owner adds categories and menu items with real prices.
4. After the city is active and has active food pricing, the owner turns on the restaurant and delivery setting.
5. Check the menu and address before accepting real orders.

## 5. Onboard drivers

1. Applicant creates an account, applies at `/driver/`, registers a vehicle and uploads identity, driving licence, vehicle registration and insurance.
2. Admin opens each private document through its five-minute signed URL and reviews the document and vehicle separately.
3. Approve the driver only after all four document types are approved and at least one vehicle is approved.
4. Activate the city only after there is at least one approved driver and a configured active route for rides, or an approved restaurant with a menu for food.
5. After city activation, the driver can go online and send current location. Dispatch offers expire after 45 seconds and the Cloudflare scheduled recovery checks waiting jobs every minute.

Driver documents are stored in the private `sjelle-driver-documents` bucket. Signed URLs are short-lived and issuing them is audit-logged.

## 6. City activation order

A safe initial sequence is:

1. Configure and activate pricing.
2. Approve at least one restaurant and have it publish a menu, and/or approve drivers and create at least one active fixed route.
3. Use the explicit city activation form, tick the readiness confirmation and write the operational checks completed.
4. Have the restaurant owner enable service and drivers go online.
5. Test with a controlled account before public marketing.

Cities remain inactive by default. No city or service is activated by these setup steps automatically.

## Current payment limitation

Only cash is enabled. Online payment processing, refunds, settlement and automated cash reconciliation are not implemented. Do not advertise card or wallet payment until a payment provider and reconciliation workflow have been integrated and tested.
