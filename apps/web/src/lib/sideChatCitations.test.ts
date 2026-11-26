import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  appendAssistantCitationToPrompt,
  registerThreadComposerFocus,
  requestThreadComposerFocus,
  resolveSideChatCitationTargets,
  type SideChatShellCandidate,
} from "./sideChatCitations";

const envId = EnvironmentId.make("env-1");
const parentThreadId = ThreadId.make("thread-parent");
const parentRef = scopeThreadRef(envId, parentThreadId);

function makeSideChat(
  id: string,
  overrides: Partial<SideChatShellCandidate> = {},
): SideChatShellCandidate {
  return {
    environmentId: envId,
    id: ThreadId.make(id),
    title: `Side ${id}`,
    updatedAt: "2026-11-27T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    lineage: {
      sideChat: true,
      parentThreadId,
    },
    ...overrides,
  };
}

describe("appendAssistantCitationToPrompt", () => {
  const citation = {
    version: 1 as const,
    environmentId: envId,
    threadId: parentThreadId,
    messageId: MessageId.make("msg-1"),
    text: "important point",
    start: 0,
    end: 15,
    prefix: "",
    suffix: "",
  };

  it("inserts with a trailing space into an empty prompt and separates existing text", () => {
    const first = appendAssistantCitationToPrompt("", citation);
    expect(first.endsWith(" ")).toBe(true);
    expect(first).toContain("t3-citation://v1/env-1/thread-parent/msg-1");
    expect(first).toContain("text=important+point");

    const appendedAfterText = appendAssistantCitationToPrompt("请展开说明", citation);
    expect(appendedAfterText.startsWith("请展开说明 ")).toBe(true);
    expect(appendedAfterText.endsWith(" ")).toBe(true);

    const appendedAfterSpace = appendAssistantCitationToPrompt("请展开说明 ", citation);
    expect(appendedAfterSpace).toBe(`请展开说明 ${first}`);
  });
});

describe("resolveSideChatCitationTargets", () => {
  it("filters to live side chats of parentRef and prioritizes active tab, open tabs, then recency", () => {
    const activeId = ThreadId.make("active");
    const openSecondId = ThreadId.make("open-second");
    const closedNewerId = ThreadId.make("closed-newer");
    const closedOlderId = ThreadId.make("closed-older");

    const targets = resolveSideChatCitationTargets({
      parentRef,
      panelOpen: true,
      activeSurfaceId: `thread:${activeId}`,
      panelSurfaces: [
        { id: "diff", kind: "diff" },
        { id: `thread:${openSecondId}`, kind: "thread", threadId: openSecondId },
        { id: `thread:${activeId}`, kind: "thread", threadId: activeId },
      ],
      threads: [
        makeSideChat("closed-older", { updatedAt: "2026-11-27T00:01:00.000Z" }),
        makeSideChat("open-second", { updatedAt: "2026-11-27T00:02:00.000Z" }),
        makeSideChat("active", { updatedAt: "2026-11-27T00:00:30.000Z" }),
        makeSideChat("closed-newer", { updatedAt: "2026-11-27T00:05:00.000Z" }),
        makeSideChat("archived", { archivedAt: "2026-11-27T00:06:00.000Z" }),
        makeSideChat("deleted", { deletedAt: "2026-11-27T00:06:00.000Z" }),
        makeSideChat("other-parent", {
          lineage: { sideChat: true, parentThreadId: ThreadId.make("other") },
        }),
        makeSideChat("fork-not-side", {
          lineage: { sideChat: false, parentThreadId },
        }),
      ],
    });

    expect(targets).toEqual([
      { threadId: activeId, title: "Side active", isOpenInPanel: true, isActiveInPanel: true },
      {
        threadId: openSecondId,
        title: "Side open-second",
        isOpenInPanel: true,
        isActiveInPanel: false,
      },
      {
        threadId: closedNewerId,
        title: "Side closed-newer",
        isOpenInPanel: false,
        isActiveInPanel: false,
      },
      {
        threadId: closedOlderId,
        title: "Side closed-older",
        isOpenInPanel: false,
        isActiveInPanel: false,
      },
    ]);
  });
});

describe("thread composer focus bus", () => {
  it("invokes mounted handler immediately and delivers pending focus on mount", () => {
    const mountedRef = scopeThreadRef(envId, ThreadId.make("side-mounted"));
    const mountedFocus = vi.fn();
    const disposeMounted = registerThreadComposerFocus(mountedRef, mountedFocus);
    requestThreadComposerFocus(mountedRef);
    expect(mountedFocus).toHaveBeenCalledTimes(1);
    disposeMounted();

    const pendingRef = scopeThreadRef(envId, ThreadId.make("side-pending"));
    const pendingFocus = vi.fn();
    requestThreadComposerFocus(pendingRef);
    expect(pendingFocus).not.toHaveBeenCalled();
    const disposePending = registerThreadComposerFocus(pendingRef, pendingFocus);
    expect(pendingFocus).toHaveBeenCalledTimes(1);
    disposePending();
  });
});
