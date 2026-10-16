import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { STAFF_COOKIE } from "../../lib/session";
import { listHandoffs } from "../../lib/staff-api";
import { InboxList } from "./inbox-list";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const token = (await cookies()).get(STAFF_COOKIE)?.value;
  if (!token) redirect("/login");
  const items = await listHandoffs(token);
  return (
    <main>
      <header className="page-header">
        <div>
          <p className="eyebrow">Store team</p>
          <h1>Open conversations</h1>
        </div>
        <span>Support inbox</span>
      </header>
      <InboxList items={items} />
    </main>
  );
}
