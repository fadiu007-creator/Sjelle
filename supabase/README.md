# Supabase environment

Sjelle is configured to use the existing Supabase project **zikos** (`saavqlbwffrwxingbnri`). Use only this repository-configured project. Do not create a new Supabase project or point Sjelle at another project unless the project owner explicitly changes the configuration.

The project is shared with other applications. Treat every migration as production-sensitive and keep all Sjelle database changes isolated:

1. Add or modify only Sjelle-owned objects (normally the `sjelle_*` tables, functions, policies, indexes and triggers) and Sjelle-owned storage resources such as the private `sjelle-driver-documents` bucket.
2. Never alter, rename, truncate, reset, seed, or drop objects or data belonging to Fiskalo, Dhuroje, Kafja, MikroTekos, Newchat or any other application.
3. Keep migrations additive and narrowly scoped. Do not use a broad schema rebuild or database reset against this shared project.
4. Apply migrations in order and verify the resulting migration version against the filename in this repository. If the migration tool assigns a different version, reconcile the filename before the next deployment.
5. Keep driver identity, licence, registration and insurance documents in private storage. Issue short-lived signed URLs only to authorized Sjelle administrators; never expose storage paths or service-role credentials.
6. Keep Supabase service-role keys and other provider credentials in Supabase/Cloudflare secrets. Never commit them.
7. Do not enable a city or service merely to make a test pass. Production availability requires the actual driver, vehicle, restaurant, payment and operational readiness checks to pass.

The API is served by the existing `sjelle-api` Supabase Edge Function. GitHub Actions validates the repository; database migrations and Edge Function deployment must target the same configured `zikos` project.
