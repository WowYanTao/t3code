import { getClientSettings, updateClientSettings } from "./hooks/useSettings";

export function toggleSidebarTodoThread(threadKey: string): boolean {
  const current = getClientSettings().sidebarTodoThreadKeys;
  if (current.includes(threadKey)) {
    void updateClientSettings({
      sidebarTodoThreadKeys: current.filter((key) => key !== threadKey),
    });
    return false;
  }
  void updateClientSettings({
    sidebarTodoThreadKeys: [threadKey, ...current],
  });
  return true;
}

export function removeSidebarTodoThread(threadKey: string): void {
  const current = getClientSettings().sidebarTodoThreadKeys;
  if (!current.includes(threadKey)) return;
  void updateClientSettings({
    sidebarTodoThreadKeys: current.filter((key) => key !== threadKey),
  });
}
