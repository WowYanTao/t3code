import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  hasCompletedRun: true,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it.each([
    ["while the thread is running", { isRunning: true }],
    ["before any run has completed", { hasCompletedRun: false }],
  ])("omits mark unread %s", (_, overrides) => {
    const items = buildThreadActionMenuItems({ ...baseState, ...overrides });
    expect(items.map((item) => item.id)).not.toContain("mark-unread");
  });

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });

  it("offers project-local and global pin transitions when projectPinning is supported", () => {
    const unpinned = buildThreadActionMenuItems({
      ...baseState,
      supports: { ...baseState.supports, projectPinning: true },
    });
    expect(
      unpinned
        .filter((item) => item.id === "pin-project" || item.id === "pin")
        .map((item) => item.id),
    ).toEqual(["pin-project", "pin"]);

    const projectPinned = buildThreadActionMenuItems({
      ...baseState,
      isProjectPinned: true,
      supports: { ...baseState.supports, projectPinning: true },
    });
    expect(
      projectPinned
        .filter((item) => item.id === "unpin-project" || item.id === "pin")
        .map((item) => item.id),
    ).toEqual(["unpin-project", "pin"]);

    const globalPinned = buildThreadActionMenuItems({
      ...baseState,
      isPinned: true,
      supports: { ...baseState.supports, projectPinning: true },
    });
    expect(
      globalPinned
        .filter((item) => item.id === "unpin" || item.id === "pin-project")
        .map((item) => item.id),
    ).toEqual(["unpin", "pin-project"]);
  });

  it("toggles manual todo menu item for unsettled threads", () => {
    const addTodo = buildThreadActionMenuItems({
      ...baseState,
      isTodo: false,
    });
    expect(addTodo.map((item) => item.id)).toContain("add-todo");
    expect(addTodo.map((item) => item.id)).not.toContain("remove-todo");

    const removeTodo = buildThreadActionMenuItems({
      ...baseState,
      isTodo: true,
    });
    expect(removeTodo.map((item) => item.id)).toContain("remove-todo");
    expect(removeTodo.map((item) => item.id)).not.toContain("add-todo");

    const settled = buildThreadActionMenuItems({
      ...baseState,
      isSettled: true,
      isTodo: false,
    });
    expect(settled.map((item) => item.id)).not.toContain("add-todo");
    expect(settled.map((item) => item.id)).not.toContain("remove-todo");
  });
});
