import type { HandoffSummary } from "../../lib/staff-api";

function age(createdAt: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function InboxList({ items, now = new Date() }: { items: HandoffSummary[]; now?: Date }) {
  const ordered = items.toSorted(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  if (ordered.length === 0) return <p className="empty">No open conversations.</p>;
  return (
    <ol className="inbox-list">
      {ordered.map((item) => (
        <li key={item.id}>
          <a href={`/handoffs/${encodeURIComponent(item.id)}`}>
            <span className="inbox-heading">
              <strong>{item.reason.replaceAll("_", " ")}</strong>
              <time dateTime={item.createdAt}>{age(item.createdAt, now)}</time>
            </span>
            <span>{item.summary}</span>
          </a>
        </li>
      ))}
    </ol>
  );
}
