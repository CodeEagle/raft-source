import { describe, expect, test } from "vitest";
import { selectThreadContextMessages, THREAD_CONTEXT_BODY_BUDGET, THREAD_CONTEXT_CANDIDATE_LIMIT } from "./threadContextSelection";
import type { AgentThreadContextMessage } from "@botiverse/raft-shared";
const row = (seq: number, sender: AgentThreadContextMessage["sender_type"] = "agent", content = `message ${seq}`): AgentThreadContextMessage => ({
  message_id: `${seq.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`,
  sender_name: sender, sender_type: sender, content, seq, timestamp: "2026-10-20T00:00:00.000Z",
});
const select = (candidates: AgentThreadContextMessage[], triggerContent = "@worker continue") => selectThreadContextMessages({ candidates, beforeSeq: 100, triggerContent, rootMessageId: "root" });
describe("bounded thread context selection", () => {
  test("preserves a human requirement buried by status updates and returns original chronological rows", () => {
    const ask = row(1, "human", "Do not deploy; prepare a reviewable patch");
    const rows = [ask, ...Array.from({ length: 15 }, (_, i) => row(i + 2))];
    const result = select(rows);
    expect(result.messages).toHaveLength(6);
    expect(result.messages[0]).toBe(ask);
    expect(result.messages.at(-1)).toBe(rows.at(-1));
    expect(result.messages.map(m => m.seq)).toEqual([1, 12, 13, 14, 15, 16]);
    expect(result.historyTruncated).toBe(true);
    expect(rows).toHaveLength(16);
  });
  test("keeps the latest human correction as well as opening human context", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1));
    rows[0] = row(1, "human", "old request"); rows[11] = row(12, "human", "Correction: do not publish");
    expect(select(rows).messages.map(m => m.seq)).toEqual([1, 12, 17, 18, 19, 20]);
  });
  test("prioritizes explicit references only inside supplied candidates", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1));
    const result = select(rows, `follow #work:${rows[3].message_id.slice(0,8)} and msg=${rows[7].message_id.slice(0,8)}; unknown #secret:ffffffff`);
    expect(result.messages.map(m => m.seq)).toEqual([1, 4, 8, 18, 19, 20]);
    expect(result.messages.every(m => rows.includes(m))).toBe(true);
  });
  test("full UUID references work; short ID prefixes cannot match longer hex tokens", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1));
    expect(select(rows, rows[4].message_id).messages).toContain(rows[4]);
    expect(select(rows, `msg=${rows[4].message_id.slice(0,8)}f`).messages).not.toContain(rows[4]);
  });
  test("deduplicates, excludes root, current/future and invalid sequence, and bounds lookback", () => {
    const rows = Array.from({ length: 80 }, (_, i) => row(i + 1));
    rows[0] = row(1, "human");
    const result = select([...rows, rows[79], row(100), row(101), {...row(90), seq: undefined}, {...row(91),message_id:"root"}]);
    expect(result.messages).toHaveLength(6);
    expect(new Set(result.messages.map(m=>m.message_id)).size).toBe(6);
    expect(result.messages.every(m=>m.seq!<100 && m.seq!>80-THREAD_CONTEXT_CANDIDATE_LIMIT)).toBe(true);
    expect(result.historyTruncated).toBe(true);
  });
  test("budgets earlier reply bodies without clipping or falsely acknowledging long messages", () => {
    const long = row(3, "human", "x".repeat(THREAD_CONTEXT_BODY_BUDGET+1));
    const rows = [row(1), row(2), long, row(4)];
    const result = select(rows);
    expect(result.messages).not.toContain(long);
    expect(result.messages.reduce((n,m)=>n+m.content.length,0)).toBeLessThanOrEqual(THREAD_CONTEXT_BODY_BUDGET);
    expect(result.messages.every(m=>rows.includes(m))).toBe(true);
    expect(result.historyTruncated).toBe(true);
  });
  test("an entirely oversized history is omitted honestly; empty history stays empty", () => {
    expect(select([row(1,"agent","x".repeat(THREAD_CONTEXT_BODY_BUDGET+1))])).toEqual({messages:[],historyTruncated:true});
    expect(select([])).toEqual({messages:[],historyTruncated:false});
  });
  test("short history is kept verbatim, in order, without truncation", () => {
    const rows = [row(1,"system"),row(2,"human"),row(3)];
    const result = select([...rows].reverse());
    expect(result).toEqual({messages:rows,historyTruncated:false});
  });
});
