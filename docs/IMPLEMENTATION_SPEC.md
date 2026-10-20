# Sjelle — MVP implementation specification

## 1. Product definition

Sjelle is a single-brand Kosovo ride-hailing and restaurant-delivery platform. Customer uses one app for rides and food. Drivers use one app and explicitly select Ride or Delivery mode. Merchant and admin web portals share the Sjelle API and an isolated `sjelle_*` data namespace in the existing `zikos` Supabase project.

### Locked decisions
- Cities: Prishtina, Ferizaj, Prizren, Gjilan, Mitrovica, Peja. Seeded as planned/inactive; activate independently after readiness checks.
- Rides: fixed configured prices for popular origin/destination routes; otherwise server-calculated estimates using route distance and duration.
- Payments: cash for rides and food in MVP; online payments later after Kosovo provider, refund, settlement, webhook and reconciliation validation.
- Food dispatch: after restaurant acceptance; use prep-time estimate to time courier assignment.
- Driver verification: identity, driving licence and vehicle documents reviewed by authorized admin before activation.
- Hosting: Cloudflare Pages/Workers. Existing Supabase project `zikos` (`saavqlbwffrwxingbnri`) by explicit owner choice; all Sjelle objects use `sjelle_` names, and migrations must be additive only. No Vercel.

## 2. Roles and authorization
- Customer: manages own profile, rides, orders, addresses, ratings and support tickets.
- Driver: sees own profile/documents/earnings and only job offers or active jobs assigned to them.
- Merchant staff: accesses only assigned restaurant(s), menus and their orders.
- Support operator: handles assigned support work, limited access to personal data.
- Admin: manages city/service configuration, approvals, fares, refunds and incidents. Sensitive actions are audited.
- System service: executes trusted matching, status transitions, ledger postings and notification jobs.

Authorization must be enforced server-side and by RLS. Never authorize using user-editable user metadata. No client can set their own role, verification state, fare, commission, payment status or assignment.

## 3. P0 user stories
1. As a customer, I can sign up, verify contact details and manage language/preferences.
2. As a customer, I can choose an active city and save pickup/delivery addresses.
3. As a customer, I can get a ride quote, see fixed popular-route prices where configured, and request a ride.
4. As a driver, I cannot go online until identity, licence and vehicle checks are approved and unexpired.
5. As a driver, I can choose Ride or Delivery mode while idle and receive eligible offers for that mode only.
6. As a driver, I cannot accept conflicting jobs; server transaction allows only one incompatible assignment.
7. As a customer, I can browse open approved restaurants, see current menu prices and place a cash food order.
8. As a merchant, I can accept/reject orders, set prep time, mark ready and temporarily disable items.
9. As the platform, I dispatch delivery only after restaurant acceptance and respect prep-time estimates.
10. As a customer, I can track the current ride/order and see reliable status after reconnect.
11. As a customer/driver/merchant, I can see only records permitted for my role.
12. As an operator, I can review verification documents, activate cities, configure prices and investigate incidents.
13. As finance/admin, I can reconcile cash, commissions, driver earnings and merchant payable balances.
14. As a user, I can report a safety or order issue and receive a traceable support case.

## 4. P1 stories
- Ratings and reviews, promo codes with funding attribution, scheduled rides, delivery batching, saved payment methods/online payments, merchant settlement exports, analytics and multilingual Serbian UI.
- P1 features are not allowed to delay secure P0 ride/order completion.

## 5. Ride workflow
requested -> searching -> driver_assigned -> driver_arriving -> driver_arrived -> in_progress -> completed.
Terminal alternatives: cancelled_by_customer, cancelled_by_driver, cancelled_by_platform, no_driver_found.
All transitions are server validated and recorded as events. Completion requires an active trip and permitted actor. Quotes have expiry and pricing-version reference. Popular route prices are keyed by city and normalized route endpoints; all other estimates use routing-provider distance/duration. Final charge rules must be disclosed.

## 6. Food workflow
submitted -> accepted -> preparing -> ready_for_pickup -> courier_assigned -> picked_up -> delivered.
Terminal alternatives: rejected, cancelled, delivery_failed, refunded (payment lifecycle is separate).
Checkout revalidates menu availability and price server-side, snapshots item labels/options/prices, validates address against service coverage, and calculates fees in integer cents. Restaurant rejection/timeout triggers customer notification and a cancellation/refund workflow. Courier is assigned only after acceptance; prep-time informs dispatch timing.

## 7. Driver mode and dispatch
- Driver states: pending_review, approved, suspended, rejected; availability offline/online/busy.
- Modes: ride, delivery. Mode can change only while idle and with no active incompatible job.
- Offer expiry and re-offer are server controlled.
- Assignment must be atomic and idempotent; unique/transactional guard prevents conflicting active assignments.
- Eligibility checks include approval, document expiry, vehicle/service type, city/service area, online state, mode and location freshness.
- Delivery batching is out of MVP scope.

## 8. Pricing and cash ledger
- Store money as integer EUR cents; currency is EUR.
- Fixed route fare applies only when an active matching route rule exists. Else quote = max(minimum fare, base + distance_km * rate_per_km + duration_min * rate_per_min), with all rounding rules centralized and tested.
- Food total = item subtotal + disclosed delivery fee + disclosed service/other charges - discounts. Merchant commission is accounted separately.
- Each quote/order stores a pricing-rule version/snapshot.
- Cash is not “free”: record amount collected, collector, commission, driver payable, merchant payable, outstanding balance and reconciliation state.
- Ledger entries are append-only; correction uses reversal/adjustment entries. No card data is stored.

## 9. API and architecture
- React Native + Expo for customer and driver apps.
- React/TypeScript merchant and admin portals.
- Cloudflare Pages for static web apps; Cloudflare Workers for secure API.
- Dedicated Supabase PostgreSQL/Auth/Realtime/Storage.
- Map/routing provider chosen after Kosovo address coverage, route quality, background GPS and cost testing.
- Push notification provider chosen before device pilot.
- Keep domain modules separate: identity, cities, rides, food, dispatch, pricing, payments/ledger, notifications, support/safety.
- Workers use server-only secrets. Client contains only public/publishable Supabase key. Sensitive writes use trusted API/RPC and database constraints.
- Use request idempotency keys for order creation, ride requests, assignment, ledger posting and payment events.

## 10. Security and privacy
- RLS enabled for every exposed table. Policies are role- and relationship-specific, not just authenticated checks.
- Private driver-document bucket; short-lived signed URLs after authorization. Never expose document keys publicly.
- Driver GPS shared only for operational need, with defined retention; stop unnecessary tracking offline/completed.
- Admin changes to pricing, approvals, refunds, balances and suspensions are audited.
- Rate limit authentication, ride/order creation, offers, support and promo redemption.
- Backups, restore drill, incident runbook, monitoring and secret rotation required.
- Validate applicable Kosovo transport/taxi, vehicle/driver, food-business, tax, consumer, insurance and personal-data obligations with qualified local advisers before live operations.

## 11. Acceptance and release gates
- Duplicate taps/retries never create duplicate rides/orders/ledger effects.
- Two drivers cannot own one job; one driver cannot hold conflicting active jobs.
- Expired/unapproved driver documents block activation and dispatch.
- Stale carts revalidate prices and availability.
- Users cannot access another user's trip/order/document; merchants are scoped to their own stores.
- GPS disconnect/reconnect restores authoritative status and never fabricates completion.
- Cash reports reconcile with completed jobs, commissions and merchant payable.
- Restaurant rejection and all cancellation paths have defined customer notification and financial handling.
- All six cities remain disabled until supply, service areas, support, legal checks and pricing are ready.

## 12. Milestones
M0 — repository/tooling and architecture: pinned dependencies, environment templates, CI, code ownership, threat model.
M1 — dedicated Supabase development project: migrations, RLS tests, storage policies, generated types, seed cities inactive.
M2 — identity/admin foundation: profiles, roles, merchant/driver applications, document review, city activation.
M3 — food vertical: menus, cart/checkout, cash order, merchant accept/reject, courier dispatch, delivery tracking.
M4 — ride vertical: route quote, fixed-route rules, ride matching, GPS, trip lifecycle, cash accounting.
M5 — shared driver app: mode switch, eligibility, exclusive assignments, earnings and support.
M6 — integration/security: E2E tests, abuse cases, reconciliation, backup restore, monitoring, device tests.
M7 — controlled pilot: launch only operationally ready cities; review metrics and expand city-by-city.

Indicative duration: several months for a small team; estimates depend on staffing, provider selection and compliance. No schedule is a guarantee.

## 13. Launch checklist
- [ ] Dedicated dev and production Supabase projects in chosen organization/region; do not reuse existing `zikos`.
- [ ] Cloudflare environments and secret bindings; no Vercel.
- [ ] Migration replay and RLS tests pass.
- [ ] Verified driver, vehicle and merchant onboarding.
- [ ] Kosovo legal, insurance, tax, privacy and consumer checks completed.
- [ ] Restaurant menus, opening hours and service areas verified.
- [ ] Map provider tested in all proposed cities.
- [ ] Cash collection, commission and merchant/driver balance reconciliation tested.
- [ ] Support coverage, incident response and cancellation/refund policies operational.
- [ ] E2E ride and delivery tests on real Android devices.
- [ ] Monitoring, backups and restore test verified.
- [ ] City enabled only after operational readiness sign-off.
