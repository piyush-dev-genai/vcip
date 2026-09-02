/**
 * The rule Nest enforces at boot, enforced here instead (T35).
 *
 * **A module may only export what it provides or re-exports.** Break it and
 * `NestFactory.create` throws before the first request — which is a fine place
 * to find out, except that nothing in this suite booted the whole application
 * graph, so the whole suite could pass against a server that could not start.
 *
 * That is not hypothetical. T35 split `AI_HUD_REPOSITORY` into `AiHudModule`
 * so the verdict could read a HUD without `AgentsModule` importing the AI
 * boundary and closing a module cycle. `AiModule` went on exporting the token
 * it no longer provided, 1635 tests passed, and the application would not
 * start. This file is that bug's fixture.
 *
 * It reads Nest's own decorator metadata rather than instantiating anything:
 * no database, no Redis, no LiveKit key, and no environment. The one thing it
 * checks is the one thing a unit test building its own graph can never notice.
 */

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AgentsModule } from './agents/agents.module.js';
import { AiHudModule } from './ai/ai-hud.module.js';
import { AiModule } from './ai/ai.module.js';
import { AppModule } from './app.module.js';
import { ChecklistModule } from './checklist/checklist.module.js';
import { LivekitModule } from './livekit/livekit.module.js';
import { QueueModule } from './queue/queue.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { TenantsModule } from './tenants/tenants.module.js';

/** Every module the application actually assembles. */
const MODULES = [
  AppModule,
  AgentsModule,
  AiModule,
  AiHudModule,
  ChecklistModule,
  LivekitModule,
  QueueModule,
  RealtimeModule,
  SessionsModule,
  TenantsModule,
] as const;

type Provider = { provide?: unknown } | (new (...args: never[]) => unknown);

const meta = (module: unknown, key: string): unknown[] =>
  (Reflect.getMetadata(key, module as object) as unknown[] | undefined) ?? [];

/** The token a provider answers to — its `provide`, or the class itself. */
const tokenOf = (provider: Provider): unknown =>
  typeof provider === 'object' && provider !== null && 'provide' in provider
    ? provider.provide
    : provider;

/** `forwardRef(() => X)` arrives as `{ forwardRef: () => X }`. */
const resolve = (entry: unknown): unknown => {
  if (typeof entry === 'object' && entry !== null && 'forwardRef' in entry) {
    return (entry as { forwardRef: () => unknown }).forwardRef();
  }
  return entry;
};

const nameOf = (value: unknown): string => {
  if (typeof value === 'function') return value.name;
  if (typeof value === 'symbol') return value.toString();
  return String(value);
};

describe('every module can export what it says it exports', () => {
  it.each(MODULES.map((module) => [module.name, module] as const))('%s', (_name, module) => {
    const provided = new Set(meta(module, 'providers').map((p) => tokenOf(p as Provider)));
    const imported = new Set(meta(module, 'imports').map(resolve));

    const unbacked = meta(module, 'exports')
      .map(resolve)
      // An exported module is a re-export and needs no provider — but it does
      // have to be imported, which the next assertion covers.
      .filter((token) => !provided.has(token) && !imported.has(token))
      .map(nameOf);

    expect(unbacked).toEqual([]);
  });
});

describe('the application graph is closed', () => {
  it('reaches every module the app assembles from AppModule', () => {
    // A module that exists, compiles, and is imported by nobody is a module
    // whose providers never run. Walking from `AppModule` is how that shows up
    // as a failure rather than as a quiet absence.
    const seen = new Set<unknown>();
    const walk = (module: unknown): void => {
      if (seen.has(module)) return;
      seen.add(module);
      for (const imported of meta(module, 'imports').map(resolve)) walk(imported);
    };
    walk(AppModule);

    const unreachable = MODULES.filter((module) => !seen.has(module)).map((m) => m.name);
    expect(unreachable).toEqual([]);
  });
});
