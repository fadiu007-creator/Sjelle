# Sjelle architecture decisions

## ADR-001 — Cloudflare hosting
**Decision:** Cloudflare Pages for web portals and Cloudflare Workers for API endpoints. Vercel is excluded.

## ADR-002 — Dedicated Supabase project
**Decision:** Sjelle must use its own Supabase project(s), not the existing `zikos` project or databases belonging to other apps. Development is provisioned first; production is separate before launch.

## ADR-003 — One brand, multiple surfaces
**Decision:** One Sjelle customer brand/app for rides and food; a separate driver app with Ride/Delivery mode switch; merchant and admin web portals.

## ADR-004 — Cash-first MVP
**Decision:** Cash for rides and food at launch. Online payments remain out of scope until provider support in Kosovo, refund lifecycle and settlement reconciliation are verified.

## ADR-005 — Conservative direct database access
**Decision:** Exposed tables have RLS. Client writes to high-impact entities (rides, orders, assignments, payment/ledger entries, approvals) are server-only until narrowly scoped transactional APIs are implemented and tested.

## ADR-006 — City activation gates
**Decision:** Seed Prishtina, Ferizaj, Prizren, Gjilan, Mitrovica and Peja as inactive. City/service activation requires supply, coverage, legal, support and pricing readiness.
