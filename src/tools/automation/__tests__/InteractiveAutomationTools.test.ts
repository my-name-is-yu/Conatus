import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConcurrencyController } from "../../concurrency.js";
import { ToolExecutor } from "../../executor.js";
import { ToolPermissionManager } from "../../permission.js";
import { ToolRegistry } from "../../registry.js";
import type { ToolCallContext } from "../../types.js";
import { createBuiltinTools } from "../../builtin/index.js";
import {
  BrowserSessionStore,
  InteractiveAutomationRegistry,
  type InteractiveAutomationProvider,
} from "../../../runtime/interactive-automation/index.js";
import {
  BackpressureController,
  CircuitBreakerController,
  GuardrailStore,
} from "../../../runtime/guardrails/index.js";
import {
  BrowserRunWorkflowTool,
  DesktopClickTool,
  DesktopGetAppStateTool,
  DesktopListAppsTool,
  DesktopTypeTextTool,
  ResearchAnswerWithSourcesTool,
  ResearchWebTool,
} from "../index.js";

const originalPulseedHome = process.env["PULSEED_HOME"];

async function withTempPulseedHome<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-automation-tools-"));
  process.env["PULSEED_HOME"] = tmpDir;
  try {
    return await run(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (originalPulseedHome === undefined) {
      delete process.env["PULSEED_HOME"];
    } else {
      process.env["PULSEED_HOME"] = originalPulseedHome;
    }
  }
}

function makeContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "goal-1",
    trustBalance: 50,
    preApproved: false,
    approvalFn: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeRegistry(): InteractiveAutomationRegistry {
  const registry = new InteractiveAutomationRegistry({
    defaultProviders: {
      desktop: "desktop-test",
      research: "research-test",
      browser: "browser-test",
    },
  });
  const desktopProvider: InteractiveAutomationProvider = {
    id: "desktop-test",
    family: "desktop",
    capabilities: ["desktop_state", "desktop_input"],
    isAvailable: async () => ({ available: true }),
    describeEnvironment: async () => ({
      providerId: "desktop-test",
      family: "desktop",
      capabilities: ["desktop_state", "desktop_input"],
      available: true,
    }),
    listApps: async () => [{ name: "Notes" }],
    getAppState: async (input) => ({ app: input.app, title: "Note" }),
    click: async () => ({ success: true, summary: "clicked" }),
    typeText: async () => ({ success: true, summary: "typed" }),
  };
  const researchProvider: InteractiveAutomationProvider = {
    id: "research-test",
    family: "research",
    capabilities: ["web_research"],
    isAvailable: async () => ({ available: true }),
    describeEnvironment: async () => ({
      providerId: "research-test",
      family: "research",
      capabilities: ["web_research"],
      available: true,
    }),
    researchWeb: async (input) => ({
      query: input.query,
      results: [{ title: "Result", url: "https://example.com" }],
      citations: ["https://example.com"],
    }),
    answerWithSources: async () => ({
      answer: "Answer",
      citations: ["https://example.com"],
    }),
  };
  const browserProvider: InteractiveAutomationProvider = {
    id: "browser-test",
    family: "browser",
    capabilities: ["browser_control", "agentic_workflow"],
    isAvailable: async () => ({ available: true }),
    describeEnvironment: async () => ({
      providerId: "browser-test",
      family: "browser",
      capabilities: ["browser_control", "agentic_workflow"],
      available: true,
    }),
    runBrowserWorkflow: async () => ({ success: true, summary: "workflow done", sessionId: "s1" }),
    getBrowserState: async () => ({ success: true, summary: "state read", sessionId: "s1" }),
  };
  registry.register(desktopProvider);
  registry.register(researchProvider);
  registry.register(browserProvider);
  return registry;
}

describe("interactive automation tools", () => {
  it("reads desktop app lists and app state through the configured provider", async () => {
    const registry = makeRegistry();
    const listTool = new DesktopListAppsTool(registry);
    const stateTool = new DesktopGetAppStateTool(registry);

    await expect(listTool.call({}, makeContext())).resolves.toMatchObject({
      success: true,
      data: { providerId: "desktop-test", apps: [{ name: "Notes" }] },
    });
    await expect(stateTool.call({ app: "Notes" }, makeContext())).resolves.toMatchObject({
      success: true,
      data: { providerId: "desktop-test", state: { title: "Note" } },
    });
  });

  it("marks desktop mutation tools as approval-gated and non-concurrency-safe", async () => {
    const registry = makeRegistry();
    const clickTool = new DesktopClickTool(registry);
    const typeTool = new DesktopTypeTextTool(registry);

    expect(clickTool.metadata.isReadOnly).toBe(false);
    expect(clickTool.metadata.permissionLevel).toBe("execute");
    await expect(clickTool.checkPermissions({ app: "Notes", button: "left", clickCount: 1 })).resolves.toMatchObject({
      status: "needs_approval",
    });
    await expect(typeTool.checkPermissions({ app: "Notes", text: "secret" })).resolves.toMatchObject({
      status: "needs_approval",
    });
    expect(clickTool.isConcurrencySafe({ app: "Notes", button: "left", clickCount: 1 })).toBe(false);
  });

  it("denies desktop mutation tools for configured protected apps", async () => {
    const registry = makeRegistry();
    const clickTool = new DesktopClickTool(registry, {
      requireApproval: "always",
      deniedApps: ["System Settings"],
    });

    await expect(clickTool.checkPermissions({ app: "System Settings", button: "left", clickCount: 1 })).resolves.toMatchObject({
      status: "denied",
      reason: expect.stringContaining("protected app"),
    });
  });

  it("requires semantic approval before executing desktop mutation tools", async () => {
    const registry = makeRegistry();
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(new DesktopClickTool(registry));
    const executor = new ToolExecutor({
      registry: toolRegistry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const approvalFn = vi.fn().mockResolvedValue(false);

    const result = await executor.execute(
      "desktop_click",
      { app: "Notes", x: 10, y: 20 },
      makeContext({ approvalFn }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("User denied approval");
    expect(approvalFn).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "desktop_click",
      reason: expect.stringContaining("requires approval"),
    }));
  });

  it("runs research tools as read-only provider calls", async () => {
    const registry = makeRegistry();
    const webTool = new ResearchWebTool(registry);
    const answerTool = new ResearchAnswerWithSourcesTool(registry);

    expect(webTool.metadata.isReadOnly).toBe(true);
    await expect(webTool.call({ query: "PulSeed" }, makeContext())).resolves.toMatchObject({
      success: true,
      data: {
        providerId: "research-test",
        results: [{ title: "Result", url: "https://example.com" }],
      },
    });
    await expect(answerTool.call({ question: "What is PulSeed?" }, makeContext())).resolves.toMatchObject({
      success: true,
      data: {
        providerId: "research-test",
        answer: "Answer",
        citations: ["https://example.com"],
      },
    });
  });

  it("approval-gates browser workflows", async () => {
    const registry = makeRegistry();
    const tool = new BrowserRunWorkflowTool(registry);

    expect(tool.metadata.isReadOnly).toBe(false);
    expect(tool.metadata.permissionLevel).toBe("write_remote");
    await expect(tool.checkPermissions({ task: "Submit the form" })).resolves.toMatchObject({
      status: "needs_approval",
    });
    await expect(tool.call({ task: "Open the dashboard" }, makeContext())).resolves.toMatchObject({
      success: true,
      data: { providerId: "browser-test", result: { sessionId: "s1" } },
    });
  });

  it("records auth handoff requests for browser workflows that need login", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-auth-"));
    try {
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-auth" },
      });
      registry.register({
        id: "browser-auth",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-auth",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow: async () => ({
          success: false,
          summary: "login required",
          error: "login required",
          sessionId: "sess-auth",
          authRequired: true,
          failureCode: "auth_required",
        }),
      });
      const store = new BrowserSessionStore(tmpRuntime);
      const tool = new BrowserRunWorkflowTool(registry, undefined, {
        browserSessionStore: store,
        circuitBreaker: new CircuitBreakerController(new GuardrailStore(tmpRuntime)),
        backpressure: new BackpressureController(new GuardrailStore(tmpRuntime)),
      });
      const approvalFn = vi.fn().mockResolvedValue(true);

      const result = await tool.call(
        { task: "Check dashboard", startUrl: "https://mail.google.com" },
        makeContext({ approvalFn, conversationSessionId: "chat-1" }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Authentication handoff recorded");
      expect(approvalFn).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.stringContaining("Authentication handoff required"),
      }));
      await expect(store.listPendingAuth()).resolves.toEqual([
        expect.objectContaining({
          session_id: "sess-auth",
          provider_id: "browser-auth",
          service_key: "mail.google.com",
          actor_key: "chat-1",
          state: "auth_required",
        }),
      ]);
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("reuses the latest authenticated browser session and ignores auth_required stale sessions", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-session-"));
    try {
      const store = new BrowserSessionStore(tmpRuntime);
      await store.recordAuthenticated({
        sessionId: "sess-good",
        providerId: "browser-reuse",
        serviceKey: "app.example.com",
        workspace: "/tmp",
        actorKey: "chat-2",
      });
      await store.recordAuthRequired({
        sessionId: "sess-stale",
        providerId: "browser-reuse",
        serviceKey: "app.example.com",
        workspace: "/tmp",
        actorKey: "chat-2",
        failureCode: "auth_required",
        failureMessage: "login again",
      });

      const runBrowserWorkflow = vi.fn().mockResolvedValue({
        success: true,
        summary: "workflow done",
        sessionId: "sess-good",
      });
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-reuse" },
      });
      registry.register({
        id: "browser-reuse",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-reuse",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow,
      });

      const tool = new BrowserRunWorkflowTool(registry, undefined, {
        browserSessionStore: store,
      });

      await expect(
        tool.call(
          { task: "Resume app", startUrl: "https://app.example.com/home" },
          makeContext({ conversationSessionId: "chat-2" }),
        ),
      ).resolves.toMatchObject({
        success: true,
        data: { result: { sessionId: "sess-good" } },
      });
      expect(runBrowserWorkflow).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "sess-good",
      }));
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("opens a circuit breaker after repeated rate limit failures", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-breaker-"));
    try {
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-breaker" },
      });
      const runBrowserWorkflow = vi.fn().mockResolvedValue({
        success: false,
        summary: "rate limited",
        error: "rate limited",
        failureCode: "rate_limited",
      });
      registry.register({
        id: "browser-breaker",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-breaker",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow,
      });
      const guardrailStore = new GuardrailStore(tmpRuntime);
      const tool = new BrowserRunWorkflowTool(registry, undefined, {
        circuitBreaker: new CircuitBreakerController(guardrailStore),
      });

      await tool.call({ task: "Try once", startUrl: "https://api.example.com" }, makeContext());
      await tool.call({ task: "Try twice", startUrl: "https://api.example.com" }, makeContext());
      const blocked = await tool.call({ task: "Try thrice", startUrl: "https://api.example.com" }, makeContext());

      expect(blocked.success).toBe(false);
      expect(blocked.error).toContain("circuit breaker open");
      expect(runBrowserWorkflow).toHaveBeenCalledTimes(2);
      await expect(guardrailStore.listBreakers()).resolves.toEqual([
        expect.objectContaining({
          provider_id: "browser-breaker",
          service_key: "api.example.com",
          state: "open",
        }),
      ]);
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("wires browser auth handoff and guardrails through createBuiltinTools with a production-style runtime root", async () => {
    const tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-browser-factory-"));
    try {
      const registry = new InteractiveAutomationRegistry({
        defaultProviders: { browser: "browser-factory" },
      });
      const runBrowserWorkflow = vi.fn()
        .mockResolvedValueOnce({
          success: false,
          summary: "login required",
          error: "login required",
          sessionId: "sess-factory",
          authRequired: true,
          failureCode: "auth_required",
        })
        .mockResolvedValueOnce({
          success: false,
          summary: "rate limited",
          error: "rate limited",
          failureCode: "rate_limited",
        })
        .mockResolvedValueOnce({
          success: false,
          summary: "rate limited",
          error: "rate limited",
          failureCode: "rate_limited",
        })
        .mockResolvedValueOnce({
          success: false,
          summary: "rate limited",
          error: "rate limited",
          failureCode: "rate_limited",
        });
      registry.register({
        id: "browser-factory",
        family: "browser",
        capabilities: ["browser_control", "agentic_workflow"],
        isAvailable: async () => ({ available: true }),
        describeEnvironment: async () => ({
          providerId: "browser-factory",
          family: "browser",
          capabilities: ["browser_control", "agentic_workflow"],
          available: true,
        }),
        runBrowserWorkflow,
      });

      const tool = createBuiltinTools({
        stateManager: { getBaseDir: () => tmpBaseDir } as never,
        interactiveAutomationRegistry: registry,
      }).find((candidate) => candidate.metadata.name === "browser_run_workflow") as BrowserRunWorkflowTool | undefined;

      expect(tool).toBeDefined();

      const approvalFn = vi.fn().mockResolvedValue(true);
      const first = await tool!.call(
        { task: "Open mail", startUrl: "https://mail.google.com" },
        makeContext({ approvalFn, conversationSessionId: "chat-factory" }),
      );
      expect(first.success).toBe(false);
      expect(first.error).toContain("Authentication handoff recorded");

      const runtimeRoot = path.join(tmpBaseDir, "runtime");
      const sessionStore = new BrowserSessionStore(runtimeRoot);
      await expect(sessionStore.listPendingAuth()).resolves.toEqual([
        expect.objectContaining({
          session_id: "sess-factory",
          provider_id: "browser-factory",
          service_key: "mail.google.com",
          actor_key: "chat-factory",
          state: "auth_required",
        }),
      ]);

      await tool!.call({ task: "Retry one", startUrl: "https://api.example.com" }, makeContext());
      await tool!.call({ task: "Retry two", startUrl: "https://api.example.com" }, makeContext());
      const blocked = await tool!.call({ task: "Retry three", startUrl: "https://api.example.com" }, makeContext());

      expect(blocked.success).toBe(false);
      expect(blocked.error).toContain("circuit breaker open");
      expect(runBrowserWorkflow).toHaveBeenCalledTimes(3);
      await expect(new GuardrailStore(runtimeRoot).listBreakers()).resolves.toEqual([
        expect.objectContaining({
          provider_id: "browser-factory",
          service_key: "api.example.com",
          state: "open",
        }),
      ]);
    } finally {
      await fs.rm(tmpBaseDir, { recursive: true, force: true });
    }
  });

  it("registers automation tools for enabled production defaults and injected registries", async () => {
    const defaultTools = await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({ interactive_automation: { enabled: true } }),
        "utf8",
      );
      return createBuiltinTools().map((tool) => tool.metadata.name);
    });
    const withAutomation = createBuiltinTools({ interactiveAutomationRegistry: makeRegistry() })
      .map((tool) => tool.metadata.name);

    expect(defaultTools).toContain("desktop_click");
    expect(withAutomation).toEqual(expect.arrayContaining([
      "desktop_list_apps",
      "desktop_get_app_state",
      "desktop_click",
      "desktop_type_text",
      "research_web",
      "research_answer_with_sources",
      "browser_run_workflow",
      "browser_get_state",
    ]));
  });

  it("does not register automation tools when config disables automation and no registry is injected", () => {
    const tools = createBuiltinTools().map((tool) => tool.metadata.name);

    expect(tools).not.toContain("desktop_click");
  });

  it("applies global config denied_apps when registering default automation tools", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          interactive_automation: {
            enabled: true,
            denied_apps: ["Protected App"],
          },
        }),
        "utf8",
      );

      const tool = createBuiltinTools()
        .find((candidate) => candidate.metadata.name === "desktop_click") as DesktopClickTool | undefined;

      expect(tool).toBeDefined();
      await expect(tool!.checkPermissions({ app: "Protected App", button: "left", clickCount: 1 })).resolves.toMatchObject({
        status: "denied",
      });
    });
  });

  it("uses configured default providers when creating the production registry", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          interactive_automation: {
            enabled: true,
            default_research_provider: "noop",
          },
        }),
        "utf8",
      );

      const tool = createBuiltinTools()
        .find((candidate) => candidate.metadata.name === "research_web") as ResearchWebTool | undefined;

      expect(tool).toBeDefined();
      await expect(tool!.call({ query: "PulSeed" }, makeContext())).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("noop is unavailable"),
      });
    });
  });
});
