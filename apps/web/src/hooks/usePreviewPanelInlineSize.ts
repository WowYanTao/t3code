import * as Schema from "effect/Schema";
import { useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "../lib/observeResize";
import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";
import {
  computePreviewPanelWidthRatio,
  getPreviewPanelRatioStorageKey,
  isValidPreviewPanelWidthRatio,
  PREVIEW_PANEL_DEFAULT_WIDTH,
  PREVIEW_PANEL_WIDTH_STORAGE_KEY,
  resolvePreviewPanelInlineWidth,
} from "./usePreviewPanelInlineSize.logic";
import { RESIZABLE_WIDTH_PROPERTY, type ResizableWidthHandlers } from "./useResizableWidth";
import { useResizeDrag } from "./useResizeDrag";
import { useStableCallback } from "./useStableCallback";

export interface PreviewPanelInlineSize {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
  /** Ref-callback body for the panel host: measures the row the panel shares. */
  readonly observeRow: (host: HTMLElement) => () => void;
}

const RatioSchema = Schema.Finite;

function readViewportWidth(): number {
  return typeof window === "undefined" ? 1280 : window.innerWidth;
}

function readContainerWidth(element: HTMLElement | null | undefined): number | undefined {
  if (!element) return undefined;
  const width = element.clientWidth;
  return Number.isFinite(width) && width > 0 ? width : undefined;
}

function readStoredRatio(ratioStorageKey: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = getLocalStorageItem(ratioStorageKey, RatioSchema);
    return isValidPreviewPanelWidthRatio(stored) ? stored : null;
  } catch (error) {
    console.error("Could not read persisted panel width ratio.", error);
    return null;
  }
}

export function usePreviewPanelInlineSize(
  options: {
    readonly enabled?: boolean | undefined;
    readonly widthStorageKey?: string | undefined;
    readonly defaultWidth?: number | undefined;
    readonly container?: HTMLElement | null | undefined;
  } = {},
): PreviewPanelInlineSize {
  const enabled = options.enabled ?? true;
  const container = options.container;
  const storageKey = options.widthStorageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY;
  const ratioStorageKey = getPreviewPanelRatioStorageKey(storageKey);
  const defaultWidth = options.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH;

  const rowRef = useRef<HTMLElement | null>(container ?? null);
  const [measurements, setMeasurements] = useState(() => ({
    viewportWidth: readViewportWidth(),
    containerWidth: readContainerWidth(container),
  }));
  const [ratioState, setRatioState] = useState(() => ({
    storageKey: ratioStorageKey,
    ratio: readStoredRatio(ratioStorageKey),
  }));
  if (ratioState.storageKey !== ratioStorageKey) {
    setRatioState({ storageKey: ratioStorageKey, ratio: readStoredRatio(ratioStorageKey) });
  }

  const resolved = resolvePreviewPanelInlineWidth({
    ratio: ratioState.ratio,
    defaultWidth,
    viewportWidth: measurements.viewportWidth,
    containerWidth: measurements.containerWidth,
  });

  const restoreWidth = useStableCallback((host: HTMLElement | null) => {
    host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${resolved.width}px`);
  });

  const commitWidth = (nextRatioStorageKey: string, finalWidth: number) => {
    const liveContainerWidth = readContainerWidth(rowRef.current) ?? measurements.containerWidth;
    const liveReferenceWidth = liveContainerWidth ?? readViewportWidth();
    const nextRatio = computePreviewPanelWidthRatio(finalWidth, liveReferenceWidth);
    if (nextRatio === null) return;
    setRatioState({ storageKey: nextRatioStorageKey, ratio: nextRatio });
    try {
      setLocalStorageItem(nextRatioStorageKey, nextRatio, RatioSchema);
    } catch (error) {
      console.error("Could not persist panel width ratio.", error);
    }
  };

  const drag = useResizeDrag<HTMLElement>((event) => {
    const host = event.currentTarget.parentElement;
    // Disable drag transitions through transition-property; the host renders transition-duration.
    host?.style.setProperty("transition-property", "none");
    const startRatioStorageKey = ratioStorageKey;
    const startWidth = resolved.width;
    return {
      width: startWidth,
      edge: "left",
      bounds: { min: resolved.minWidth, max: resolved.maxWidth },
      resize(nextWidth) {
        host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${nextWidth}px`);
        return nextWidth;
      },
      finish(finalWidth, moved) {
        if (moved) commitWidth(startRatioStorageKey, finalWidth);
        else restoreWidth(host);
      },
      cleanup(committed) {
        host?.style.removeProperty("transition-property");
        if (!committed) host?.style.setProperty(RESIZABLE_WIDTH_PROPERTY, `${startWidth}px`);
      },
    };
  });

  const { refresh } = drag;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reapplies the live drag pointer position to the DOM before paint when the bounds change
  useLayoutEffect(
    () => refresh({ min: resolved.minWidth, max: resolved.maxWidth }),
    [refresh, resolved.minWidth, resolved.maxWidth],
  );

  const observeRow = (host: HTMLElement) => {
    const row = container ?? (enabled ? host.parentElement : null) ?? null;
    rowRef.current = row;
    // Ref callbacks run before paint, so the width resolves without a flash on mount.
    const measure = () => {
      const nextViewportWidth = readViewportWidth();
      const nextContainerWidth = readContainerWidth(row);
      setMeasurements((prev) =>
        prev.viewportWidth === nextViewportWidth && prev.containerWidth === nextContainerWidth
          ? prev
          : { viewportWidth: nextViewportWidth, containerWidth: nextContainerWidth },
      );
    };
    measure();
    let frame = 0;
    const onResize = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("resize", onResize);
    const stopObserving = row ? observeResize(row, measure) : undefined;
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      stopObserving?.();
    };
  };

  return {
    width: resolved.width,
    handlers: {
      ref: drag.ref,
      onPointerDown: drag.onPointerDown,
      onPointerMove: drag.onPointerMove,
      onPointerUp: drag.onPointerUp,
      onPointerCancel: drag.onPointerCancel,
      onLostPointerCapture: drag.onLostPointerCapture,
    },
    observeRow,
  };
}
