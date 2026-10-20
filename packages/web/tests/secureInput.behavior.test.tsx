import "./helpers/domSetup";
import { afterEach, test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
import SecureInputButton from "../src/components/message/SecureInputButton";
import api from "../src/api/client";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const target = { id: "agent-one", name: "worker", displayName: null, machineName: "My Mac" };
function mount() { return render(<TestIntlProvider><textarea aria-label="Chat draft" defaultValue="keep this draft" /><SecureInputButton channelId="conversation" /></TestIntlProvider>); }
test("manually opens without an agent request and only posts metadata after disclosure consent", async () => {
  vi.spyOn(api, "get").mockResolvedValue({ data: { agents: [target] } });
  const post = vi.spyOn(api, "post").mockResolvedValue({ data: { status: "cancelled", requestId: "test" } });
  mount(); fireEvent.click(screen.getByRole("button", { name: "Secure input" }));
  await screen.findByText("worker — My Mac");
  const open = screen.getByRole("button", { name: "Open local input window" });
  expect((open as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Name only, not the secret (for example DEPLOY_TOKEN)"), { target: { value: "DEPLOY_TOKEN" } });
  expect((open as HTMLButtonElement).disabled).toBe(true); fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(open);
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const body = post.mock.calls[0]![1] as Record<string, unknown>;
  expect(body).toMatchObject({ name: "DEPLOY_TOKEN", agentId: target.id, allowAgentRead: true });
  expect(body).not.toHaveProperty("value"); expect(document.querySelector('input[type="password"]')).toBeNull();
  expect((screen.getByLabelText("Chat draft") as HTMLTextAreaElement).value).toBe("keep this draft");
});
test("closing a manual input dialog sends nothing and leaves the chat draft intact", async () => {
  vi.spyOn(api, "get").mockResolvedValue({ data: { agents: [] } });
  const post = vi.spyOn(api, "post"); mount();
  fireEvent.click(screen.getByRole("button", { name: "Secure input" }));
  await screen.findByTestId("secure-input-dialog"); fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(post).not.toHaveBeenCalled(); expect((screen.getByLabelText("Chat draft") as HTMLTextAreaElement).value).toBe("keep this draft");
});
