# Sjelle administratori — udhëzues operativ

## Hyrja në panel

Paneli është i ndarë nga faqja e klientit:

- [Paneli i administratorit](https://fadiu007-creator.github.io/Sjelle/admin/)
- [Aplikimet e shoferëve](https://fadiu007-creator.github.io/Sjelle/admin/#driver-applications)
- [Aplikimet e restoranteve](https://fadiu007-creator.github.io/Sjelle/admin/#restaurant-applications)

Nëse paneli tregon **UNAUTHENTICATED**, kliko **Kyçu si administrator** brenda vetë panelit. Kyçu në atë rrjedhë dhe sistemi të kthen automatikisht te paneli. Sesioni i aplikacionit ruhet në kontekstin e së njëjtës skedë të shfletuesit; hyrja në një skedë tjetër nuk e transferon automatikisht sesionin.

Nëse shfaqet **FORBIDDEN**, llogaria është autentikuar, por nuk ka rolin `admin` në `public.sjelle_user_roles`. Roli nuk jepet nga formulari i aplikacionit. Pronari i projektit duhet të ndjekë [procedurën e sigurt first-admin](../supabase/operations/first-admin.sql) me email-in e saktë të një llogarie të konfirmuar. Mos vendos kurrë çelësa service-role në shfletues.

## Aplikimet e shoferëve

Paneli ngarkon vetëm radhët me status `pending` (deri në 100 hyrje për secilin grup):

1. **Dokumentet** — hap dokumentin përmes lidhjes së nënshkruar, me afat të shkurtër; kontrollo identitetin, lejen e drejtimit, qartësinë dhe datën e skadimit.
2. **Automjetet** — kontrollo dokumentet e regjistrimit, targat dhe vlefshmërinë e dokumenteve të automjetit.
3. **Aplikimi i shoferit** — aprovo vetëm pasi kontrollet e kërkuara të dokumenteve dhe automjetit të jenë përfunduar. API-ja e serverit mbetet autoritative dhe refuzon aprovimin kur mungojnë parakushtet.

Refuzo dokumentet e palexueshme ose të pavlefshme dhe shëno arsyen. Mos aprovo shoferë për të testuar ndërfaqen.

## Aplikimet e restoranteve

Kontrollo emrin, adresën, telefonin dhe lokacionin përpara vendimit. Aprovimi i aplikimit **nuk e hap restorantin**: restoranti mbetet i mbyllur derisa pronari të konfigurojë menunë dhe shërbimet.

## Nëse lista është bosh

Lista bosh do të thotë se API-ja nuk ktheu aplikime me status `pending`; nuk krijohen aplikime demonstrative. Verifiko që aplikanti e ka përfunduar dërgimin dhe që regjistrimi ekziston në projektin Supabase të Sjelle. Nëse ka rreshta por paneli nuk i ngarkon, përdor **Rifresko** dhe kontrollo mesazhin e gabimit; mos e anashkalo autorizimin.
