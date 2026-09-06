import path from 'node:path';

/**
 * Next configuration for the V-CIP agent application.
 *
 * `outputFileTracingRoot` is the whole of it, and it is not cosmetic.
 *
 * Next infers the workspace root by looking for a lockfile, and it walks
 * *upwards* to do so. A stray `package-lock.json` anywhere above the
 * repository — a home directory is the usual place one ends up — wins over
 * this project's own `pnpm-lock.yaml`, and Next then traces and copies files
 * relative to that directory instead of this one. The visible symptom is a
 * warning; the invisible one is a `.next/standalone` tree assembled from the
 * wrong root, which is what the Cloudflare build (`open-next.config.ts`) reads.
 *
 * Pinning it makes the output depend on the repository rather than on whatever
 * happens to sit in the directories above it, which is the same reason every
 * other path in this workspace is resolved from a known anchor.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
};

export default nextConfig;
