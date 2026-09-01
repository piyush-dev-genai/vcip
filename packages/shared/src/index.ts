/**
 * `@vcip/shared` — pure domain logic shared by the Control API and the browser
 * apps.
 *
 * No I/O, no database, no Redis, no NestJS, no LiveKit. Everything here is a
 * deterministic function of its arguments, which is what makes the business
 * rules unit-testable without a running stack.
 */

export * from './enums.js';
export * from './state-machine.js';
export * from './billing.js';
export * from './errors.js';
export * from './events.js';
export * from './realtime.js';
export * from './api/index.js';
