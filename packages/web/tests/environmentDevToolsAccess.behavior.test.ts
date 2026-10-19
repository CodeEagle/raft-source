import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canRenderEnvironmentDevTools } from "../src/utils/environmentDevToolsAccess";
import {
  createLocalReactDevToolsVisibilityHandlers,
  showLocalReactDevTools,
} from "../src/devtools/localReactDevTools";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const debugPanelSource = appSource.slice(
  appSource.indexOf("function SlockdevDebugPanel("),
  appSource.indexOf("/** Resolves server from URL slug"),
);

test("environment dev tools are gated by the active server role", () => {
  assert.match(appSource, /useServerPermissions/);
  assert.match(appSource, /canRenderEnvironmentDevTools\(role\)/);
  assert.match(appSource, /SHOW_LOCAL_DEV_TOOLS_EVENT/);
  assert.match(appSource, /HIDE_LOCAL_DEV_TOOLS_EVENT/);
  assert.match(appSource, /reason:\s*"permission"/);
  assert.match(appSource, /if \(!canRenderEnvironmentDevTools\(role\)\) return null;/);
  assert.match(debugPanelSource, /if \(!canRenderEnvironmentDevTools\(role\)\) return null;/);
});

test("only owner and admin roles may render environment dev tools", () => {
  assert.equal(canRenderEnvironmentDevTools("owner"), true);
  assert.equal(canRenderEnvironmentDevTools("admin"), true);
  assert.equal(canRenderEnvironmentDevTools("member"), false);
  assert.equal(canRenderEnvironmentDevTools("guest"), false);
  assert.equal(canRenderEnvironmentDevTools(null), false);
  assert.equal(canRenderEnvironmentDevTools(undefined), false);
});

test("permission changes hide and show tools, while a manual hide wins until reload", () => {
  const transitions: string[] = [];
  const handlers = createLocalReactDevToolsVisibilityHandlers({
    hide: () => transitions.push("hide"),
    show: () => transitions.push("show"),
  });

  handlers.onHide(new CustomEvent("raft:hide-local-dev-tools", { detail: { reason: "permission" } }));
  handlers.onShow(new Event("raft:show-local-dev-tools"));
  assert.deepEqual(transitions, ["hide", "show"]);

  handlers.onHide(new Event("raft:hide-local-dev-tools"));
  handlers.onShow(new Event("raft:show-local-dev-tools"));
  assert.deepEqual(transitions, ["hide", "show", "hide"]);
});

test("showing admin dev tools preserves the configured React Scan enable flag", () => {
  const scanOptions: Array<{ enabled?: boolean; showToolbar?: boolean }> = [];
  const grabTransitions: Array<boolean | Record<string, unknown>> = [];
  const reactScan = { setOptions: (value: { enabled?: boolean; showToolbar?: boolean }) => scanOptions.push(value) };
  const reactGrab = {
    getGlobalApi: () => ({
      setEnabled: (value: boolean) => grabTransitions.push(value),
      setToolbarState: (value: Record<string, unknown>) => grabTransitions.push(value),
    }),
  };

  showLocalReactDevTools(reactScan, reactGrab, false);

  assert.deepEqual(scanOptions, [{ enabled: false, showToolbar: true }]);
  assert.deepEqual(grabTransitions, [true, { enabled: true }]);
});
