export function HandoffRequested() {
  return (
    <div class="card notice" aria-live="polite">
      A team member will reply here.
    </div>
  );
}

export function HandoffOffer(props: {
  reason: "tool_failure" | "not_sure";
  busy: boolean;
  onAction(type: string, input: Record<string, unknown>): Promise<unknown>;
}) {
  return (
    <div class="card notice" aria-live="polite">
      <span>Would you like a team member to help?</span>
      <button
        type="button"
        class="primary"
        disabled={props.busy}
        onClick={() => void props.onAction("request_handoff", { reason: props.reason })}
      >
        Ask a person
      </button>
    </div>
  );
}
