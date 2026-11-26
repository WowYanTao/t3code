import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { formatAssistantCitationForComposer } from "../composer-logic";
import type { RightPanelSurface } from "../rightPanelStore";

export interface SideChatCitationTarget {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly isOpenInPanel: boolean;
  readonly isActiveInPanel: boolean;
}

export interface SideChatShellCandidate {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly id: ThreadId;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly lineage: {
    readonly sideChat?: boolean | undefined;
    readonly parentThreadId: ThreadId | null;
  };
}

/** Appends a formatted assistant citation token to an existing composer prompt with spacing. */
export function appendAssistantCitationToPrompt(
  currentPrompt: string,
  citation: AssistantCitation,
): string {
  const formatted = formatAssistantCitationForComposer(citation, citation.comment);
  if (currentPrompt.length === 0) return formatted;
  if (/\s$/.test(currentPrompt)) return `${currentPrompt}${formatted}`;
  return `${currentPrompt} ${formatted}`;
}

/**
 * Lists live side chats belonging to `parentRef`, prioritizing the currently active right-panel
 * side chat, then other open panel tabs, then closed side chats ordered by most recently updated.
 */
export function resolveSideChatCitationTargets(input: {
  readonly parentRef: ScopedThreadRef;
  readonly threads: ReadonlyArray<SideChatShellCandidate>;
  readonly panelOpen: boolean;
  readonly activeSurfaceId: string | null;
  readonly panelSurfaces: ReadonlyArray<RightPanelSurface>;
}): ReadonlyArray<SideChatCitationTarget> {
  const { parentRef, threads, panelOpen, activeSurfaceId, panelSurfaces } = input;
  const openTabOrder = new Map<ThreadId, number>();
  for (const [index, surface] of panelSurfaces.entries()) {
    if (surface.kind === "thread" && !openTabOrder.has(surface.threadId)) {
      openTabOrder.set(surface.threadId, index);
    }
  }

  const sideChats = threads.filter(
    (thread) =>
      thread.environmentId === parentRef.environmentId &&
      thread.deletedAt === null &&
      thread.archivedAt === null &&
      thread.lineage.sideChat === true &&
      thread.lineage.parentThreadId === parentRef.threadId,
  );

  return sideChats
    .map((thread) => {
      const surfaceId = `thread:${thread.id}`;
      const isOpenInPanel = openTabOrder.has(thread.id);
      const isActiveInPanel = panelOpen && activeSurfaceId === surfaceId;
      return {
        threadId: thread.id,
        title: thread.title,
        isOpenInPanel,
        isActiveInPanel,
        openOrder: openTabOrder.get(thread.id) ?? Number.MAX_SAFE_INTEGER,
        updatedAt: thread.updatedAt,
      };
    })
    .toSorted((left, right) => {
      if (left.isActiveInPanel !== right.isActiveInPanel) {
        return left.isActiveInPanel ? -1 : 1;
      }
      if (left.isOpenInPanel !== right.isOpenInPanel) {
        return left.isOpenInPanel ? -1 : 1;
      }
      if (left.isOpenInPanel && left.openOrder !== right.openOrder) {
        return left.openOrder - right.openOrder;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .map(({ threadId, title, isOpenInPanel, isActiveInPanel }) => ({
      threadId,
      title,
      isOpenInPanel,
      isActiveInPanel,
    }));
}

const FOCUS_REQUEST_TTL_MS = 5_000;
const focusHandlersByThreadKey = new Map<string, () => void>();
const pendingFocusDeadlineByThreadKey = new Map<string, number>();

export function registerThreadComposerFocus(
  threadRef: ScopedThreadRef,
  onFocus: () => void,
): () => void {
  const key = scopedThreadKey(threadRef);
  focusHandlersByThreadKey.set(key, onFocus);
  const deadline = pendingFocusDeadlineByThreadKey.get(key);
  if (deadline !== undefined) {
    pendingFocusDeadlineByThreadKey.delete(key);
    if (Date.now() <= deadline) {
      onFocus();
    }
  }
  return () => {
    if (focusHandlersByThreadKey.get(key) === onFocus) {
      focusHandlersByThreadKey.delete(key);
    }
  };
}

export function requestThreadComposerFocus(threadRef: ScopedThreadRef): void {
  const key = scopedThreadKey(threadRef);
  const handler = focusHandlersByThreadKey.get(key);
  if (handler) {
    pendingFocusDeadlineByThreadKey.delete(key);
    handler();
    return;
  }
  pendingFocusDeadlineByThreadKey.set(key, Date.now() + FOCUS_REQUEST_TTL_MS);
}
