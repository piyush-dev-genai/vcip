/**
 * The Cloudflare adapter's configuration (see docs/07-deployment.md).
 *
 * Deliberately bare. OpenNext's optional pieces — an incremental cache, a tag
 * cache, a queue for on-demand revalidation — all exist to serve rendered
 * output between requests, and this application renders nothing worth keeping:
 * every screen is a client component driven by the customer's own session, and
 * the one server route (`app/api/demo/session`) is `force-dynamic` because it
 * mints a credential. Wiring a cache here would add bindings, and a KV or R2
 * binding is a paid resource on an account that is meant to spend nothing.
 */

import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig();
