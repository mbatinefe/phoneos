import type { SchedulerRepository } from './repository.js';

export class SchedulerUnavailableError extends Error {
    readonly statusCode = 503;

    constructor(reason: string) {
        super(`Scheduling is unavailable: ${reason}. Start PostgreSQL (npm run db:up && npm run db:migrate) and restart the dashboard.`);
    }
}

/**
 * A scheduler stand-in for hosts without PostgreSQL: reads are empty, writes
 * explain what is missing. The live screen, registration wizard and agent
 * tools keep working; only schedules/executions/uploads need the database.
 */
export function unavailableScheduler(reason: string): SchedulerRepository {
    const fail = () => { throw new SchedulerUnavailableError(reason); };
    const stub = {
        unavailable: true,
        reason,
        async listSchedules() { return []; },
        async listExecutions() { return []; },
        async execution() { return null; },
        async schedule() { return null; },
        async activeExecution() { return null; },
        async executionAssets() { return []; },
        async stopRequested() { return false; },
        async createTask() { return fail(); },
        async updateSchedule() { return fail(); },
        async setScheduleStatus() { return fail(); },
        async requestStop() { return 'not-found' as const; },
        async retryExecution() { return fail(); },
        async registerAssets() { return fail(); },
        async deleteAssets() { return fail(); },
        async attachAssets() { return fail(); },
        async materializeDue() { return 0; },
        async reconcileQueueStates() { return 0; },
        async cleanup() { return 0; },
        async sweepOrphanedAssets() { return 0; },
    };
    return stub as unknown as SchedulerRepository;
}

export function isSchedulerUnavailable(repository: SchedulerRepository): boolean {
    return Boolean((repository as unknown as { unavailable?: boolean }).unavailable);
}
