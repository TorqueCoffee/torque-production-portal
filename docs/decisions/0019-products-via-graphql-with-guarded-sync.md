# 0019 — Products via GraphQL, with a guarded settings sync

- **Status**: Accepted
- **Date**: 2026-10-04

## Context

The coffee list (`/api/shopify-token?type=products`) feeds dropdowns, blend validation and an auto-sync that inserts and hard-deletes `green_coffee_settings` rows. It used REST `status=active` and `status=draft`, which cannot see `unlisted` products, and filtered only by vendor and a few title terms, so xBloom/xPod listings leaked in as separate "coffees".

The sync treats the list as the source of truth, so a short, empty or errored list is destructive, and the old endpoint turned Shopify errors into an empty list.

## Options considered

- **REST with more status values** - `unlisted` is not a REST status in the pinned version; would still miss them.
- **Bump REST version** - unverified for unlisted, and still needs title filtering.
- **GraphQL products query + `isCoffeeProduct()` rule** - sees all statuses, one place for the rule.

## Decision

Use GraphQL (2025-10) for the products list; include active and unlisted, plus drafts tagged `roast-profile`; exclude titles matching xBloom/xPods, shipping-weight fillers, subscriptions, gift cards and Society memberships. Return 502 on any Shopify error, and abort the sync client-side on an empty or errored list.

## Consequences

**Positive:** list matches what is sellable; a Shopify outage can no longer wipe settings.
**Negative:** the title-regex exclusion is by naming convention; a new xBloom listing not named xBloom/xPods would appear. Pinned to GraphQL API 2025-10.
**When to revisit:** if xBloom listings get a reliable tag or product type to filter on instead of the title.
