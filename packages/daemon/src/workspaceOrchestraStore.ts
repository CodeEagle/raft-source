import { delegationRecordSchema, assertDelegationContinuation, type DelegationRecord, type DelegationOutcome } from "@botiverse/raft-shared";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type WorkspaceOrchestraJobStatus =
  | "queued"
  | "starting"
  | "running"
  | "cancel_requested"
  | "uncertain"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked";

export interface EnqueueWorkspaceOrchestraJob {
  delegation?: DelegationRecord;
  /** Stable server-side run id; omitted only by compatibility callers. */
  id?: string;
  serverId: string;
  machineId: string;
  channelId: string;
  agentId: string;
  taskId: string;
  messageId: string;
  workspaceId: string;
  requestedPath?: string;
  canonicalWorkspacePath: string;
  workspaceRevision: number;
  instruction: string;
}

export interface WorkspaceOrchestraJob extends EnqueueWorkspaceOrchestraJob {
  id: string;
  dedupeKey: string;
  status: WorkspaceOrchestraJobStatus;
  leaseId: string | null;
  processInstanceId: string | null;
  pid: number | null;
  cancelRequested: boolean;
  outcome: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceOrchestraState {
  schemaVersion: 1;
  jobs: WorkspaceOrchestraJob[];
}

export type WorkspaceProcessLiveness = true | false | undefined;
export type WorkspaceProcessLivenessProbe = (pid: number) => WorkspaceProcessLiveness;

const ACTIVE_STATUSES = new Set<WorkspaceOrchestraJobStatus>([
  "starting",
  "running",
  "cancel_requested",
  "uncertain",
]);
const MAX_INSTRUCTION_CHARS = 128 * 1024;

function processIsAlive(pid: number): WorkspaceProcessLiveness {
  try {
    // Workspace workers use a dedicated process group. The group is the lock
    // owner because Codex may have child tool processes that outlive the
    // app-server parent briefly during shutdown.
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "ESRCH") {
      try {
        process.kill(pid, 0);
        return true;
      } catch (pidError) {
        const pidCode = typeof pidError === "object" && pidError !== null && "code" in pidError
          ? (pidError as { code?: unknown }).code
          : undefined;
        return pidCode === "EPERM" ? true : pidCode === "ESRCH" ? false : undefined;
      }
    }
    if (code === "EPERM") return true;
    return undefined;
  }
}

function isAbsoluteCanonicalPath(value: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value;
}

function pathsOverlap(left: string, right: string): boolean {
  const api = process.platform === "win32" ? path.win32 : path.posix;
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const parentPath = caseInsensitive ? left.toLowerCase() : left;
  const childPath = caseInsensitive ? right.toLowerCase() : right;
  const contains = (parent: string, child: string) => {
    const relative = api.relative(parent, child);
    return relative === "" || (!api.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${api.sep}`));
  };
  return contains(parentPath, childPath) || contains(childPath, parentPath);
}

function dedupeKey(input: Pick<EnqueueWorkspaceOrchestraJob, "serverId" | "messageId" | "agentId">): string {
  return `${input.serverId}\0${input.messageId}\0${input.agentId}`;
}

function cloneJob(job: WorkspaceOrchestraJob): WorkspaceOrchestraJob {
  return structuredClone(job);
}

function validateEnqueueInput(input: EnqueueWorkspaceOrchestraJob): void {
  for (const [key, value] of Object.entries({
    serverId: input.serverId,
    machineId: input.machineId,
    channelId: input.channelId,
    agentId: input.agentId,
    taskId: input.taskId,
    messageId: input.messageId,
    workspaceId: input.workspaceId,
  })) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Channel workspace task is missing ${key}`);
    }
  }
  if (!Number.isSafeInteger(input.workspaceRevision) || input.workspaceRevision < 1) {
    throw new Error("Channel workspace task requires a positive configuration revision");
  }
  if (typeof input.canonicalWorkspacePath !== "string" || !isAbsoluteCanonicalPath(input.canonicalWorkspacePath)) {
    throw new Error("Channel workspace task path must be canonical and absolute");
  }
  if (input.requestedPath !== undefined && (typeof input.requestedPath !== "string" || input.requestedPath.length > 4096)) {
    throw new Error("Channel workspace task requested path is invalid");
  }
  if (typeof input.instruction !== "string" || input.instruction.length > MAX_INSTRUCTION_CHARS) {
    throw new Error("Channel workspace task instruction exceeds the local storage limit");
  }
}

/**
 * Machine-local durable queue and writer-lock ledger. The daemon machine lock
 * gives one writer to this file. Active/uncertain rows are the locks: no TTL
 * exists, and a lock is released only after the executor is confirmed stopped.
 */
export class WorkspaceOrchestraStore {
  private readonly statePath: string;
  private state: WorkspaceOrchestraState;

  constructor(
    machineDir: string,
    private readonly probeLiveness: WorkspaceProcessLivenessProbe = processIsAlive,
    private readonly now: () => Date = () => new Date(),
  ) {
    const storeDir = path.join(path.resolve(machineDir), "workspace-orchestra");
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    this.statePath = path.join(storeDir, "state-v1.json");
    this.state = this.loadState();
    this.reconcile();
  }

  list(): WorkspaceOrchestraJob[] {
    return this.state.jobs.map(cloneJob);
  }

  get(jobId: string): WorkspaceOrchestraJob | null {
    const job = this.state.jobs.find((candidate) => candidate.id === jobId);
    return job ? cloneJob(job) : null;
  }

  enqueue(input: EnqueueWorkspaceOrchestraJob): { job: WorkspaceOrchestraJob; duplicate: boolean } {
    validateEnqueueInput(input);
    if (input.delegation) {
      delegationRecordSchema.parse(input.delegation);
      const c = input.delegation.contract;
      if (c.taskId !== input.taskId || c.runId !== input.id || c.workerId !== input.agentId
        || c.resource.id !== input.workspaceId || c.resource.revision !== input.workspaceRevision || c.resource.root !== input.canonicalWorkspacePath) {
        throw new Error("delegation_dispatch_identity_mismatch");
      }
    }
    const key = dedupeKey(input);
    const existing = this.state.jobs.find((job) => job.dedupeKey === key);
    if (existing) {
      if (Boolean(input.delegation) !== Boolean(existing.delegation)) throw new Error("delegation_contract_presence_mismatch");
      if (input.delegation && existing.delegation && input.delegation.contract.attemptId === existing.delegation.contract.attemptId
        && JSON.stringify(input.delegation.contract) !== JSON.stringify(existing.delegation.contract)) throw new Error("delegation_contract_conflict");
      if (input.delegation && existing.delegation && input.delegation.contract.attemptId !== existing.delegation.contract.attemptId) {
        if (existing.status !== "blocked" || existing.cancelRequested) throw new Error("delegation_run_not_continuable");
        assertDelegationContinuation(existing.delegation, input.delegation);
        if (existing.machineId !== input.machineId || existing.channelId !== input.channelId || existing.canonicalWorkspacePath !== input.canonicalWorkspacePath || existing.workspaceRevision !== input.workspaceRevision) throw new Error("delegation_resource_changed");
        Object.assign(existing, { delegation: structuredClone(input.delegation), instruction: input.instruction, status: "queued", leaseId: null, pid: null, processInstanceId: null, outcome: null, updatedAt: this.now().toISOString() });
        this.persist();
        return { job: cloneJob(existing), duplicate: false };
      }
      if (
        existing.taskId !== input.taskId
        || existing.instruction !== input.instruction
        || existing.workspaceId !== input.workspaceId
        || existing.requestedPath !== input.requestedPath
        || existing.canonicalWorkspacePath !== input.canonicalWorkspacePath
        || existing.workspaceRevision !== input.workspaceRevision
      ) {
        throw new Error("Duplicate Channel workspace request conflicts with its persisted task or binding revision");
      }
      if (existing.status === "blocked" && !existing.cancelRequested && !existing.delegation?.outcome) {
        Object.assign(existing, { status: "queued", leaseId: null, pid: null, processInstanceId: null });
        this.persist();
      }
      return { job: cloneJob(existing), duplicate: true };
    }

    const now = this.now().toISOString();
    const job: WorkspaceOrchestraJob = {
      ...structuredClone(input),
      id: input.id ?? randomUUID(),
      dedupeKey: key,
      status: "queued",
      leaseId: null,
      processInstanceId: null,
      pid: null,
      cancelRequested: false,
      outcome: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.jobs.push(job);
    this.persist();
    return { job: cloneJob(job), duplicate: false };
  }

  /** Atomically reserve the oldest non-conflicting job before a worker spawn. */
  claimNext(canClaim: (job: WorkspaceOrchestraJob) => boolean = () => true): WorkspaceOrchestraJob | null {
    const job = this.state.jobs.find((candidate) => {
      if (candidate.status !== "queued") return false;
      if (!canClaim(candidate)) return false;
      return !this.state.jobs.some((active) => (
        active.id !== candidate.id
        && ACTIVE_STATUSES.has(active.status)
        && pathsOverlap(active.canonicalWorkspacePath, candidate.canonicalWorkspacePath)
      ));
    });
    if (!job) return null;
    job.status = "starting";
    job.leaseId = randomUUID();
    job.processInstanceId = randomUUID();
    job.pid = null;
    job.updatedAt = this.now().toISOString();
    this.persist();
    return cloneJob(job);
  }

  recordWorkerSpawned(jobId: string, leaseId: string, pid: number): WorkspaceOrchestraJob {
    const job = this.requireLease(jobId, leaseId);
    if (job.status !== "starting" || !Number.isInteger(pid) || pid <= 0) {
      throw new Error("Workspace worker spawn receipt does not match a starting lease and positive pid");
    }
    job.pid = pid;
    job.status = "running";
    job.updatedAt = this.now().toISOString();
    this.persist();
    return cloneJob(job);
  }

  requestCancel(jobId: string): WorkspaceOrchestraJob {
    const job = this.state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error("Channel workspace task was not found");
    if (job.status === "queued" || job.status === "blocked") {
      job.status = "cancelled";
      job.cancelRequested = true;
      job.outcome = "cancelled_before_start";
      job.updatedAt = this.now().toISOString();
      this.persist();
      return cloneJob(job);
    }
    if (!ACTIVE_STATUSES.has(job.status)) return cloneJob(job);
    job.status = "cancel_requested";
    job.cancelRequested = true;
    job.updatedAt = this.now().toISOString();
    this.persist();
    return cloneJob(job);
  }

  finish(
    jobId: string,
    leaseId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "blocked",
    detail: string,
    processStoppedConfirmed: boolean,
    workerOutcome?: DelegationOutcome,
  ): WorkspaceOrchestraJob {
    const job = this.requireLease(jobId, leaseId);
    if (job.delegation && ((outcome === "succeeded" && workerOutcome?.kind !== "completed")
      || (outcome === "blocked" && job.pid !== null && workerOutcome?.kind !== "needs_operation"))) {
      outcome = "failed";
      detail = "invalid_delegation_worker_result";
    }
    job.updatedAt = this.now().toISOString();
    if (workerOutcome && job.delegation) job.delegation = delegationRecordSchema.parse({ ...job.delegation, outcome: workerOutcome });
    job.outcome = detail.slice(0, 4000);
    if (!processStoppedConfirmed) {
      job.status = "uncertain";
      job.outcome = `process_stop_unconfirmed: ${job.outcome}`.slice(0, 4000);
      this.persist();
      return cloneJob(job);
    }
    job.status = job.cancelRequested ? "cancelled" : outcome;
    this.persist();
    return cloneJob(job);
  }

  /** Reconcile after restart. Unknown liveness never releases a writer lock. */
  reconcile(): WorkspaceOrchestraJob[] {
    let changed = false;
    for (const job of this.state.jobs) {
      if (!ACTIVE_STATUSES.has(job.status)) continue;
      if (job.pid === null) {
        if (job.status !== "uncertain") {
          job.status = "uncertain";
          job.outcome = "worker_process_identity_missing_after_restart";
          job.updatedAt = this.now().toISOString();
          changed = true;
        }
        continue;
      }
      const alive = this.probeLiveness(job.pid);
      if (alive === false) {
        job.status = job.cancelRequested ? "cancelled" : "failed";
        job.outcome = job.cancelRequested
          ? "worker_stopped_during_cancel_reconciliation"
          : "worker_stopped_during_restart_reconciliation";
        job.updatedAt = this.now().toISOString();
        changed = true;
      } else {
        if (job.status !== "uncertain") {
          job.status = "uncertain";
          job.outcome = alive === true
            ? "worker_survived_daemon_restart; lock retained"
            : "worker_liveness_unknown; lock retained";
          job.updatedAt = this.now().toISOString();
          changed = true;
        }
      }
    }
    if (changed) this.persist();
    return this.list();
  }

  private requireLease(jobId: string, leaseId: string): WorkspaceOrchestraJob {
    const job = this.state.jobs.find((candidate) => candidate.id === jobId);
    if (!job || job.leaseId !== leaseId || !ACTIVE_STATUSES.has(job.status)) {
      throw new Error("Channel workspace writer lease is not active for this task");
    }
    return job;
  }

  private loadState(): WorkspaceOrchestraState {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<WorkspaceOrchestraState>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.jobs)) {
        throw new Error("Channel workspace orchestra state has an unsupported schema");
      }
      for (const job of parsed.jobs) {
        if (job.delegation !== undefined) delegationRecordSchema.parse(job.delegation);
      }
      return parsed as WorkspaceOrchestraState;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
        return { schemaVersion: 1, jobs: [] };
      }
      throw error;
    }
  }

  private persist(): void {
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(this.state)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporaryPath, this.statePath);
    } catch (error) {
      try { rmSync(temporaryPath, { force: true }); } catch { /* preserve original persistence error */ }
      throw error;
    }
  }
}
