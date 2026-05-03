import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentLoopEvent } from "./agent-loop-events.js";
import { redactSetupSecretsDeep } from "../../../interface/chat/setup-secret-intake.js";

export interface AgentLoopTraceStore {
  append(event: AgentLoopEvent): Promise<void>;
  list(traceId?: string): Promise<AgentLoopEvent[]>;
}

export class InMemoryAgentLoopTraceStore implements AgentLoopTraceStore {
  private readonly events: AgentLoopEvent[] = [];

  async append(event: AgentLoopEvent): Promise<void> {
    this.events.push(redactSetupSecretsDeep(event));
  }

  async list(traceId?: string): Promise<AgentLoopEvent[]> {
    return traceId
      ? this.events.filter((event) => event.traceId === traceId)
      : [...this.events];
  }
}

export class JsonlAgentLoopTraceStore implements AgentLoopTraceStore {
  private readonly events: AgentLoopEvent[] = [];

  constructor(private readonly filePath: string) {}

  async append(event: AgentLoopEvent): Promise<void> {
    const safeEvent = redactSetupSecretsDeep(event);
    this.events.push(safeEvent);
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(safeEvent)}\n`, "utf-8");
  }

  async list(traceId?: string): Promise<AgentLoopEvent[]> {
    return traceId
      ? this.events.filter((event) => event.traceId === traceId)
      : [...this.events];
  }
}
