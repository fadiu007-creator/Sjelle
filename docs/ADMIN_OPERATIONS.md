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

## Gjendja e të gjithë shoferëve

Seksioni **Gjendja e të gjithë shoferëve** nuk është vetëm radhë aprovimi: ai përfshin profilet në pritje, të aprovuara dhe të refuzuara. Për secilin profil shfaq statusin e aplikimit, modalitetin, gjendjen online/offline, statusin më të fundit për secilin nga katër dokumentet e detyrueshme dhe statusin e automjeteve të regjistruara.

- Dokumenti më i ri sipas `created_at` dhe, kur koha është e barabartë, sipas ID-së zëvendëson statusin e dokumentit të vjetër.
- Dokumentet ose regjistrimet e automjeteve të skaduara shfaqen si **Skaduar**; mungesa shfaqet si **Mungon**.
- **Evidencë e plotë** do të thotë vetëm katër dokumentet e kërkuara të aprovuara dhe të vlefshme plus të paktën një automjet të aprovuar e të vlefshëm. Kjo nuk garanton GPS të freskët, qytet/shërbim aktiv, modalitet të saktë, mungesë udhëtimi aktiv ose gatishmëri për caktim.
- Pamja administrative përdor lexime të kufizuara në 1,000 rreshta për burim. Nëse shfaqet paralajmërimi për listë të pjesshme, mos e trajto pamjen si inventar të plotë; kërkohet faqëzim për instalime me shumë shoferë.
- Kjo pamje nuk jep aprovime automatike dhe nuk ndryshon asnjë dokument, automjet ose status shoferi.
