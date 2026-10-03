# AZxAI Navigator — Integration Map

## Live Stripe objects (created 2026-10-03, Axiom Zeta Innovations, livemode)

- Product: `prod_VNKIz0AJgpvVyB` (AZxAI Navigator)
- Price: `price_1UMZdVRuE1b4AX4Ji11xH0AM` — $74.99 USD / month, recurring
- Payment Link: `plink_1UMZdjRuE1b4AX4J9v7ftjmV` — https://buy.stripe.com/14A7sNcsM1gzf6SfBv18c0d
  - Link metadata and `subscription_data.metadata` both carry `product=navigator`, as the webhook bridge expects.
  - Buyers must arrive with `?client_reference_id=<tenantId>` appended (the app does this) so grants attribute to the right tenant.
- Still to create: webhook endpoint (after hosting) for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` → `POST /api/billing/stripe/webhook`. with aichangeradar.com

**Date:** 2026-10-03 · **Status:** proposal for Zebulon's decisions (no repo created, nothing pushed)
**Navigator:** standalone project at `~/workspace/projects/azxai-navigator` (extracted from `A.I.-Change-Radar` nested `thoth-a.i.-time-oracle-main/`, head `4a09888b`)
**Service:** AI Change Radar — `~/workspace/projects/ai-change-radar` (Next.js, live at https://www.aichangeradar.com)
**Product shape (decided):** Navigator is a *second, separate service* at **$74.99/mo**, companion to the Radar subscription (Radar 5 $29 / Radar 15 $79 / Unlimited $199 on Shopify). Radar finds and verifies changes; Navigator answers "does this change hit *us*, what do we do, and did it work?"

## What Navigator already is (baseline summary)
Express 5 + React 19 app, better-sqlite3 (17 tables), cookie-session auth (hashed tokens, scrypt passwords, attempt throttling, origin-checked mutations), HMAC billing webhook + entitlements table, and a full decision workflow: vendor snapshots → change evidence → published changes → exposure matching against the tenant's workflow/inventory graph (dependency traversal with cycle detection) → decisions → action plans with approvals → outcomes, plus rehearsal (simulation) sandbox kept strictly out of the real feed. Its change feed sits behind a `ChangeFeedAdapter` interface (`server/radar.ts`, today `LocalPipelineAdapter` reading its own DB) — **that interface is the integration seam**. Verified standalone: tests 27/27 pass, build OK, `tsc` clean, production boot fails fast without `BILLING_WEBHOOK_SECRET`/`APP_URL` (by design) and serves `/api/health` with them set. `npm ci` needed `--nodedir=/usr` on this VM (node-gyp header download is blocked here); standard CI is unaffected.

## (a) Briefs — what Navigator consumes
Service data available today:
- `data/briefs/latest.json` — `{ weekOf, generatedAt, draft, items[] }`; item = `{ id, vendorId, vendorName, kind (deprecation|pricing|product|security), severity (act|note|fyi), headline, whatChanged, nextStep, whoIsAffected, sourceLabel, sourceUrl, detectedAt }`.
- `data/pipeline/queue.json` — owner review queue entries `{ item, origin, polished, status }` (internal; not customer-facing).

Navigator should consume **published brief items only** — never the raw queue. Mapping: service item → Navigator `change_evidence` + `published_changes` rows, preserving `id` as the external key (idempotent re-ingest), `severity=act` → priority evidence, `sourceUrl/sourceLabel` → citation fields Navigator's critique displays already expect.
Cadence: weekly pull aligned to the service's Monday run, plus an on-demand "check now" pull (Navigator already has that UX pattern).

## (b) Account & vendor state — mapping a Navigator user to a service subscription
- **Identity:** Navigator keeps its own tenants/users/sessions (its auth is solid; don't rip it out). Linkage is by **Shopify customer**: when a customer buys Navigator ($74.99/mo product on the same Axiom Zeta Innovations store), the subscription email + Shopify customer id become the join key.
- **Linking flow (proposed):** in Navigator, "Connect your AI Change Radar account" → enter the email used at Radar checkout → service emails a one-time link code → Navigator stores `service_tenant_ref` (opaque id, not the email) + link status. No shared passwords, no session sharing across domains.
- **Entitlement rules:** Navigator active ⟺ its own Shopify subscription active. Radar subscription is *not* required to buy Navigator, but without linked Radar selections Navigator falls back to its own vendor/workflow onboarding (it has one). With a link, the service's onboarding selections (industry + tracked vendors, per Radar tier limit) become the default vendor set; Navigator workflows/inventory remain Navigator-side data.
- **Vendor state sync:** one-way, service → Navigator (vendors/industry are service-owned). Workflows, exposure inventory, decisions, outcomes are Navigator-owned and never written back.

## (c) Alerts — from act-severity changes to companion alerts
Pipeline: service `act` item → Navigator ingest → exposure matching against the tenant's workflow graph → alert only on `direct` or `possible` match (Navigator's matcher already separates direct/possible/insufficient-data and never treats missing inventory as "no exposure").
Channels (proposed order): (1) in-app alert inbox + badge (Navigator UI), (2) email via its existing adapter pattern for `direct` matches with an effective date ≤ 30 days, (3) weekly digest section "changes needing decisions". `note`/`fyi` items never alert; they appear in the brief view only. Each alert carries: headline, vendor, effective date if any, match rationale, deep link to the Navigator decision screen, and the service's source citation. Dedupe on service item `id`; re-alert only if severity escalates or the effective date moves.

## (d) What stays web-only on the service
Checkout/subscription management (Shopify), onboarding + vendor selection editing, the public sample brief and marketing pages, the owner review queue and source registry/pipeline operations, brief generation/polish. Navigator links out to the service for plan changes ("Manage subscription" → aichangeradar.com account/checkout), never reimplements billing UX beyond its own $74.99 entitlement state.

## (e) Proposed API contract (service must add; all under `/api/v1`, JSON)
Auth: per-link bearer token issued at link time (`Authorization: Bearer <token>`, hashed at rest on the service, revocable from both sides), scoped to one tenant. Rate-limit modestly; all endpoints read-only from Navigator's perspective except link/revoke.
- `GET /api/v1/briefs/latest` → the published brief object above (post owner-approval state only; `draft:false` content) + `ETag`/`since` support: `GET /api/v1/changes?since=<iso>` returns items new/changed since a timestamp for incremental ingest.
- `GET /api/v1/account` → `{ tenantRef, email, industry, vendors: [{id, name}], tier, subscriptionStatus }` for the linked tenant.
- `POST /api/v1/link/verify` `{ code }` → `{ tenantRef, token }` (one-time code from the linking email; code single-use, short-lived).
- `POST /api/v1/link/revoke` → invalidates the token (callable from either side).
Service-side work: a small token store (new table or JSON store beside pipeline data), the four endpoints, and emitting `published` state distinctly from the draft brief. Navigator-side work: a `ServiceFeedAdapter implements ChangeFeedAdapter` (fetch + map + ingest), link UI, alert rules on ingest.

## (f) Extraction steps & repo-readiness gaps
Done: standalone copy at `~/workspace/projects/azxai-navigator` (source, package files, docs; `node_modules`/`dist`/`*.sqlite*` excluded — the repo's committed `data/*.sqlite*` artifacts did not come across).
Before repo creation (Zebulon's approval point):
1. **Rename leftovers:** package name `react-example` → `azxai-navigator`; `metadata.json` still says "HRM Ecology"; delete stray `hrm-ecology (3).zip`.
2. **Lab surface:** `src/LabApp.tsx` + `src/engine/*` + `src/components/*` (legacy HRM research lab) still ship in the production bundle (154 KB chunk) even though `ENABLE_LAB` gates the endpoints. Decide: split the lab out, lazy-load it, or accept the weight.
3. **Billing:** add the $74.99 Navigator product + monthly selling plan on the Shopify store (same store as Radar) and point its webhook at Navigator's `/api/billing/webhook`; Navigator's HMAC scheme is its own — confirm it matches what Shopify sends or adapt the verifier (today it verifies a generic signed-payload scheme, tested with its own signer).
4. **Env/secrets for deploy:** `PORT`, `NODE_ENV=production`, `DATABASE_PATH`, `APP_URL` (public Navigator URL — needs a domain decision), `BILLING_WEBHOOK_SECRET` (≥24 chars, via host secrets, never in repo), `TRUST_PROXY` behind a proxy, `ENABLE_LAB` unset in production, `GEMINI_API_KEY` only if lab/tri-path features are ever enabled.
5. **CI for the new repo:** `npm ci && npm test && npm run build` + boot smoke (the exact checks verified here). Native dep note: better-sqlite3 builds from source in CI unless a prebuild matches — pin Node version in CI to a prebuild-supported LTS.
6. **Data:** production `DATABASE_PATH` on persistent disk; demo seeding off in production (`SEED_DEMO`/`ALLOW_PUBLIC_DEMO` default off when `NODE_ENV=production` — verified in config tests).

## Decisions needed from Zebulon
- Navigator domain (e.g. navigator.aichangeradar.com vs its own domain) — drives `APP_URL`, cookies, and the service's link-email copy.
- Repo name/owner for the separate repo (creation is his go).
- Whether the $74.99 subscription is sold on the same Shopify store as Radar (assumed yes) and whether a Radar subscription is required, discounted, or independent (map assumes independent-but-linkable).
- Lab: split, keep dormant, or drop.
