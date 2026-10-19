import type { WorkspaceOrchestraJob } from "./workspaceOrchestraStore";
import { WorkspaceOrchestraStore } from "./workspaceOrchestraStore";

export interface WorkspaceOrchestraCompletion {
  outcome: "succeeded" | "failed" | "cancelled";
  detail: string;
  processStoppedConfirmed: boolean;
}

export type WorkspaceOrchestraRunner<Context> = (
  job: WorkspaceOrchestraJob,
  context: Context,
  control: {
    signal: AbortSignal;
    spawned(pid: number): WorkspaceOrchestraJob;
  },
) => Promise<WorkspaceOrchestraCompletion>;

/**
 * Independent, bounded worker scheduler. It owns no workspace policy itself:
 * the store owns locks and recovery; the injected runner must enforce the
 * runtime sandbox and must confirm process-group termination before returning.
 */
export class WorkspaceOrchestraExecutor<Context> {
  private readonly contexts = new Map<string, Context>();
  private readonly active = new Map<string, AbortController>();
  private draining = false;

  constructor(
    private readonly store: WorkspaceOrchestraStore,
    private readonly runner: WorkspaceOrchestraRunner<Context>,
    private readonly onUpdate: (job: WorkspaceOrchestraJob) => void | Promise<void>,
    private readonly maxConcurrent = 4,
  ) {}

  submit(input: Parameters<WorkspaceOrchestraStore["enqueue"]>[0], context: Context) {
    const result = this.store.enqueue(input);
    if (result.job.status === "queued") this.contexts.set(result.job.id, context);
    void this.publish(result.job);
    void this.drain();
    return result;
  }

  cancel(jobId: string): WorkspaceOrchestraJob {
    const job = this.store.requestCancel(jobId);
    if (job.status === "cancelled") this.contexts.delete(jobId);
    const active = this.active.get(jobId);
    if (active) active.abort();
    else if (job.status === "cancel_requested" && job.leaseId && job.pid) {
      void this.stopRecoveredWorker(job);
    }
    void this.publish(job);
    return job;
  }

  reconcile(): WorkspaceOrchestraJob[] {
    const jobs = this.store.reconcile();
    for (const job of jobs) void this.publish(job);
    return jobs;
  }

  list(): WorkspaceOrchestraJob[] {
    return this.store.list();
  }

  get(jobId: string): WorkspaceOrchestraJob | null {
    return this.store.get(jobId);
  }

  async stopAll(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled(Array.from(this.active.keys(), async (jobId) => {
      while (this.active.has(jobId)) await new Promise((resolve) => setTimeout(resolve, 25));
    }));
  }

  private async publish(job: WorkspaceOrchestraJob): Promise<void> {
    try {
      await this.onUpdate(job);
    } catch {
      // The durable local job state remains authoritative; server delivery is
      // retried when the request is replayed after reconnect.
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.active.size < this.maxConcurrent) {
        const job = this.store.claimNext((candidate) => this.contexts.has(candidate.id));
        if (!job || !job.leaseId) break;
        const context = this.contexts.get(job.id)!;
        this.contexts.delete(job.id);
        const controller = new AbortController();
        this.active.set(job.id, controller);
        void this.publish(job);
        void this.execute(job, context, controller);
      }
    } finally {
      this.draining = false;
    }
  }

  private async execute(job: WorkspaceOrchestraJob, context: Context, controller: AbortController): Promise<void> {
    const leaseId = job.leaseId!;
    try {
      const completion = await this.runner(job, context, {
        signal: controller.signal,
        spawned: (pid) => {
          const running = this.store.recordWorkerSpawned(job.id, leaseId, pid);
          void this.publish(running);
          return running;
        },
      });
      const terminal = this.store.finish(
        job.id,
        leaseId,
        completion.outcome,
        completion.detail,
        completion.processStoppedConfirmed,
      );
      await this.publish(terminal);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const terminal = this.store.finish(job.id, leaseId, "failed", detail, false);
      await this.publish(terminal);
    } finally {
      this.active.delete(job.id);
      void this.drain();
    }
  }

  private async stopRecoveredWorker(job: WorkspaceOrchestraJob): Promise<void> {
    const pid = job.pid;
    const leaseId = job.leaseId;
    if (!pid || !leaseId) return;
    try { process.kill(-pid, "SIGTERM"); } catch { /* the worker may already be gone */ }
    let stopped = await this.waitForRecoveredWorkerStop(pid, 2_000);
    if (!stopped) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* keep the lock if termination cannot be confirmed */ }
      stopped = await this.waitForRecoveredWorkerStop(pid, 2_000);
    }
    const result = this.store.finish(
      job.id,
      leaseId,
      "cancelled",
      stopped ? "worker_cancelled_after_daemon_restart" : "recovered_worker_stop_unconfirmed",
      stopped,
    );
    await this.publish(result);
    if (stopped) void this.drain();
  }

  private async waitForRecoveredWorkerStop(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let alive: boolean | undefined;
      try {
        process.kill(-pid, 0);
        alive = true;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (code === "ESRCH") {
          try {
            process.kill(pid, 0);
            alive = true;
          } catch (pidError) {
            const pidCode = typeof pidError === "object" && pidError !== null && "code" in pidError
              ? (pidError as { code?: unknown }).code
              : undefined;
            alive = pidCode === "EPERM" ? true : pidCode === "ESRCH" ? false : undefined;
          }
        } else if (code === "EPERM") alive = true;
      }
      if (alive === false) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }
}
