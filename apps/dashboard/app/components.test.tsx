import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandoffActions } from "./handoffs/[id]/handoff-actions";
import { HandoffDetailView } from "./handoffs/[id]/handoff-detail";
import { InboxList } from "./inbox/inbox-list";

afterEach(() => vi.unstubAllGlobals());

describe("staff inbox UI", () => {
  it("lists open handoffs newest first with reason, summary and age", () => {
    render(
      <InboxList
        now={new Date("2026-10-14T12:00:00.000Z")}
        items={[
          {
            id: "old",
            conversationId: "c1",
            reason: "complaint",
            summary: "Older issue",
            status: "open",
            claimedBy: null,
            createdAt: "2026-10-14T10:00:00.000Z",
          },
          {
            id: "new",
            conversationId: "c2",
            reason: "refund",
            summary: "Latest issue",
            status: "open",
            claimedBy: null,
            createdAt: "2026-10-14T11:55:00.000Z",
          },
        ]}
      />,
    );
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/handoffs/new",
      "/handoffs/old",
    ]);
    expect(screen.getByText("Latest issue")).toBeTruthy();
    expect(screen.getByText("5 min ago")).toBeTruthy();
  });

  it("renders transcript content as text, including Sinhala and Tamil", () => {
    const { container } = render(
      <HandoffDetailView
        handoff={{
          id: "h1",
          conversationId: "c1",
          reason: "complaint",
          summary: "Needs help",
          status: "claimed",
          claimedBy: "Nimali",
          createdAt: "2026-10-14T10:00:00.000Z",
          messages: [{ role: "user", text: "<script>alert(1)</script> මට උදව් කරන්න உதவி" }],
        }}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>alert(1)</script> මට උදව් කරන්න உதவி")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claim" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send reply" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hand back to assistant" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy();
  });

  it("disables actions while a mutation is pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(<HandoffActions id="h1" status="open" />);
    const claim = screen.getByRole("button", { name: "Claim" });
    fireEvent.click(claim);
    fireEvent.click(claim);
    expect(screen.getByRole("button", { name: "Claim" }).hasAttribute("disabled")).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
