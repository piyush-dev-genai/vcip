/**
 * The Cloudflare adapter's configuration (see docs/07-deployment.md).
 *
 * Bare, and more obviously so than the customer app's: the agent portal has a
 * single server route (`app/api/health`) and no server-rendered data at all.
 * Everything an agent sees is fetched from the Control API by the browser with
 * the agent's own JWT, which is the only credential that could authorise it.
 */

import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig();
