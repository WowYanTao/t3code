import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CheckIcon, ChevronDownIcon, MessagesSquareIcon, PlusIcon, QuoteIcon } from "lucide-react";
import {
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  isSelectionRectVisible,
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import type { SideChatCitationTarget } from "~/lib/sideChatCitations";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { BackgroundThreadContext } from "./backgroundThread";

export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
  resolveSideChatTargets,
  onSendToSideChat,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (citation: AssistantCitation, sourceAnchor?: AssistantCitationSourceAnchor) => boolean;
  resolveSideChatTargets?: (() => ReadonlyArray<SideChatCitationTarget>) | undefined;
  onSendToSideChat?:
    | ((citation: AssistantCitation, targetThreadId: ThreadId | null) => void)
    | undefined;
}) {
  const [selection, setSelection] = useState<{
    citation: AssistantCitation;
    position: SelectionActionPoint;
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const [sideChatMenu, setSideChatMenu] = useState<{
    open: boolean;
    above: boolean;
    targets: ReadonlyArray<SideChatCitationTarget>;
  }>({ open: false, above: false, targets: [] });
  const toolbarRef = useRef<HTMLDivElement>(null);
  const citeButtonRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  const backgroundThread = use(BackgroundThreadContext);
  const gt = useGT();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the toolbar DOM node and clamps its position inside the window before paint
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to document selectionchange and keydown to track text selections in the viewport
  useEffect(() => {
    if (!viewport) return;
    const clear = () => {
      setSelection(null);
      setSideChatMenu((current) =>
        current.open ? { open: false, above: false, targets: [] } : current,
      );
    };
    const update = (pointer: SelectionActionPoint | null) => {
      const nativeSelection = window.getSelection();
      const captured = captureAssistantTextSelection(viewport, nativeSelection);
      const messageId = captured?.source.dataset.assistantCitationSource;
      if (!captured || !messageId) {
        clear();
        return;
      }
      const rect = captured.range.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (!isSelectionRectVisible(rect, [viewportRect])) {
        clear();
        return;
      }
      // A selection can cross blocks with different clipping ancestors.
      const common = captured.range.commonAncestorContainer;
      const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
      let node = common.nodeType === Node.TEXT_NODE ? common : walker.nextNode();
      let visible = false;
      for (; node && !visible; node = walker.nextNode()) {
        if (!captured.range.intersectsNode(node)) continue;
        if (node.parentElement && getComputedStyle(node.parentElement).userSelect === "none")
          continue;
        const fragment = document.createRange();
        fragment.selectNodeContents(node);
        if (node === captured.range.startContainer) {
          fragment.setStart(node, captured.range.startOffset);
        }
        if (node === captured.range.endContainer) {
          fragment.setEnd(node, captured.range.endOffset);
        }
        if (!fragment.toString().trim()) continue;
        const lines = Array.from(fragment.getClientRects());
        if (!lines.some((line) => isSelectionRectVisible(line, [viewportRect]))) continue;
        const clips: Pick<DOMRect, "left" | "right" | "top" | "bottom">[] = [viewportRect];
        for (
          let element = node.parentElement;
          element && element !== viewport;
          element = element.parentElement
        ) {
          const style = getComputedStyle(element);
          const clipX = style.overflowX !== "visible";
          const clipY = style.overflowY !== "visible";
          if (!clipX && !clipY) continue;
          const bounds = element.getBoundingClientRect();
          const left = bounds.left + element.clientLeft;
          const top = bounds.top + element.clientTop;
          clips.push({
            left: clipX ? left : -Infinity,
            right: clipX ? left + element.clientWidth : Infinity,
            top: clipY ? top : -Infinity,
            bottom: clipY ? top + element.clientHeight : Infinity,
          });
        }
        visible = lines.some((line) => isSelectionRectVisible(line, clips));
      }
      if (!visible) {
        clear();
        return;
      }
      const rects = captured.range.getClientRects();
      const pointerOnText =
        pointer !== null &&
        Array.from(rects).some(
          (line) =>
            pointer.x >= line.left - 8 &&
            pointer.x <= line.right + 8 &&
            pointer.y >= line.top - 8 &&
            pointer.y <= line.bottom + 8,
        );
      setSideChatMenu((current) =>
        current.open ? { open: false, above: false, targets: [] } : current,
      );
      setSelection({
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
        position: resolveSelectionActionPosition({
          bounds: viewportRect,
          selectionRect: rects.item(rects.length - 1) ?? rect,
          pointer: pointerOnText ? pointer : null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      restoreAfterScroll: true,
      immediateMultiClick: true,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.contains(event.target as Node)
      ) {
        return;
      }
      const citeButton = citeButtonRef.current;
      if (!citeButton || citeButton.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      citeButton.focus({ preventScroll: true });
    };
    // Tab belongs to the foreground chat; a background timeline only follows its selection.
    if (!backgroundThread) document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [backgroundThread, threadRef, viewport]);

  if (!selection) return null;
  const tooLong = selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const sideChatTargets = onSendToSideChat && !tooLong ? (resolveSideChatTargets?.() ?? []) : [];
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSideChatMenu({ open: false, above: false, targets: [] });
    setSelection(null);
  };
  const cite = () => {
    if (tooLong || !onCite(selection.citation, selection.sourceAnchor)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  const select = () => {
    if (tooLong || !onCite(selection.citation)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  const sendToSideChat = (targetThreadId: ThreadId | null) => {
    if (tooLong || !onSendToSideChat) return;
    onSendToSideChat(selection.citation, targetThreadId);
    window.getSelection()?.removeAllRanges();
    dismiss();
  };
  const toggleSideChatMenu = () => {
    if (tooLong || !onSendToSideChat) return;
    const latestTargets = resolveSideChatTargets?.() ?? [];
    if (latestTargets.length === 0) {
      sendToSideChat(null);
      return;
    }
    if (sideChatMenu.open) {
      setSideChatMenu({ open: false, above: false, targets: [] });
      return;
    }
    const toolbarRect = toolbarRef.current?.getBoundingClientRect();
    const above = toolbarRect !== undefined && toolbarRect.bottom + 240 > window.innerHeight;
    setSideChatMenu({ open: true, above, targets: latestTargets });
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (sideChatMenu.open) {
        setSideChatMenu({ open: false, above: false, targets: [] });
        return;
      }
      dismiss();
    }
  };
  return createPortal(
    <div
      ref={toolbarRef}
      className="fixed z-50 inline-flex max-w-[calc(100vw-1rem)] items-center gap-1"
      style={{ left: selection.position.x, top: selection.position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
    >
      <Button
        ref={citeButtonRef}
        type="button"
        size="xs"
        variant="glass"
        disabled={tooLong}
        aria-label={
          tooLong ? gt("Selection is too long to cite") : gt("Cite selection in composer")
        }
        onClick={cite}
      >
        <QuoteIcon aria-hidden="true" className="size-3.5" />
        {tooLong
          ? gt("Shorten selection")
          : gt("Cite", { $context: "verb, button that quotes the selected text" })}
      </Button>
      {tooLong ? null : (
        <Button type="button" size="xs" variant="glass" aria-label={gt("Select")} onClick={select}>
          <CheckIcon aria-hidden="true" className="size-3.5" />
          {gt("Select")}
        </Button>
      )}
      {tooLong || !onSendToSideChat ? null : (
        <div className="relative">
          <Button
            type="button"
            size="xs"
            variant="glass"
            aria-label={gt("发送到子会话")}
            aria-haspopup={sideChatTargets.length > 0 ? "menu" : undefined}
            aria-expanded={sideChatTargets.length > 0 ? sideChatMenu.open : undefined}
            onClick={toggleSideChatMenu}
          >
            <MessagesSquareIcon aria-hidden="true" className="size-3.5" />
            {gt("子会话")}
            {sideChatTargets.length > 0 ? (
              <ChevronDownIcon
                aria-hidden="true"
                className={cn("size-3 transition-transform", sideChatMenu.open && "rotate-180")}
              />
            ) : null}
          </Button>
          {sideChatMenu.open ? (
            <div
              role="menu"
              aria-label={gt("选择目标子会话")}
              className={cn(
                "absolute right-0 z-50 w-56 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg",
                sideChatMenu.above ? "bottom-full mb-1.5" : "top-full mt-1.5",
              )}
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-popover-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={() => sendToSideChat(null)}
              >
                <PlusIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{gt("新建子会话")}</span>
              </button>
              <div className="my-1 h-px bg-border/60" />
              <div className="px-2 py-1 text-2xs font-medium text-muted-foreground">
                {gt("已有子会话")}
              </div>
              <div className="max-h-48 overflow-y-auto">
                {sideChatMenu.targets.map((target) => (
                  <button
                    key={target.threadId}
                    type="button"
                    role="menuitem"
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-popover-foreground hover:bg-accent hover:text-accent-foreground"
                    onClick={() => sendToSideChat(target.threadId)}
                  >
                    <MessagesSquareIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate">{target.title}</span>
                    {target.isActiveInPanel ? (
                      <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-3xs font-medium text-muted-foreground">
                        {gt("当前")}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>,
    document.body,
  );
}
