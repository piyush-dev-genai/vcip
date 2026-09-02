import { Module } from '@nestjs/common';
import { AuthModule } from '../common/auth/auth.module.js';
import { ChecklistController } from './checklist.controller.js';
import { CHECKLIST_REPOSITORY, DrizzleChecklistRepository } from './checklist.repository.js';
import { ChecklistService } from './checklist.service.js';

/**
 * The verification checklist (T33, D8).
 *
 * Its imports are its boundary, and the absences are the point: no queue, no
 * billing, no LiveKit, no AI, and — for now — no sessions module. This module
 * reads one thing and writes nothing.
 *
 * `AuthModule` supplies `AgentJwtGuard`, `TenantGuard` and `TenantScope`. The
 * database comes from the global `DbModule`, the same way every other
 * repository here gets it.
 *
 * `SessionsModule` is deliberately not imported even though this reads the
 * `sessions` table. `SessionRepository` answers questions about the customer
 * lifecycle and its projections carry no template columns; adding one for a
 * checklist would make the session repository know what a checklist is. The
 * join belongs to whoever owns the checklist, which is here.
 *
 * `ChecklistService` is exported for T34, which validates a submitted
 * checklist against the same pinned template this route returns — one read,
 * so the list the agent was shown and the list their verdict is checked
 * against cannot be two different lists.
 */
@Module({
  imports: [AuthModule],
  controllers: [ChecklistController],
  providers: [
    { provide: CHECKLIST_REPOSITORY, useClass: DrizzleChecklistRepository },
    ChecklistService,
  ],
  exports: [ChecklistService, CHECKLIST_REPOSITORY],
})
export class ChecklistModule {}
