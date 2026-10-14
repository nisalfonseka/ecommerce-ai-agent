import type { SessionState } from "@ace/agent";

export function updateHandoffTriggers(
  session: SessionState,
  signal: { toolFailed: boolean; knowledgeMiss: boolean },
): "tool_failure" | "not_sure" | null {
  if (!signal.toolFailed && !signal.knowledgeMiss) {
    session.consecutiveToolFailures = 0;
    session.consecutiveKnowledgeMisses = 0;
    return null;
  }
  session.consecutiveToolFailures = signal.toolFailed ? (session.consecutiveToolFailures ?? 0) + 1 : 0;
  session.consecutiveKnowledgeMisses = signal.knowledgeMiss
    ? (session.consecutiveKnowledgeMisses ?? 0) + 1
    : 0;
  if (session.consecutiveToolFailures >= 2) {
    session.consecutiveToolFailures = 0;
    return "tool_failure";
  }
  if (session.consecutiveKnowledgeMisses >= 2) {
    session.consecutiveKnowledgeMisses = 0;
    return "not_sure";
  }
  return null;
}
