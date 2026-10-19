import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Button, Input } from "raft-ui";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import api from "../../api/client";
import { getSocket } from "../../api/socket";
import { useChannelMembers } from "../../hooks/useChannelMembers";

type WorkspaceMode = "reader" | "writer";
type WorkspaceStatus = "unverified" | "available" | "missing" | "not_directory" | "permission_denied" | "invalid_path" | "offline" | "alias_conflict";
type WorkspaceRunStatus = "queued" | "starting" | "running" | "cancel_requested" | "uncertain" | "succeeded" | "failed" | "cancelled" | "blocked";

interface WorkspaceDraft {
  workspaceId?: string;
  machineId: string;
  path: string;
  mode: WorkspaceMode;
  canonicalPath?: string | null;
  validationStatus?: WorkspaceStatus;
  validationMessage?: string | null;
}

interface WorkspaceConfigResponse {
  revision: number;
  execution?: {
    enabled: boolean;
    runtime: string;
    sandboxProfiles: Array<"read-only" | "workspace-write">;
    conversationLane: "workspace_read_only_on_next_start" | "unsupported";
    workerLane: "scheduled" | "unsupported";
    reason: "orchestra_active" | "runtime_sandbox_unverified";
  };
  bindings: Array<{
    workspaceId: string;
    machineId: string;
    path: string;
    canonicalPath: string | null;
    validationStatus: WorkspaceStatus;
    validationMessage: string | null;
    mode: WorkspaceMode;
    position: number;
  }>;
}

interface MachineSummary {
  id: string;
  name: string;
  status?: string;
}

interface WorkspaceTaskRun {
  id: string;
  status: WorkspaceRunStatus;
  result: string | null;
  createdAt: string;
  updatedAt: string;
  taskId: string;
  taskNumber: number;
  title: string;
  taskStatus: string;
  workspaceId: string;
}

function responseErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("response" in error)) return null;
  const response = (error as { response?: { data?: { code?: unknown } } }).response;
  return typeof response?.data?.code === "string" ? response.data.code : null;
}

export default function ChannelWorkspaceSettings({
  channelId,
  serverId,
  canManage,
}: {
  channelId: string;
  serverId: string;
  canManage: boolean;
}) {
  const { formatMessage } = useIntl();
  const { channelAgents: agents, loading: membersLoading } = useChannelMembers(channelId, { enabled: canManage });
  const eligibleAgents = useMemo(
    () => agents.filter((agent) => agent.executionMode === "byoc" && Boolean(agent.machineId) && !agent.external),
    [agents],
  );
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const selectedAgent = eligibleAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  const [machines, setMachines] = useState<MachineSummary[]>([]);
  const [revision, setRevision] = useState(0);
  const [execution, setExecution] = useState<WorkspaceConfigResponse["execution"]>(undefined);
  const [bindings, setBindings] = useState<WorkspaceDraft[]>([]);
  const [runs, setRuns] = useState<WorkspaceTaskRun[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [submittingTask, setSubmittingTask] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const requestIdRef = useRef(0);
  const taskIdempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedAgentId && eligibleAgents.length > 0) {
      setSelectedAgentId(eligibleAgents[0]!.id);
    } else if (selectedAgentId && !eligibleAgents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(eligibleAgents[0]?.id ?? "");
    }
  }, [eligibleAgents, selectedAgentId]);

  useEffect(() => {
    let cancelled = false;
    void api.get(`/servers/${serverId}/machines`).then(({ data }) => {
      if (cancelled) return;
      setMachines(Array.isArray(data.machines) ? data.machines as MachineSummary[] : []);
    }).catch(() => {
      if (!cancelled) setMachines([]);
    });
    return () => { cancelled = true; };
  }, [serverId]);

  const loadConfig = useCallback(async (agentId: string) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    setStatus("");
    try {
      const { data } = await api.get<WorkspaceConfigResponse>(`/channels/${channelId}/workspaces/${agentId}`);
      if (requestId !== requestIdRef.current) return;
      setRevision(data.revision);
      setExecution(data.execution);
      setBindings(data.bindings.map((binding) => ({
        workspaceId: binding.workspaceId,
        machineId: binding.machineId,
        path: binding.path,
        mode: binding.mode,
        canonicalPath: binding.canonicalPath,
        validationStatus: binding.validationStatus,
        validationMessage: binding.validationMessage,
      })));
    } catch {
      if (requestId === requestIdRef.current) {
        setError(formatMessage({ id: "channel.workspace.loadFailed" }));
        setBindings([]);
        setExecution(undefined);
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [channelId, formatMessage]);

  const loadRuns = useCallback(async (agentId: string) => {
    try {
      const { data } = await api.get<{ runs: WorkspaceTaskRun[] }>(`/channels/${channelId}/workspaces/${agentId}/tasks`);
      const nextRuns = Array.isArray(data.runs) ? data.runs : [];
      setRuns(nextRuns);
      return nextRuns;
    } catch {
      setRuns([]);
      return [];
    }
  }, [channelId]);

  useEffect(() => {
    if (!selectedAgentId) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      const nextRuns = await loadRuns(selectedAgentId);
      if (cancelled) return;
      if (nextRuns.some((run) => ["queued", "starting", "running", "cancel_requested", "uncertain"].includes(run.status))) {
        timer = setTimeout(() => { void refresh(); }, 3000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [loadRuns, selectedAgentId]);

  useEffect(() => {
    if (!selectedAgentId) return;
    const socket = getSocket();
    const handler = (event: { channelId?: string; agentId?: string }) => {
      if (event.channelId === channelId && event.agentId === selectedAgentId) void loadRuns(selectedAgentId);
    };
    socket.on("channel:workspace-task-updated", handler);
    return () => { socket.off("channel:workspace-task-updated", handler); };
  }, [channelId, loadRuns, selectedAgentId]);

  useEffect(() => {
    if (selectedAgentId) void loadConfig(selectedAgentId);
    else {
      setRevision(0);
      setExecution(undefined);
      setBindings([]);
      setError("");
      setRuns([]);
    }
  }, [loadConfig, selectedAgentId]);

  const addBinding = () => {
    if (!selectedAgent?.machineId || bindings.length >= 8) return;
    setBindings((current) => [...current, {
      machineId: selectedAgent.machineId!,
      path: "",
      mode: "reader",
    }]);
    setError("");
    setStatus("");
  };

  const updateBinding = (index: number, patch: Partial<WorkspaceDraft>) => {
    setBindings((current) => current.map((binding, currentIndex) =>
      currentIndex === index ? {
        ...binding,
        ...patch,
        ...(patch.path !== undefined ? { workspaceId: undefined } : {}),
        validationStatus: undefined,
        validationMessage: undefined,
      } : binding,
    ));
    setError("");
    setStatus("");
  };

  const save = async () => {
    if (!selectedAgent) return;
    if (bindings.some((binding) => !binding.path.trim())) {
      setError(formatMessage({ id: "channel.workspace.pathRequired" }));
      return;
    }
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const { data } = await api.put<WorkspaceConfigResponse & { executionEnabled?: boolean }>(
        `/channels/${channelId}/workspaces/${selectedAgent.id}`,
        {
          expectedRevision: revision,
          bindings: bindings.map(({ machineId, path, mode }) => ({ machineId, path: path.trim(), mode })),
        },
      );
      setRevision(data.revision);
      setExecution(data.execution);
      setBindings(data.bindings.map((binding) => ({
        workspaceId: binding.workspaceId,
        machineId: binding.machineId,
        path: binding.path,
        mode: binding.mode,
        canonicalPath: binding.canonicalPath,
        validationStatus: binding.validationStatus,
        validationMessage: binding.validationMessage,
      })));
      setStatus(formatMessage({ id: "channel.workspace.saved" }));
    } catch (saveError) {
      const code = responseErrorCode(saveError);
      if (code === "channel_workspace_revision_conflict") {
        setError(formatMessage({ id: "channel.workspace.revisionConflict" }));
      } else if (code === "workspace_path_overlap") {
        setError(formatMessage({ id: "channel.workspace.overlappingPaths" }));
      } else if (code === "workspace_agent_not_on_device" || code === "workspace_machine_unavailable") {
        setError(formatMessage({ id: "channel.workspace.onDeviceOnly" }));
      } else {
        setError(formatMessage({ id: "channel.workspace.saveFailed" }));
      }
    } finally {
      setSaving(false);
    }
  };

  const availableWriterBindings = useMemo(() => bindings.filter((binding) => (
    binding.mode === "writer"
    && binding.workspaceId
    && binding.validationStatus === "available"
    && Boolean(binding.canonicalPath)
  )), [bindings]);

  useEffect(() => {
    if (!availableWriterBindings.some((binding) => binding.workspaceId === selectedWorkspaceId)) {
      setSelectedWorkspaceId(availableWriterBindings[0]?.workspaceId ?? "");
    }
  }, [availableWriterBindings, selectedWorkspaceId]);

  const submitWorkspaceTask = async () => {
    if (!selectedAgent || !selectedWorkspaceId || !instruction.trim()) return;
    setSubmittingTask(true);
    setError("");
    setStatus("");
    try {
      await api.post(`/channels/${channelId}/workspaces/${selectedAgent.id}/tasks`, {
        workspaceId: selectedWorkspaceId,
        instruction: instruction.trim(),
        idempotencyKey: taskIdempotencyKeyRef.current ?? (taskIdempotencyKeyRef.current = crypto.randomUUID()),
      });
      setInstruction("");
      taskIdempotencyKeyRef.current = null;
      setStatus(formatMessage({ id: "channel.workspace.taskQueued" }));
      await loadRuns(selectedAgent.id);
    } catch {
      setError(formatMessage({ id: "channel.workspace.taskSubmitFailed" }));
    } finally {
      setSubmittingTask(false);
    }
  };

  const cancelWorkspaceTask = async (runId: string) => {
    if (!selectedAgent) return;
    try {
      await api.post(`/channels/${channelId}/workspaces/${selectedAgent.id}/tasks/${runId}/cancel`);
      await loadRuns(selectedAgent.id);
    } catch {
      setError(formatMessage({ id: "channel.workspace.taskActionFailed" }));
    }
  };

  const retryWorkspaceTask = async (runId: string) => {
    if (!selectedAgent) return;
    try {
      await api.post(`/channels/${channelId}/workspaces/${selectedAgent.id}/tasks/${runId}/retry`);
      await loadRuns(selectedAgent.id);
    } catch {
      setError(formatMessage({ id: "channel.workspace.taskActionFailed" }));
    }
  };

  const runStatusLabel = (runStatus: WorkspaceRunStatus) => formatMessage({ id: `channel.workspace.runStatus.${runStatus}` });

  const runStatusTone = (runStatus: WorkspaceRunStatus) => {
    if (runStatus === "cancel_requested") return "text-amber-700 dark:text-amber-300";
    if (runStatus === "cancelled") return "text-foreground-muted";
    if (runStatus === "succeeded") return "text-emerald-700 dark:text-emerald-300";
    if (runStatus === "failed" || runStatus === "blocked") return "text-red-700 dark:text-red-300";
    return "text-foreground-muted";
  };

  const statusLabel = (binding: WorkspaceDraft) => {
    switch (binding.validationStatus) {
      case "available": return formatMessage({ id: "channel.workspace.available" });
      case "missing": return formatMessage({ id: "channel.workspace.missing" });
      case "not_directory": return formatMessage({ id: "channel.workspace.notDirectory" });
      case "permission_denied": return formatMessage({ id: "channel.workspace.permissionDenied" });
      case "invalid_path": return formatMessage({ id: "channel.workspace.invalidPath" });
      case "offline": return formatMessage({ id: "channel.workspace.machineOffline" });
      case "alias_conflict": return formatMessage({ id: "channel.workspace.aliasConflict" });
      default: return formatMessage({ id: "channel.workspace.unverified" });
    }
  };

  if (!canManage) return null;
  const machineName = selectedAgent?.machineId
    ? machines.find((machine) => machine.id === selectedAgent.machineId)?.name ?? selectedAgent.machineId
    : "";
  const executionRuntime = execution?.runtime ?? selectedAgent?.runtime;

  return (
    <section className="mt-5 space-y-3" data-testid="channel-workspace-settings">
      <div>
        <h3 className="text-sm font-bold text-foreground-strong">
          {formatMessage({ id: "channel.workspace.title" })}
        </h3>
        <p className="mt-1 text-xs text-foreground-muted">
          {formatMessage({ id: "channel.workspace.description" })}
        </p>
        <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
          {execution?.reason === "orchestra_active" || (!execution && executionRuntime === "codex")
            ? formatMessage({ id: "channel.workspace.executionDisabledCodex" })
            : executionRuntime
              ? formatMessage({ id: "channel.workspace.executionDisabledRuntime" }, { runtime: executionRuntime })
              : formatMessage({ id: "channel.workspace.executionDisabled" })}
        </p>
      </div>

      {membersLoading ? (
        <p className="text-sm text-foreground-muted">{formatMessage({ id: "channel.workspace.loadingAgents" })}</p>
      ) : eligibleAgents.length === 0 ? (
        <p className="rounded border border-line-muted p-3 text-sm text-foreground-muted">
          {formatMessage({ id: "channel.workspace.noOnDeviceAgents" })}
        </p>
      ) : (
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-foreground-muted">
              {formatMessage({ id: "channel.workspace.agentLabel" })}
            </span>
            <select
              value={selectedAgentId}
              onChange={(event) => {
                taskIdempotencyKeyRef.current = null;
                setSelectedAgentId(event.target.value);
              }}
              className="min-h-10 w-full rounded border border-line-muted bg-layer-canvas px-3 py-2 text-sm text-foreground-strong"
              aria-label={formatMessage({ id: "channel.workspace.agentLabel" })}
              disabled={loading || saving}
            >
              {eligibleAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.displayName || agent.name}</option>
              ))}
            </select>
          </label>

          {selectedAgent?.machineId && (
            <p className="text-xs text-foreground-muted" data-testid="channel-workspace-machine">
              {formatMessage({ id: "channel.workspace.machineLabel" }, { machine: machineName })}
            </p>
          )}

          {loading ? (
            <p className="text-sm text-foreground-muted">{formatMessage({ id: "channel.workspace.loading" })}</p>
          ) : bindings.length === 0 ? (
            <p className="rounded border border-line-muted p-3 text-sm text-foreground-muted">
              {formatMessage({ id: "channel.workspace.empty" })}
            </p>
          ) : (
            <div className="space-y-2">
              {bindings.map((binding, index) => (
                <div key={`${binding.machineId}:${index}`} className="rounded border border-line-muted p-3" data-testid="channel-workspace-binding">
                  <div className="flex items-start gap-2">
                    <label className="min-w-0 flex-1 space-y-1">
                      <span className="text-xs font-semibold text-foreground-muted">
                        {formatMessage({ id: "channel.workspace.pathLabel" })}
                      </span>
                      <Input
                        value={binding.path}
                        onChange={(event) => updateBinding(index, { path: event.target.value })}
                        placeholder={formatMessage({ id: "channel.workspace.pathPlaceholder" })}
                        aria-label={formatMessage({ id: "channel.workspace.pathLabel" })}
                        disabled={saving}
                      />
                    </label>
                    <label className="w-28 shrink-0 space-y-1">
                      <span className="text-xs font-semibold text-foreground-muted">
                        {formatMessage({ id: "channel.workspace.modeLabel" })}
                      </span>
                      <select
                        value={binding.mode}
                        onChange={(event) => updateBinding(index, { mode: event.target.value as WorkspaceMode })}
                        className="min-h-10 w-full rounded border border-line-muted bg-layer-canvas px-2 text-sm text-foreground-strong"
                        aria-label={formatMessage({ id: "channel.workspace.modeLabel" })}
                        disabled={saving}
                      >
                        <option value="reader">{formatMessage({ id: "channel.workspace.reader" })}</option>
                        <option value="writer">{formatMessage({ id: "channel.workspace.writer" })}</option>
                      </select>
                    </label>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={formatMessage({ id: "channel.workspace.remove" })}
                      onClick={() => setBindings((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                      disabled={saving}
                      className="mt-5 shrink-0"
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                  <p className={`mt-2 text-xs ${binding.validationStatus === "available" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>
                    {statusLabel(binding)}
                    {binding.validationMessage ? ` — ${binding.validationMessage}` : ""}
                  </p>
                  {binding.canonicalPath && binding.canonicalPath !== binding.path && (
                    <p className="mt-1 break-all font-mono text-[11px] text-foreground-muted">
                      {formatMessage({ id: "channel.workspace.resolvedPath" }, { path: binding.canonicalPath })}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={addBinding} disabled={!selectedAgent?.machineId || bindings.length >= 8 || saving || loading}>
              <Plus size={16} />
              {formatMessage({ id: "channel.workspace.add" })}
            </Button>
            <Button type="button" size="sm" variant="accent" onClick={() => void save()} disabled={saving || loading || !selectedAgent}>
              {saving ? formatMessage({ id: "channel.workspace.saving" }) : formatMessage({ id: "channel.workspace.save" })}
            </Button>
            {selectedAgent && (
              <Button type="button" size="sm" variant="outline" onClick={() => void loadConfig(selectedAgent.id)} disabled={loading || saving}>
                <RefreshCw size={14} />
                {formatMessage({ id: "channel.workspace.reload" })}
              </Button>
            )}
          </div>
          {error && <p role="alert" className="text-sm text-danger-strong">{error}</p>}
          {status && <p role="status" className="text-sm text-foreground-muted">{status}</p>}

          {execution?.enabled && selectedAgent?.runtime === "codex" && (
            <div className="space-y-3 rounded border border-line-muted p-3" data-testid="channel-workspace-orchestra">
              <div>
                <h4 className="text-sm font-semibold text-foreground-strong">
                  {formatMessage({ id: "channel.workspace.tasksTitle" })}
                </h4>
                <p className="mt-1 text-xs text-foreground-muted">
                  {formatMessage({ id: "channel.workspace.tasksDescription" })}
                </p>
              </div>
              {availableWriterBindings.length === 0 ? (
                <p className="text-sm text-foreground-muted">{formatMessage({ id: "channel.workspace.writerRequired" })}</p>
              ) : (
                <>
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold text-foreground-muted">
                      {formatMessage({ id: "channel.workspace.taskWorkspaceLabel" })}
                    </span>
                    <select
                      value={selectedWorkspaceId}
                      onChange={(event) => {
                        taskIdempotencyKeyRef.current = null;
                        setSelectedWorkspaceId(event.target.value);
                      }}
                      className="min-h-10 w-full rounded border border-line-muted bg-layer-canvas px-3 py-2 text-sm text-foreground-strong"
                      disabled={submittingTask || saving}
                    >
                      {availableWriterBindings.map((binding) => (
                        <option key={binding.workspaceId} value={binding.workspaceId}>{binding.path}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold text-foreground-muted">
                      {formatMessage({ id: "channel.workspace.instructionLabel" })}
                    </span>
                    <textarea
                      value={instruction}
                      onChange={(event) => {
                        taskIdempotencyKeyRef.current = null;
                        setInstruction(event.target.value);
                      }}
                      rows={4}
                      maxLength={32000}
                      className="w-full rounded border border-line-muted bg-layer-canvas px-3 py-2 text-sm text-foreground-strong"
                      placeholder={formatMessage({ id: "channel.workspace.instructionPlaceholder" })}
                      disabled={submittingTask || saving}
                    />
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="accent"
                    onClick={() => void submitWorkspaceTask()}
                    disabled={submittingTask || saving || loading || !selectedWorkspaceId || !instruction.trim()}
                  >
                    {submittingTask
                      ? formatMessage({ id: "channel.workspace.submittingTask" })
                      : formatMessage({ id: "channel.workspace.submitTask" })}
                  </Button>
                </>
              )}

              {runs.length > 0 && (
                <ul className="space-y-2" aria-label={formatMessage({ id: "channel.workspace.tasksTitle" })}>
                  {runs.map((run) => {
                    const canCancel = ["queued", "starting", "running", "uncertain"].includes(run.status);
                    const canRetry = run.status === "queued" || run.status === "blocked";
                    return (
                      <li key={run.id} className="rounded border border-line-muted p-3" data-testid="channel-workspace-task-run">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium text-foreground-strong">task #{run.taskNumber} · {run.title}</p>
                          <span
                            className={`text-xs ${runStatusTone(run.status)}`}
                            data-testid="channel-workspace-task-run-status"
                            data-status={run.status}
                            aria-label={runStatusLabel(run.status)}
                          >
                            {runStatusLabel(run.status)}
                          </span>
                        </div>
                        {run.result && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-foreground-muted">{run.result}</p>}
                        <div className="mt-2 flex gap-2">
                          {canCancel && (
                            <Button type="button" size="sm" variant="outline" onClick={() => void cancelWorkspaceTask(run.id)}>
                              {formatMessage({ id: "channel.workspace.cancelTask" })}
                            </Button>
                          )}
                          {canRetry && (
                            <Button type="button" size="sm" variant="outline" onClick={() => void retryWorkspaceTask(run.id)}>
                              {formatMessage({ id: "channel.workspace.retryTask" })}
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
