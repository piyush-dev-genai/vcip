# V-CIP Core MVP — Zero-Cost Deployment

Status: **Approved for the Core MVP**  ·  Providers verified: 2026-09-04

> Approved decisions live in `docs/00-decisions.md`. Where this document
> conflicts with that decision record, the decision record wins. Section 8
> names the two places this deployment departs from it, and why.

This deploys the Core MVP — everything through T37 plus T50 — for external
testing. The evidence and export phase (T38–T46) is **not** deployed and is not
required for anything below to work.

```text
Consent -> Preflight -> Location -> Queue -> Agent login -> Availability
        -> Claim -> Accept -> LiveKit A/V -> AI analyzer -> AI HUD
        -> Document check -> Checklist -> Verdict -> Billing
```

Total cost: **₹0 / $0**. No credit card is required by any provider named as a
primary choice. No domain is purchased; every surface answers on a
provider-issued HTTPS hostname.

---

## 1. Topology

```text
                    browser
                       |
        +--------------+--------------+
        |                             |
   Cloudflare Workers            Cloudflare Workers
   vcip-customer                 vcip-agent
   *.workers.dev                 *.workers.dev
        |                             |
        |   REST + WebSocket (wss)    |
        +--------------+--------------+
                       |
                 Render (free)                        LiveKit Cloud
              vcip-api  0.1 CPU / 512 MB  <--webhook--    (Build)
                       |                                     ^
     private network   |                                     | media
        +--------------+---------------+                     | (never through
        |              |               |                     |  the API — I6)
   vcip-redis     Supabase        vcip-ai                    |
   Key Value      Postgres        FastAPI  ------------------+
   25 MB, free    500 MB, free    0.1 CPU / 512 MB   subscribe-only
```

Four things this preserves, because they are constraints rather than
preferences:

- **PostgreSQL stays authoritative** (D1). It is the only durable store, and it
  is the one component deliberately *not* hosted on Render — see section 3.
- **Redis stays temporary** (D2). Render's free Key Value never writes to disk,
  which sounds like a compromise and is not one: D2 already requires that a
  Redis flush degrade only the liveness of the queue and the HUD.
- **AI stays a separate service** (D20), holding no PostgreSQL and no Redis
  credentials. It is reached over Render's private network and answers only to
  the shared internal token.
- **Browser video never passes through the Control API** (I6). Media goes
  browser ↔ LiveKit Cloud directly; the API mints tokens and nothing else.

---

## 2. Why these providers

Checked against provider documentation on 2026-09-04. Free tiers move; re-read
before trusting a number here that is older than a few months.

| Layer | Chosen | Verified free allowance | Card? |
| --- | --- | --- | --- |
| Browser apps | Cloudflare Workers | 100,000 requests/day · 10 ms CPU per request · 3 MiB gzipped Worker · 50 subrequests/request · **commercial use permitted** | no |
| API + AI | Render web services | 0.1 CPU · 512 MB · **750 instance-hours per workspace per month** · spin-down after 15 min idle | no |
| Redis | Render Key Value | 25 MB · 50 connections · no disk persistence · one per workspace | no |
| PostgreSQL | Supabase | 500 MB database · 5 GB egress · 2 active projects · paused after 1 week idle | no |
| Media | LiveKit Cloud (Build) | 5,000 participant-minutes/mo · 50 GB downstream/mo · 100 concurrent participants | no |

### What was rejected, and why

- **Render's own free Postgres** — expires 30 days after creation. A demo that
  dies on a date nobody wrote down is worse than one extra provider.
- **Neon** — the free plan is generous (0.5 GB, 100 CU-hours per project per
  month), but `apps/api/src/common/db/db.module.ts` builds `postgres(url)` with
  defaults, and postgres.js never closes an idle connection. Neon's compute
  cannot scale to zero while a connection is open, so the API would burn about
  180 CU-hours a month against an allowance of 100 and be **suspended until the
  next billing period** partway through. Usable, but only after setting
  `idle_timeout` on the client. Supabase does not meter compute and needs no
  such change.
- **Fly.io** — free allowances were removed in 2024. The trial is 2 VM-hours or
  7 days, then a card is mandatory.
- **Koyeb** — one free service, and a card verified with a $29 pre-authorisation.
- **Northflank** — always-on free sandbox, but a card is required at signup.
- **Hugging Face Spaces** — Docker Spaces now require a paid plan. Only static
  Spaces remain free.
- **Vercel Hobby** — free, no card, and by far the least work for Next.js. Its
  fair-use policy is the problem: *"Hobby teams are restricted to
  non-commercial personal use only… commercial usage is defined as any
  Deployment that is used for the purpose of financial gain of anyone involved
  in any part of the production of the project, including a paid employee or
  consultant writing the code."* A B2B verification product shown to outsiders
  is not obviously outside that. Cloudflare's free plan permits commercial
  products explicitly, which is why it is the primary choice despite costing
  more setup.
- **Oracle Cloud Always Free / Google Cloud Run** — genuinely free compute, and
  both require a billing account. Oracle additionally issues an IP rather than
  a hostname, so an HTTPS demo needs a tunnel it does not otherwise need.

### The two Cloudflare limits worth checking before you believe this

Workers Free caps a Worker at **3 MiB gzipped** and **10 ms of CPU per
request**, and OpenNext bundles the whole Next.js server into that Worker. Both
were checked rather than assumed:

| App | Total upload | Gzipped | Limit | Headroom |
| --- | ---: | ---: | ---: | ---: |
| `vcip-agent` | 5,730 KiB | **1,128 KiB** | 3,072 KiB | 63% |
| `vcip-customer` | 5,795 KiB | **1,137 KiB** | 3,072 KiB | 63% |

Measured on 2026-09-04 with `wrangler deploy --dry-run` on a Linux build. Re-run
it if a dependency lands that pulls weight into the server bundle:

```bash
cd apps/customer && npx wrangler deploy --dry-run
```

The CPU limit is comfortable for a different reason: almost nothing in either
application renders on the server. Every screen is a client component, so the
prerendered HTML is served from the assets binding without invoking the Worker
at all. The Worker runs for three things — the customer's `/session/[id]` shell,
`/api/demo/session`, and `/api/probe` — and none of them does more than assemble
a small response. Note that CPU time excludes time blocked on the network, so
the bootstrap route's round trip to Render does not count against it.

---

## 3. What is deployed where

| Surface | File | Notes |
| --- | --- | --- |
| `vcip-api`, `vcip-ai`, `vcip-redis` | `render.yaml` | One blueprint, applied once |
| `vcip-customer` | `apps/customer/wrangler.jsonc` | `pnpm --filter @vcip/customer cf:deploy` |
| `vcip-agent` | `apps/agent/wrangler.jsonc` | `pnpm --filter @vcip/agent cf:deploy` |
| PostgreSQL | — | Created in the Supabase dashboard |
| LiveKit | — | Created in the LiveKit Cloud dashboard |

Nothing in `infra/` is used. That compose file provisions local development
(T03) and is unchanged.

---

## 4. Deploy, in order

The order matters in exactly one place: the API needs the browser origins and
the browsers need the API's address, so the first pass through steps 5 and 7
leaves one value blank and step 8 fills it in.

### 1. LiveKit Cloud

Create a project on the **Build** plan. Note three values:

```text
LIVEKIT_URL           wss://<project>.livekit.cloud
LIVEKIT_API_KEY       API<...>
LIVEKIT_API_SECRET    <...>
```

Choose the region nearest your testers. Leave the webhook alone for now —
step 9 sets it, once the API has an address.

### 2. Supabase

Create a project (region: Singapore or Mumbai, to sit near Render's
`singapore`). From **Project Settings → Database → Connection string**, take
the **Session pooler** URI — *not* the direct connection.

Two reasons, and both bite silently if ignored:

- The direct endpoint is IPv6-only. Render's outbound traffic is IPv4, so a
  direct URI simply fails to connect.
- The pooler offers session mode and transaction mode. postgres.js uses
  prepared statements by default, which transaction mode does not support.
  **Session mode** is the one that works unchanged.

Append `?sslmode=require`. This is `DATABASE_URL`.

### 3. Render blueprint

Push this branch, then **New → Blueprint** and point Render at the repository.
It reads `render.yaml` and creates all three resources.

Render will prompt for every variable marked `sync: false`:

```text
DATABASE_URL          from step 2
LIVEKIT_URL           from step 1
LIVEKIT_API_KEY       from step 1
LIVEKIT_API_SECRET    from step 1
CUSTOMER_ORIGIN       leave blank for now  (step 8)
AGENT_ORIGIN          leave blank for now  (step 8)
```

The four secrets the API signs with — customer token, agent JWT, WebSocket
token, internal token — are generated by Render and never typed by anyone. The
AI service reads the internal token from the API's copy, so there is one value
rather than two that can drift.

The API will fail its first health check while `CUSTOMER_ORIGIN` is unset. That
is correct: an unset allow-list admits no browser, and failing that way is the
safe direction.

Note the two hostnames Render assigns:

```text
https://vcip-api.onrender.com
https://vcip-ai.onrender.com
```

### 4. Schema and seed

Run from your machine, against the hosted database:

```bash
DATABASE_URL='<the session-pooler URI>' pnpm --filter @vcip/api db:migrate
DATABASE_URL='<the session-pooler URI>' VCIP_DEMO_AGENT_PASSWORD='<choose one>' \
  pnpm --filter @vcip/api db:seed
```

The seed is idempotent and prints three things once, storing none of them:

- the **enterprise API key** — this is `VCIP_DEMO_API_KEY` in step 6, and it
  exists nowhere else. If it is lost, re-run with `VCIP_SEED_ROTATE_KEY=yes`.
- the **agent password**, unless you supplied one as above.
- the **tenant slug and the agent email addresses**, which are what an agent
  types into the portal's login form.

Keep that output. Nothing recovers it later.

### 5. Build and deploy the customer app

Two ways, and the first has no prerequisite beyond a browser. It also builds on
the same Linux the bundle measurements in section 2 were taken on.

#### 5a. Workers Builds — recommended

Cloudflare clones the repository and builds it, the way Render already does.
The free plan allows 3,000 build-minutes a month on 2 vCPU; this project spends
about three minutes per build.

In the Cloudflare dashboard: **Workers → Create → Connect to Git**, pick this
repository, and set

```text
Root directory   apps/customer
Build command    cd ../.. && pnpm install --frozen-lockfile
                   && pnpm --filter @vcip/shared build
                   && pnpm --filter @vcip/customer cf:build
Deploy command   npx wrangler deploy
```

(one line for the build command; wrapped here to fit.)

The `cd ../..` is not a workaround. This is a pnpm workspace, so the install
belongs at the root and `@vcip/shared` has to be built before an app can
resolve it through `dist/`. The root directory still points at the app, because
that is where `wrangler.jsonc` lives.

Add the two `NEXT_PUBLIC_` values as **build variables** — not secrets, and not
runtime variables. Next inlines them into the bundle while building, so a value
supplied at runtime arrives too late to appear anywhere:

```text
NEXT_PUBLIC_API_BASE_URL   https://vcip-api.onrender.com
NEXT_PUBLIC_LIVEKIT_URL    wss://<project>.livekit.cloud
```

Every push then rebuilds and redeploys.

#### 5b. From your own machine

```bash
NEXT_PUBLIC_API_BASE_URL=https://vcip-api.onrender.com \
NEXT_PUBLIC_LIVEKIT_URL=wss://<project>.livekit.cloud \
pnpm --filter @vcip/customer cf:deploy
```

**On Windows this needs the Microsoft Visual C++ Redistributable first.**
`@opennextjs/cloudflare` patches the Next.js server using `@ast-grep/napi`, a
native module that cannot load without it. The error blames npm's
optional-dependency bug for what is really a missing `VCRUNTIME140.dll`, which
sends you looking in the wrong place:

```text
Error: Cannot find native binding. npm has a bug related to optional
dependencies … Cannot find module './ast-grep-napi.win32-x64-msvc.node'
```

Install it once, then confirm the binding actually loads:

```powershell
winget install --id Microsoft.VCRedist.2015+.x64
```

```bash
node -e "require('@ast-grep/napi'); console.log('ok')"
```

### 6. The customer app's server-side configuration

`app/api/demo/session/route.ts` is D14's stand-in for the enterprise backend,
and it holds the enterprise API key. Three values, set on the Worker:

```bash
cd apps/customer
npx wrangler secret put VCIP_DEMO_API_KEY      # from the seed output
npx wrangler secret put VCIP_API_BASE_URL      # https://vcip-api.onrender.com
npx wrangler secret put VCIP_DEMO_BOOTSTRAP    # yes
```

`VCIP_DEMO_BOOTSTRAP=yes` is not optional. The route refuses to run in
production without it — deliberately, because it holds an enterprise
credential — and a deployment missing it answers every "start a verification"
click with `DEMO_BOOTSTRAP_UNAVAILABLE`.

`VCIP_DEMO_API_KEY` must never gain a `NEXT_PUBLIC_` prefix. It is read on the
server and the only thing that crosses to the browser is the short-lived,
session-scoped customer token.

### 7. Build and deploy the agent portal

Step 5 again with `agent` wherever `customer` appeared: a second Workers Builds
project rooted at `apps/agent`, or

```bash
NEXT_PUBLIC_API_BASE_URL=https://vcip-api.onrender.com \
NEXT_PUBLIC_LIVEKIT_URL=wss://<project>.livekit.cloud \
pnpm --filter @vcip/agent cf:deploy
```

No secrets. The portal holds no credential; an agent's JWT is minted by the
Control API and lives in the browser.

### 8. Close the loop on CORS

Both Workers now have addresses. In the Render dashboard, set on `vcip-api`:

```text
CUSTOMER_ORIGIN   https://vcip-customer.<subdomain>.workers.dev
AGENT_ORIGIN      https://vcip-agent.<subdomain>.workers.dev
```

Bare origins: no path, no trailing slash. Redeploy the API.

### 9. Point LiveKit's webhook at the API

In the LiveKit Cloud project settings, add a webhook:

```text
URL       https://vcip-api.onrender.com/internal/livekit/webhook
API key   the same key from step 1
```

D7 requires this and the Core MVP does not work without it: `agent.joined`, the
call start and end timestamps, `DROPPED_IN_CALL`, and `AGENT_DISCONNECTED` all
arrive this way. The route verifies LiveKit's signature instead of the shared
internal token (D10, as amended by T26) — `livekit-server` sends only its own
signed `Authorization` header, so requiring `X-Internal-Token` would leave the
endpoint permanently unreachable.

### 10. Keep-warm

See section 6. Without it the AI HUD will be dead on the first call of any
quiet period, because a spun-down AI service cannot answer inside
`AI_START_TIMEOUT_MS`.

---

## 5. Verifying the deployment

In order, because each step depends on the one before:

```text
1.  GET https://vcip-api.onrender.com/health      -> {"status":"ok","service":"api"}
2.  GET https://vcip-ai.onrender.com/health       -> {"status":"ok","service":"ai"}
3.  Open the customer app, click through to the queue
4.  Open the agent portal in a second browser, log in, go AVAILABLE
5.  Claim, accept — both video tiles appear
6.  The agent's HUD shows liveness and face-match values within ~4 seconds
7.  Press the document check — a status comes back, no document fields anywhere
8.  Submit a verdict — approve bills 2500 paise, reject bills 500
```

Step 6 is the one that exercises the whole free-tier gamble: it means the AI
service joined the room from a 0.1-CPU instance and kept up. If the HUD says
"AI unavailable", section 9 has the three causes.

---

## 6. The one number to watch: 750 instance-hours

Render grants **750 free instance-hours per workspace per calendar month**,
shared by every free web service in it. Spun-down time does not count. Two
services awake around the clock need about 1,460, and when the grant runs out
Render **suspends every free service in the workspace until the 1st of the next
month**.

```text
                          hours/month
  api awake 24/7                 730
  ai  awake 24/7                 730
                              ------
                                1460      grant: 750     -> suspended ~day 15
```

The AI service is the one that genuinely cannot sleep. `AI_START_TIMEOUT_MS` is
2 seconds and it is awaited on the path that appends `CALL_STARTED`, so a
cold-starting AI service can never answer in time; the session records
`AI_UNAVAILABLE` and the call continues without a HUD. The API has no such
constraint — a sleeping API costs the first visitor about a minute and nothing
else, and while a demo is running its own WebSocket traffic keeps it awake.

So the knob is **how many hours a day you keep each service warm**, using any
free external pinger (UptimeRobot and cron-job.org both do this with no card)
hitting `/health` every 10 minutes:

| Policy | Hours/month | Outcome |
| --- | ---: | --- |
| Ping both, 24/7 | ~1,460 | Suspended around day 15 |
| Ping both, 12 h/day | ~720 | Survives the month; outside the window the first call has no AI |
| Ping AI only, 20 h/day; API wakes on demand | ~710 | Survives the month; API costs one cold start per quiet period |

The third row is the recommendation. The second is the simplest to explain to
someone else running a demo.

Whatever you choose, watch the usage figure in the Render dashboard for the
first month rather than trusting this table.

---

## 7. What runs out first

At the free tiers above, with a three-participant room — customer, agent, and
the analyzer — a five-minute verification costs roughly:

| Resource | Per call | Monthly allowance | Calls |
| --- | ---: | ---: | ---: |
| LiveKit participant-minutes | 15 | 5,000 | ~330 |
| LiveKit downstream data | ~170 MB | 50 GB | ~290 |
| Cloudflare Worker requests | ~5 | 100,000/day | not binding |
| Supabase storage | ~5 KB | 500 MB | not binding |
| Redis working set | ~2 KB | 25 MB | not binding |

**LiveKit downstream bandwidth binds first**, at roughly 290 five-minute calls
a month. Subscribing the analyzer to the lowest simulcast layer
(`AI_VIDEO_QUALITY=low`) is what keeps its share of that small, and it is set
in `render.yaml` for the CPU reason rather than this one.

Render instance-hours (section 6) will bite well before any of these.

---

## 8. Where this departs from the decision record

Two places, both consequences of free hosting rather than of design, and both
worth knowing before someone reads the code and finds a contradiction.

### D10 — `/internal/*` is publicly routable here

D10 says the internal API "requires a shared internal credential
(`X-Internal-Token`) and is not routed publicly." On Render, a free web service
has exactly one public hostname and no way to expose some routes and not
others, so `/internal/*` on both services answers on the public internet.

What actually protects it is unchanged: every `/internal/*` route requires the
shared token, which is generated by Render, never written down, and never
leaves the two services. Note that this was already partly true of any
deployment — T26's LiveKit webhook *must* be publicly reachable to work at all.

Traffic between our own two processes does not use those public addresses.
`AI_INTERNAL_URL` and `AI_CONTROL_API_URL` are private-network addresses
(`http://vcip-ai:10000`, `http://vcip-api:10000`), so the API↔AI hop never
leaves Render.

### T28 — recordings are not started

`RECORDING_ENABLED=false`. This is a Core-MVP deployment, so T38–T46 — the
worker that fetches the file, watermarks it, hashes it, signs it and exports it
— does not exist yet. Starting a recording anyway would write an
`EGRESS_STARTED` event claiming evidence exists for a session whose evidence
nobody will ever process, and would spend LiveKit's 60 free transcode-minutes a
month on about a dozen calls.

Nothing else changes. A recording never could fail a call
(`recording.service.ts` is explicit about it), so a call with no recording is
the same call. Turning it back on for Phase 2 means setting the flag, supplying
the `S3_*` values, and nothing more.

---

## 9. When something is wrong

**`cf:build` says "Cannot find native binding" and blames npm.**
It is not npm. `@ast-grep/napi` needs the Microsoft Visual C++ Redistributable,
and on a machine without it the loader reports the missing DLL as a missing
optional dependency. Step 5b, or build on Cloudflare instead (5a).

**`EINVAL: invalid argument, readlink` under `.next`.**
Seen from `next dev` as much as from `cf:build`, because both read the same
directory. A `.next` built by something other than this machine — a container
with the repository bind-mounted is the usual way — leaves symlinks the host
cannot read back. Nothing recovers them:

```bash
rm -rf apps/customer/.next apps/customer/.open-next
rm -rf apps/agent/.next apps/agent/.open-next
```

Both are gitignored and rebuild from scratch. If you do need a container build,
copy the source in rather than bind-mounting the repository.

The related trap is the one `next.config.mjs` now pins. Next infers the
workspace root by walking *upwards* for a lockfile, so a stray
`package-lock.json` in a home directory outranks this project's
`pnpm-lock.yaml` and file tracing is then done from the wrong root — a warning
at `next dev`, and a wrongly assembled `.next/standalone` for the Cloudflare
build, which is what OpenNext reads. `outputFileTracingRoot` fixes it to the
repository. If the warning reappears, that setting has been lost.

**The customer app answers `DEMO_BOOTSTRAP_UNAVAILABLE`.**
`VCIP_DEMO_BOOTSTRAP` is not `yes`, or `VCIP_DEMO_API_KEY` is unset. Step 6.

**Every API call fails in the browser with a CORS error.**
`CUSTOMER_ORIGIN` / `AGENT_ORIGIN` are unset, or carry a trailing slash or a
path. They must be bare origins. Step 8.

**The API will not start.**
Read the deploy log; the failure names the missing variable and never its
value. The three signing secrets must differ from one another — the API refuses
to start otherwise, which is deliberate.

**The first request of the day takes a minute.**
Render's 15-minute spin-down. Expected. Section 6.

**The agent's HUD says "AI unavailable".**
Three causes, in order of likelihood.

1. *The AI service was asleep.* The 2-second timeout cannot survive a cold
   start. Keep it warm (section 6).
2. *The private address is wrong.* Check the API's logs for a connection
   failure to `http://vcip-ai:10000`. As a fallback, set `AI_INTERNAL_URL` to
   `https://vcip-ai.onrender.com` — it works, at the cost of section 8's first
   deviation applying to this hop too.
3. *0.1 CPU was not enough.* Check the AI service's logs for the frame loop
   falling behind. `AI_VIDEO_QUALITY=low` is the mitigation and is already set;
   beyond it, raise `AI_SAMPLE_INTERVAL_MS` (fewer conversions) before
   `AI_CHECK_INTERVAL_MS` (a slower HUD).

Whatever the cause, the call itself is unaffected and a verdict is still
submittable. That is T32's gate, and it holds here.

**Every free service is suspended and the month is not over.**
The 750-hour grant is spent. Section 6.

**Supabase says the project is paused.**
A week with no activity. One click to restore, and the keep-warm pinger does
not prevent it — `/health` deliberately touches no datastore. If a demo is
weeks away, plan to restore it the day before.

---

## 10. Local development is unchanged

Nothing here alters `infra/docker-compose.yml` or how the stack runs locally.
The three settings this deployment introduces all default to the behaviour that
was already there:

| Setting | Default | Set here to |
| --- | --- | --- |
| `PORT` | unset — `API_PORT` is used | `10000` |
| `RECORDING_ENABLED` | `true` | `false` |
| `AI_VIDEO_QUALITY` | unset — the server's choice | `low` |

D24's rule holds: the difference between environments is expressed in values,
not in code.
