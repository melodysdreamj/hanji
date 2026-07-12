# Sponsors and the sign-in banner

Hanji is sustained by sponsors. The sign-in screen shows a small banner that
thanks **one of the current top five sponsors** from Hanji's canonical feed,
chosen at random when the screen loads (reloading surfaces a different one).
Keeping that feed relay and banner — the sponsor fetch-and-display code —
functional, unmodified in behavior, and enabled by default is what grants the
[Sponsor Banner Exception 2.0](https://github.com/melodysdreamj/hanji/blob/main/LICENSE-EXCEPTION) to the
[AGPL-3.0](https://github.com/melodysdreamj/hanji/blob/main/LICENSE) — see the License section of the
[README](https://github.com/melodysdreamj/hanji/blob/main/README.md#license).
The exception condition is about keeping that sponsor-exposure code in place and
unmodified, not about showing a specific number of sponsors at once.

The rolling credit in the app sidebar and the "Support Hanji" block in settings
are additive niceties; they are **not** part of the license-required feature and
carry no exception condition of their own.

Sponsor links always point to the sponsor's GitHub profile. When the feed has no
sponsors, the credit falls back to the tools Hanji is built with (Cloudflare,
Claude, ChatGPT, GLM, GitHub), shown with a "helps build Hanji" wording rather
than as sponsors — so the surface is never empty and never implies sponsorship
that isn't there.

## What the exception permits

The exception is an optional, royalty-free additional permission. A qualifying
version may keep its modifications private, operate as a private or public
hosted service, combine Hanji with proprietary code, and redistribute modified
source, executables, containers, and browser bundles without providing
Corresponding Source. The permission applies only while the canonical feed and
banner conditions in the exception are satisfied.

Removing, replacing, disabling, or obscuring the feature is still allowed: the
deployment simply falls back to plain AGPL-3.0 and must satisfy its applicable
source obligations. A closed, banner-free version requires a separate
commercial license. The actual license texts control over this summary.

## How sponsor slots work

- Sponsoring through [GitHub Sponsors](https://github.com/sponsors/melodysdreamj)
  accrues into a per-sponsor **balance**.
- The feed carries the top five sponsors by remaining balance; the sign-in
  banner thanks one of them, chosen at random each time the screen loads.
- Once a month, every displayed sponsor's balance is reduced by the same
  amount: what the **fifth-place** sponsor has (a uniform fifth-price burn,
  with a small floor price). Contributing more buys longer display time; the
  monthly cost of a slot is set by the cheapest displayed slot, so all five
  displayed sponsors always pay the same fair rate.
- When a balance runs out, the slot goes to the next sponsor by balance.

## How instances get the sponsor list

By default, self-hosted instances fetch the current top-five feed from a
read-only public endpoint. The request contains no Hanji account/workspace data
or tokens; like any server-to-server HTTP request, it necessarily exposes the
instance's network address and standard request metadata to the feed operator.
To keep the license condition unambiguous, Hanji only accepts its exact upstream
feed.

`HANJI_SPONSORS_FEED_URL` selects one of three modes:

```bash
# (unset / any URL)          # live: fetch the Canonical Sponsor Feed
HANJI_SPONSORS_FEED_URL=bundled  # offline: no external request; show the snapshot
                                 #          shipped in this release (still qualifies)
HANJI_SPONSORS_FEED_URL=off      # no banner at all → plain AGPL-3.0
```

**`bundled`** is for closed networks or operators who don't want the outbound
request but still want to support the project: the banner shows the sponsor
snapshot compiled into the release
([`backend/data/sponsors-snapshot.ts`](../backend/data/sponsors-snapshot.ts)),
which the Hanji project refreshes about monthly to mirror the live top five.
No network call leaves the instance, and the exception still applies **while the
shipped snapshot is displayed unmodified** — editing or replacing it is treated
like substituting the live feed and drops the deployment to plain AGPL-3.0.

If the live feed is unreachable, the banner simply renders nothing — sign-in is
never blocked by it. An empty canonical response or temporary failure outside
the operator's reasonable control does not by itself end the exception while the
canonical configuration and unmodified fetch-and-display path remain enabled and
automatically resume. Setting `off`, or intentionally blocking or redirecting
the feed, means the exception does not apply and plain AGPL-3.0 governs.

## For self-host users

The license exception requires the banner *feature* to remain present,
functional, and enabled by default in the deployment. A deployment-wide
default, policy, stylesheet, route, or proxy that hides or bypasses it does not
qualify.

Do not redirect or replace the upstream feed. Only the endpoint shipped with
the release, an official successor, or an expressly authorized mirror is a
Canonical Sponsor Feed under the exception. Obtain legal advice before relying
on this custom additional permission.
