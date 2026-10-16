import type { HandoffDetail } from "../../../lib/staff-api";
import { HandoffActions } from "./handoff-actions";

function keyedMessages(messages: HandoffDetail["messages"]) {
  const seen = new Map<string, number>();
  return messages.map((message) => {
    const base = `${message.role}:${message.text}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return { key: `${base}:${occurrence}`, message };
  });
}

export function HandoffDetailView({ handoff }: { handoff: HandoffDetail }) {
  return (
    <>
      <section className="handoff-summary">
        <p className="eyebrow">{handoff.reason.replaceAll("_", " ")}</p>
        <h1>{handoff.summary}</h1>
        <p>
          Status: <strong>{handoff.status}</strong>
          {handoff.claimedBy ? ` · ${handoff.claimedBy}` : ""}
        </p>
      </section>
      <section>
        <h2>Conversation</h2>
        <ol className="transcript">
          {keyedMessages(handoff.messages).map(({ key, message }) => (
            <li key={key} className={message.role}>
              <strong>{message.role === "staff" ? "Team" : message.role}</strong>
              <p>{message.text}</p>
            </li>
          ))}
        </ol>
      </section>
      <HandoffActions id={handoff.id} status={handoff.status} />
    </>
  );
}
