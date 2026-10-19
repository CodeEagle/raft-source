import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import Sidebar from "../src/components/layout/Sidebar";
import CreateAgentDialog from "../src/components/agent/CreateAgentDialog";
import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import MachineDetailPanel from "../src/components/machine/MachineDetailPanel";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const originalGet = api.get;
const originalPost = api.post;

const member = {
  id: "member-1",
  email: "member@example.test",
  name: "member",
  displayName: "Member",
};

const server = {
  id: "server-1",
  name: "Example Workspace",
  slug: "example-workspace",
  avatarUrl: null,
  ownerId: "owner-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "founder",
  planDowngradedAt: null,
  role: "member" as const,
  createdAt: "2026-10-15T00:00:00.000Z",
};

function makeMachine(id: string, name: string, attachedByCurrentUser: boolean) {
  return {
    id,
    name,
    description: null,
    status: "online" as const,
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: ["codex"],
    hostname: `${id}.local`,
    os: "darwin",
    daemonVersion: "1.0.0",
    isComputer: true,
    computerAttachedByCurrentUser: attachedByCurrentUser,
    creator: {
      type: "human" as const,
      id: attachedByCurrentUser ? member.id : "other-user",
      name: attachedByCurrentUser ? "member" : "other",
      displayName: attachedByCurrentUser ? "Member" : "Other",
      avatarUrl: null,
      gravatarHash: null,
    },
    computerVersion: "1.0.0",
    computerUpgradeAvailable: false,
    lastHeartbeat: "2026-10-15T00:00:00.000Z",
    createdAt: "2026-10-15T00:00:00.000Z",
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-other",
    serverId: server.id,
    name: "other-agent",
    displayName: "Other Agent",
    avatarUrl: null,
    description: null,
    status: "offline",
    model: "gpt-5",
    runtime: "codex",
    external: false,
    serverRole: null,
    runtimeConfig: null,
    lastRuntimeError: null,
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: "other-computer",
    creatorType: "user",
    creatorId: "other-user",
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}

function seedMember() {
  useAuthStore.setState({ user: member as never, loading: false, initialized: true } as never);
  useServerStore.setState({
    current: server,
    members: [],
    billing: null,
    loadingBilling: false,
    loadBilling: async () => undefined,
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
  } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], loading: false } as never);
  useMachineStore.setState({ machines: [], loading: false, loadStatus: "loaded", loadError: false } as never);
  useAgentStore.setState({ agents: [], loading: false, activityLogs: {}, agentActivities: {} } as never);
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } } as never;
    if (url === "/servers/unread-summary") return { data: [] } as never;
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: url.split("/").at(-2),
          options: [{
            runtimeId: "codex",
            capabilityStatus: "available",
            admissionStatus: "available_for_new",
            admissionReason: null,
            current: false,
            availableForNew: true,
            manageableForCurrentAgent: false,
            canSelectInThisContext: true,
          }],
        },
      } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [{ id: "auto", label: "Auto" }] } } as never;
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    return { data: [] } as never;
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } } as never;
    return { data: {} } as never;
  }) as typeof api.post;
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  localStorage.clear();
});

test("member sees the Add agent and Add computer entries", async () => {
  seedMember();

  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/example-workspace/members"]}>
        <Sidebar />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  assert.ok(screen.getByRole("button", { name: "Add agent" }));

  cleanup();
  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/example-workspace/computers"]}>
        <Sidebar />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  assert.ok(await screen.findByRole("button", { name: "Add computer" }));
});

test("member Create Agent only lists Computers attached by the current user", async () => {
  seedMember();
  useMachineStore.setState({
    machines: [
      makeMachine("my-computer", "My Computer", true),
      makeMachine("other-computer", "Other Computer", false),
    ],
  } as never);

  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/example-workspace/members"]}>
        <CreateAgentDialog onClose={() => undefined} />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  const computerSelect = screen.getAllByRole("combobox")[0]!;
  fireEvent.click(computerSelect);
  const listbox = await screen.findByRole("listbox");
  assert.ok(within(listbox).getByRole("option", { name: "My Computer (my-computer.local)" }));
  assert.ok(within(listbox).queryByRole("option", { name: "Other Computer (other-computer.local)" }) === null);
});

test("member gets the Create Agent control only on their own Computer", () => {
  seedMember();
  const ownComputer = makeMachine("my-computer", "My Computer", true);
  const otherComputer = makeMachine("other-computer", "Other Computer", false);

  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/example-workspace/settings/computers/my-computer"]}>
        <MachineDetailPanel machine={ownComputer} hideHeader />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  assert.ok(screen.getByRole("button", { name: "Create" }));

  cleanup();
  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/example-workspace/settings/computers/other-computer"]}>
        <MachineDetailPanel machine={otherComputer} hideHeader />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  assert.ok(screen.queryByRole("button", { name: "Create" }) === null);
});

test("member sees only public read/message controls for another member's Agent", async () => {
  seedMember();
  const agent = makeAgent();
  useAgentStore.setState({ agents: [agent], activityLogs: {}, agentActivities: {} } as never);

  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/example-workspace/agent/agent-other"]}>
        <AgentDetailPanel agent={agent} />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  await waitFor(() => assert.ok(screen.getByTestId("panel-tab-profile")));
  assert.ok(screen.getByTestId("agent-profile-inline-message"));
  assert.ok(screen.queryByTestId("panel-tab-workspace") === null);
  assert.ok(screen.queryByTestId("panel-tab-activity") === null);
  assert.ok(screen.queryByText("Edit runtime config") === null);
  assert.ok(screen.queryByRole("button", { name: "Delete Agent" }) === null);
});
