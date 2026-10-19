import assert from "node:assert/strict";
import { getServerCapabilities } from "@botiverse/raft-shared";
import {
  canCreateAgentForRole,
  canManageMachineForRole,
  canRegisterMachineForRole,
  filterAgentCreationMachines,
} from "../src/utils/memberAgentAccess";
import type { Machine } from "../src/store/machineStore";

function makeMachine(
  id: string,
  computerAttachedByCurrentUser: boolean,
): Machine {
  return {
    id,
    name: id,
    description: null,
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: ["codex"],
    hostname: `${id}.local`,
    os: "darwin",
    daemonVersion: "1.0.0",
    isComputer: true,
    computerAttachedByCurrentUser,
    creator: {
      type: "human",
      id: computerAttachedByCurrentUser ? "member-1" : "other-user",
      name: computerAttachedByCurrentUser ? "Member" : "Other",
      displayName: computerAttachedByCurrentUser ? "Member" : "Other",
      avatarUrl: null,
      gravatarHash: null,
    },
    computerVersion: "1.0.0",
    computerUpgradeAvailable: false,
    lastHeartbeat: "2026-10-15T00:00:00.000Z",
    createdAt: "2026-10-15T00:00:00.000Z",
  };
}

test("members can see their own Computer and Agent creation entry points", () => {
  const memberCapabilities = getServerCapabilities("member");

  assert.equal(canCreateAgentForRole("member", memberCapabilities), true);
  assert.equal(canRegisterMachineForRole("member", memberCapabilities), true);
});

test("member Agent creation is limited to Computers attached by that member", () => {
  const machines = [
    makeMachine("own-computer", true),
    makeMachine("other-computer", false),
  ];

  assert.deepEqual(
    filterAgentCreationMachines(machines, "member").map((machine) => machine.id),
    ["own-computer"],
  );
  assert.deepEqual(
    filterAgentCreationMachines(machines, "admin").map((machine) => machine.id),
    ["own-computer", "other-computer"],
  );
});

test("createAgents capability never grants a member control of another Computer", () => {
  const memberCapabilities = {
    ...getServerCapabilities("member"),
    createAgents: true,
  };

  assert.equal(
    canManageMachineForRole(
      makeMachine("other-computer", false),
      "member-1",
      "member",
      memberCapabilities,
    ),
    false,
  );
  assert.equal(
    canManageMachineForRole(
      makeMachine("own-computer", true),
      "member-1",
      "member",
      memberCapabilities,
    ),
    true,
  );
});
