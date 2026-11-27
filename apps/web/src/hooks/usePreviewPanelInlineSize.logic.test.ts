import { describe, expect, it } from "vite-plus/test";

import {
  computePreviewPanelWidthRatio,
  getPreviewPanelRatioStorageKey,
  PREVIEW_PANEL_DEFAULT_WIDTH,
  PREVIEW_PANEL_MIN_WIDTH,
  resolvePreviewPanelInlineWidth,
} from "./usePreviewPanelInlineSize.logic";

describe("usePreviewPanelInlineSize.logic", () => {
  it("builds an isolated ratio storage key", () => {
    expect(getPreviewPanelRatioStorageKey("t3code:preview-panel-width")).toBe(
      "t3code:preview-panel-width:ratio",
    );
  });

  it("falls back to defaultWidth when no ratio is stored", () => {
    const result = resolvePreviewPanelInlineWidth({
      ratio: null,
      defaultWidth: PREVIEW_PANEL_DEFAULT_WIDTH,
      viewportWidth: 1600,
      containerWidth: 1320,
    });
    expect(result.width).toBe(540);
    expect(result.minWidth).toBe(PREVIEW_PANEL_MIN_WIDTH);
    expect(result.maxWidth).toBe(960);
    expect(result.referenceWidth).toBe(1320);
  });

  it("scales proportionally with container width across window sizes", () => {
    const ratio = computePreviewPanelWidthRatio(660, 1320);
    expect(ratio).toBe(0.5);

    const large = resolvePreviewPanelInlineWidth({
      ratio,
      defaultWidth: PREVIEW_PANEL_DEFAULT_WIDTH,
      viewportWidth: 2560,
      containerWidth: 2000,
    });
    expect(large.width).toBe(1000);

    const compact = resolvePreviewPanelInlineWidth({
      ratio,
      defaultWidth: PREVIEW_PANEL_DEFAULT_WIDTH,
      viewportWidth: 1200,
      containerWidth: 1000,
    });
    expect(compact.width).toBe(500);
  });

  it("clamps computed width to minWidth and maxWidth without altering stored ratio semantics", () => {
    const narrow = resolvePreviewPanelInlineWidth({
      ratio: 0.2,
      defaultWidth: PREVIEW_PANEL_DEFAULT_WIDTH,
      viewportWidth: 1200,
      containerWidth: 1000,
    });
    expect(narrow.width).toBe(PREVIEW_PANEL_MIN_WIDTH);

    const wide = resolvePreviewPanelInlineWidth({
      ratio: 0.9,
      defaultWidth: PREVIEW_PANEL_DEFAULT_WIDTH,
      viewportWidth: 1400,
      containerWidth: 1100,
    });
    // containerCap = 1100 - 360 = 740, fractionCap = floor(1400 * 0.7) = 980
    expect(wide.maxWidth).toBe(740);
    expect(wide.width).toBe(740);
  });

  it("falls back to viewport width when container width is unavailable or zero", () => {
    const zeroContainer = resolvePreviewPanelInlineWidth({
      ratio: 0.45,
      defaultWidth: PREVIEW_PANEL_DEFAULT_WIDTH,
      viewportWidth: 1600,
      containerWidth: 0,
    });
    expect(zeroContainer.referenceWidth).toBe(1600);
    expect(zeroContainer.width).toBe(720);
  });

  it("ignores invalid ratio values and returns null when reference width is non-positive", () => {
    expect(computePreviewPanelWidthRatio(600, 0)).toBeNull();
    expect(computePreviewPanelWidthRatio(Number.NaN, 1200)).toBeNull();

    const invalidRatio = resolvePreviewPanelInlineWidth({
      ratio: 1.5,
      defaultWidth: 540,
      viewportWidth: 1600,
      containerWidth: 1320,
    });
    expect(invalidRatio.width).toBe(540);
  });
});
