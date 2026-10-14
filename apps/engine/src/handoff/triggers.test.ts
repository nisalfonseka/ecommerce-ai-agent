import { createSession } from "@ace/agent";
import { describe, expect, it } from "vitest";
import { updateHandoffTriggers } from "./triggers";

describe("handoff triggers", () => {
  it("offers after two consecutive tool failures and a successful turn resets the counter", () => {
    const session = createSession();
    expect(updateHandoffTriggers(session, { toolFailed: true, knowledgeMiss: false })).toBeNull();
    expect(updateHandoffTriggers(session, { toolFailed: false, knowledgeMiss: false })).toBeNull();
    expect(updateHandoffTriggers(session, { toolFailed: true, knowledgeMiss: false })).toBeNull();
    expect(updateHandoffTriggers(session, { toolFailed: true, knowledgeMiss: false })).toBe("tool_failure");
  });

  it("offers after two consecutive knowledge misses and separates the two counters", () => {
    const session = createSession();
    expect(updateHandoffTriggers(session, { toolFailed: false, knowledgeMiss: true })).toBeNull();
    expect(updateHandoffTriggers(session, { toolFailed: true, knowledgeMiss: false })).toBeNull();
    expect(updateHandoffTriggers(session, { toolFailed: false, knowledgeMiss: true })).toBeNull();
    expect(updateHandoffTriggers(session, { toolFailed: false, knowledgeMiss: true })).toBe("not_sure");
  });
});
