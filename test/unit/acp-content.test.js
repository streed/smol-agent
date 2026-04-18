import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acpToolKind,
  getSessionModeState,
  promptBlocksToUserText,
  resourceLinkToSafePath,
} from "../../src/acp-content.js";

describe("acp-content", () => {
  test("acpToolKind maps known tools", () => {
    expect(acpToolKind("read_file")).toBe("read");
    expect(acpToolKind("grep")).toBe("search");
    expect(acpToolKind("unknown_tool_xyz")).toBe("other");
  });

  test("resourceLinkToSafePath allows files inside jail", async () => {
    const jail = await fs.mkdtemp(path.join(os.tmpdir(), "acp-jail-"));
    const inner = path.join(jail, "x.txt");
    await fs.writeFile(inner, "hello", "utf-8");
    const uri = `file://${inner}`;
    expect(resourceLinkToSafePath(uri, jail)).toBe(path.resolve(inner));
  });

  test("resourceLinkToSafePath rejects paths outside jail", () => {
    expect(resourceLinkToSafePath("file:///etc/passwd", "/tmp/safe")).toBeNull();
  });

  test("promptBlocksToUserText joins text blocks", async () => {
    const t = await promptBlocksToUserText(
      [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      process.cwd(),
    );
    expect(t).toContain("a");
    expect(t).toContain("b");
  });

  test("getSessionModeState defaults to code", () => {
    const s = getSessionModeState({ architectMode: false, cavemanMode: null });
    expect(s.currentModeId).toBe("code");
    expect(s.availableModes.length).toBeGreaterThan(0);
  });

  test("getSessionModeState picks architect and caveman", () => {
    expect(getSessionModeState({ architectMode: true, cavemanMode: null }).currentModeId).toBe(
      "architect",
    );
    expect(getSessionModeState({ architectMode: false, cavemanMode: "lite" }).currentModeId).toBe(
      "caveman",
    );
  });
});
