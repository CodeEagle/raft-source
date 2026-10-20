import { useEffect, useRef, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { Button, ComposerIconButton, Input } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import api from "../../api/client";
import DialogCard from "../ui/DialogCard";
import Tooltip from "../ui/Tooltip";
import type { SecureInputResult } from "@botiverse/raft-shared";

interface Target { id: string; name: string; displayName: string | null; machineName: string }
export default function SecureInputButton({ channelId }: { channelId: string }) {
  const { formatMessage: t } = useIntl();
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<Target[]>([]);
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [result, setResult] = useState<SecureInputResult | null>(null);
  const request = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    setOpen(false); abort.current?.abort();
    return () => { abort.current?.abort(); };
  }, [channelId]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api.get<{ agents: Target[] }>("/secure-input", { params: { channelId }, signal: controller.signal })
      .then(({ data }) => { setTargets(data.agents); setAgentId(data.agents.length === 1 ? data.agents[0]!.id : ""); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [open, channelId]);
  function close() { abort.current?.abort(); setOpen(false); }
  async function submit(operation: "collect" | "revoke") {
    if (busy) return;
    setBusy(true); setError(false);
    request.current ??= crypto.randomUUID();
    const controller = new AbortController(); abort.current = controller;
    try {
      const { data } = await api.post<SecureInputResult>("/secure-input", {
        channelId, agentId, requestId: request.current, name, ttlSeconds: 3600, allowAgentRead: allow, operation,
      }, { signal: controller.signal, timeout: 140_000 });
      if (!controller.signal.aborted) setResult(data);
    } catch { if (!controller.signal.aborted) setError(true); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <>
    <Tooltip content={t({ id: "secureInput.title" })}>
      <ComposerIconButton type="button" aria-label={t({ id: "secureInput.title" })} onClick={() => {
        request.current = null; setResult(null); setName(""); setAllow(false); setError(false); setBusy(false); setOpen(true);
      }}><LockKeyhole size={18} /></ComposerIconButton>
    </Tooltip>
    {open && <DialogCard title={t({ id: "secureInput.title" })} onClose={close} testId="secure-input-dialog">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t({ id: "secureInput.description" })}</p>
        <p className="text-sm text-muted-foreground">{t({ id: "secureInput.protectedUnavailable" })}</p>
        {result?.status === "stored" ? <>
          <p role="status">{t({ id: "secureInput.saved" })}</p>
          <code className="block break-all text-sm">{result.path}</code>
          <p className="text-sm text-muted-foreground">{t({ id: "secureInput.expiry" }, { time: result.expiresAt })}</p>
          <Button type="button" disabled={busy} onClick={() => void submit("revoke")}>{t({ id: "secureInput.delete" })}</Button>
        </> : result?.status === "revoked" ? <p role="status">{t({ id: "secureInput.deleted" })}</p> : <>
          <label className="block space-y-1 text-sm">
            <span>{t({ id: "secureInput.recipient" })}</span>
            <select className="w-full rounded-control border border-border bg-background p-2" value={agentId} disabled={busy} onChange={(event) => { request.current = null; setAgentId(event.target.value); }}>
              <option value="">{t({ id: "secureInput.choose" })}</option>
              {targets.map((target) => <option key={target.id} value={target.id}>{target.displayName || target.name} — {target.machineName}</option>)}
            </select>
          </label>
          {!targets.length && <p className="text-sm text-muted-foreground">{t({ id: "secureInput.noTargets" })}</p>}
          <label className="block space-y-1 text-sm">
            <span>{t({ id: "secureInput.name" })}</span>
            <Input type="text" autoComplete="off" maxLength={64} value={name} disabled={busy} onChange={(event) => { request.current = null; setName(event.target.value); }} />
          </label>
          <p className="text-xs text-muted-foreground">{t({ id: "secureInput.nameRules" })}</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={allow} disabled={busy} onChange={(event) => setAllow(event.target.checked)} />
            <span>{t({ id: "secureInput.consent" })}</span>
          </label>
          <p className="text-sm text-muted-foreground">{t({ id: "secureInput.retention" })}</p>
          {result && <p role="status">{t({ id: "secureInput.notStored" })}</p>}
          <Button type="button" disabled={busy || !agentId || !allow || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)} onClick={() => void submit("collect")}>
            {t({ id: busy ? "secureInput.waiting" : "secureInput.openNative" })}
          </Button>
        </>}
        {error && <p role="alert" className="text-sm">{t({ id: "secureInput.error" })}</p>}
        {busy && <p className="text-sm text-muted-foreground">{t({ id: "secureInput.closePending" })}</p>}
      </div>
    </DialogCard>}
  </>;
}
