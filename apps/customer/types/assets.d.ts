/**
 * Ambient declaration for the global stylesheet import.
 *
 * Next generates `next-env.d.ts` — which declares this — on its first build,
 * and this repository gitignores that file (T01). So in a clean checkout
 * `pnpm typecheck` runs before anything has generated it, and a side-effect CSS
 * import has no declaration to resolve against.
 *
 * Declaring it here makes the typecheck independent of whether a build has
 * happened yet, which is what a CI-shaped command has to be.
 */
declare module '*.css';
