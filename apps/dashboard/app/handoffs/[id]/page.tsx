import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { STAFF_COOKIE } from "../../../lib/session";
import { getHandoff, type HandoffDetail, StaffApiError } from "../../../lib/staff-api";
import { HandoffDetailView } from "./handoff-detail";

export const dynamic = "force-dynamic";

export default async function HandoffPage({ params }: { params: Promise<{ id: string }> }) {
  const token = (await cookies()).get(STAFF_COOKIE)?.value;
  if (!token) redirect("/login");
  const { id } = await params;
  let handoff: HandoffDetail;
  try {
    handoff = await getHandoff(token, id);
  } catch (error) {
    if (error instanceof StaffApiError && error.status === 404) notFound();
    throw error;
  }
  return (
    <main>
      <a className="back" href="/inbox">
        ← Inbox
      </a>
      <HandoffDetailView handoff={handoff} />
    </main>
  );
}
