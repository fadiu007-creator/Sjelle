# Supabase environments

Sjelle must use a dedicated Supabase project. Do not use the existing `zikos` project or any database shared with Dhuroje, Kafja, or other unrelated apps.

1. Confirm the Supabase organization and region with the project owner.
2. Create a development project first; use a separate production project for launch.
3. Store project URL and publishable key in local environment files / Cloudflare bindings as appropriate. Never commit secrets.
4. Apply migrations in order using the Supabase CLI or reviewed migration workflow.
5. Run security advisors and RLS integration tests before deploying.
6. Do not seed real people, documents, locations, orders or payment information in development.
7. Configure private storage for driver identity/licence/vehicle documents. Use authorized short-lived signed URLs.
8. Keep all six launch cities inactive until verified operational readiness.

The current migration is a design starter and must be reviewed, tested and expanded before production. It has not been applied to any project.
