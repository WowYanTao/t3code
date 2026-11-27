export const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
export const PREVIEW_PANEL_MIN_WIDTH = 360;
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7;
/** Below this, the sibling chat column's composer overflows. */
const SIBLING_COLUMN_MIN_WIDTH = 360;
export const PREVIEW_PANEL_DEFAULT_WIDTH = 540;
const MIN_PANEL_WIDTH_RATIO = 0.05;
const FALLBACK_VIEWPORT_WIDTH = 1280;

export function getPreviewPanelRatioStorageKey(storageKey: string): string {
  return `${storageKey}:ratio`;
}

function getPreviewPanelMaxWidth(viewportWidth: number, containerWidth?: number): number {
  const fractionCap = Math.floor(viewportWidth * PREVIEW_PANEL_MAX_WIDTH_FRACTION);
  const validContainerWidth =
    containerWidth !== undefined && Number.isFinite(containerWidth) && containerWidth > 0
      ? containerWidth
      : undefined;
  const containerCap =
    validContainerWidth === undefined
      ? Infinity
      : Math.floor(validContainerWidth) - SIBLING_COLUMN_MIN_WIDTH;
  // Keep max >= min; an inverted clamp would overwrite the saved width on drag end.
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.min(fractionCap, containerCap));
}

function getPreviewPanelReferenceWidth(viewportWidth: number, containerWidth?: number): number {
  if (containerWidth !== undefined && Number.isFinite(containerWidth) && containerWidth > 0) {
    return containerWidth;
  }
  return Number.isFinite(viewportWidth) && viewportWidth > 0
    ? viewportWidth
    : FALLBACK_VIEWPORT_WIDTH;
}

export function isValidPreviewPanelWidthRatio(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0 && value <= 1;
}

export function computePreviewPanelWidthRatio(
  width: number,
  referenceWidth: number,
): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(referenceWidth) || referenceWidth <= 0) {
    return null;
  }
  const raw = width / referenceWidth;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const clamped = Math.min(1, Math.max(MIN_PANEL_WIDTH_RATIO, raw));
  return Math.round(clamped * 10_000) / 10_000;
}

export function resolvePreviewPanelInlineWidth(input: {
  readonly ratio: number | null;
  readonly defaultWidth: number;
  readonly viewportWidth: number;
  readonly containerWidth?: number | undefined;
}): {
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly referenceWidth: number;
} {
  const maxWidth = getPreviewPanelMaxWidth(input.viewportWidth, input.containerWidth);
  const referenceWidth = getPreviewPanelReferenceWidth(input.viewportWidth, input.containerWidth);
  const targetWidth = isValidPreviewPanelWidthRatio(input.ratio)
    ? Math.round(referenceWidth * input.ratio)
    : input.defaultWidth;
  const clampedTarget = Number.isFinite(targetWidth) ? targetWidth : PREVIEW_PANEL_DEFAULT_WIDTH;
  const width = Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.min(maxWidth, clampedTarget));
  return {
    width,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    referenceWidth,
  };
}
