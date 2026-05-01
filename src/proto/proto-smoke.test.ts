import { describe, it, expect } from "vitest";
import { AvailableModelsRequestSchema } from "./aiserver_pb.ts";
import { AgentRunRequestSchema } from "./agent_pb.ts";

describe("proto smoke test", () => {
  it("imports aiserver proto types", () => {
    expect(AvailableModelsRequestSchema).toBeDefined();
  });

  it("imports agent proto types", () => {
    expect(AgentRunRequestSchema).toBeDefined();
  });
});
