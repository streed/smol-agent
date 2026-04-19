/**
 * @jest-environment node
 */
import { describe, expect, it, jest } from "@jest/globals";
import { SmolACPAgent } from "../../src/acp-server.js";

describe("SmolACPAgent.unstable_setSessionModel", () => {
  it("calls agent.setModel and saveSession when idle", async () => {
    const conn = { sessionUpdate: jest.fn() };
    const acpAgent = new SmolACPAgent(conn);
    const setModel = jest.fn();
    const saveSession = jest.fn(async () => ({}));
    acpAgent.sessions.set("sess1", {
      agent: { setModel, saveSession, running: false },
      callCounter: 0,
      lastActivity: Date.now(),
    });
    await acpAgent.unstable_setSessionModel({ sessionId: "sess1", modelId: "new-model" });
    expect(setModel).toHaveBeenCalledWith("new-model");
    expect(saveSession).toHaveBeenCalled();
  });

  it("rejects when session is unknown", async () => {
    const acpAgent = new SmolACPAgent({ sessionUpdate: jest.fn() });
    await expect(
      acpAgent.unstable_setSessionModel({ sessionId: "missing", modelId: "m" }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("rejects when a prompt turn is running", async () => {
    const acpAgent = new SmolACPAgent({ sessionUpdate: jest.fn() });
    acpAgent.sessions.set("s", {
      agent: { setModel: jest.fn(), saveSession: jest.fn(), running: true },
      callCounter: 0,
      lastActivity: Date.now(),
    });
    await expect(
      acpAgent.unstable_setSessionModel({ sessionId: "s", modelId: "m" }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("rejects invalid params", async () => {
    const acpAgent = new SmolACPAgent({ sessionUpdate: jest.fn() });
    await expect(acpAgent.unstable_setSessionModel({ sessionId: "", modelId: "x" })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(acpAgent.unstable_setSessionModel({ sessionId: "a", modelId: "" })).rejects.toMatchObject({
      code: -32602,
    });
  });
});
