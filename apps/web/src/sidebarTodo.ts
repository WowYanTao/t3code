import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ServerSettingsPatch,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";
import { environmentCatalog } from "./connection/catalog";
import {
  getClientSettings,
  isClientSettingsHydrated,
  persistClientSettingsUpdate,
  subscribeClientSettings,
  subscribeClientSettingsHydration,
  useClientSettings,
} from "./hooks/useSettings";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { serverEnvironment } from "./state/server";
import { readEnvironmentScope } from "./state/session";

type SidebarSyncField = "todo" | "projectPinned";

interface OptimisticEntry {
  readonly ids: ReadonlyArray<string>;
  readonly base: ReadonlyArray<string> | undefined;
  pending: boolean;
}

const optimisticEntries: Record<SidebarSyncField, Map<EnvironmentId, OptimisticEntry>> = {
  todo: new Map(),
  projectPinned: new Map(),
};

let optimisticVersion = 0;
const optimisticListeners = new Set<() => void>();

function emitOptimisticChange(): void {
  optimisticVersion += 1;
  for (const listener of optimisticListeners) {
    listener();
  }
}

function subscribeOptimistic(listener: () => void): () => void {
  optimisticListeners.add(listener);
  return () => {
    optimisticListeners.delete(listener);
  };
}

function getOptimisticVersion(): number {
  return optimisticVersion;
}

const environmentSidebarSyncStateAtom = Atom.make((get) => {
  const todoByEnv = new Map<EnvironmentId, ReadonlyArray<string>>();
  const projectPinnedByEnv = new Map<EnvironmentId, ReadonlyArray<string>>();
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const settings = get(serverEnvironment.settingsValueAtom(environmentId));
    if (!settings) continue;
    todoByEnv.set(environmentId, settings.sidebarTodoThreadIds);
    projectPinnedByEnv.set(environmentId, settings.sidebarProjectPinnedThreadIds);
  }
  return { todoByEnv, projectPinnedByEnv };
}).pipe(Atom.withLabel("web-sidebar-sync-state"));

let reconcileSubscribed = false;

function ensureOptimisticReconcileSubscribed(): void {
  if (reconcileSubscribed) return;
  reconcileSubscribed = true;
  appAtomRegistry.subscribe(environmentSidebarSyncStateAtom, (state) => {
    let changed = false;
    for (const [envId, entry] of optimisticEntries.todo) {
      if (!entry.pending && state.todoByEnv.get(envId) !== entry.base) {
        optimisticEntries.todo.delete(envId);
        changed = true;
      }
    }
    for (const [envId, entry] of optimisticEntries.projectPinned) {
      if (!entry.pending && state.projectPinnedByEnv.get(envId) !== entry.base) {
        optimisticEntries.projectPinned.delete(envId);
        changed = true;
      }
    }
    if (changed) emitOptimisticChange();
  });
}

function arraysEqual(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

export function mergeSyncedSidebarThreadKeys(
  serverIdsByEnv: ReadonlyMap<EnvironmentId, ReadonlyArray<string>>,
  localKeys: ReadonlyArray<string>,
  optimisticByEnv?: ReadonlyMap<EnvironmentId, ReadonlyArray<string>>,
): ReadonlyArray<string> {
  const result: Array<string> = [];
  const seen = new Set<string>();
  const envIds = new Set<EnvironmentId>([
    ...serverIdsByEnv.keys(),
    ...(optimisticByEnv ? optimisticByEnv.keys() : []),
  ]);

  for (const environmentId of envIds) {
    const ids = optimisticByEnv?.get(environmentId) ?? serverIdsByEnv.get(environmentId) ?? [];
    for (const id of ids) {
      const key = scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(key);
    }
  }

  for (const key of localKeys) {
    if (seen.has(key)) continue;
    const parsed = parseScopedThreadKey(key);
    if (parsed && optimisticByEnv?.has(parsed.environmentId)) continue;
    seen.add(key);
    result.push(key);
  }

  return result;
}

function activeOptimisticMap(
  field: SidebarSyncField,
): ReadonlyMap<EnvironmentId, ReadonlyArray<string>> {
  const map = new Map<EnvironmentId, ReadonlyArray<string>>();
  for (const [envId, entry] of optimisticEntries[field]) {
    map.set(envId, entry.ids);
  }
  return map;
}

function readMergedKeys(field: SidebarSyncField): ReadonlyArray<string> {
  const syncState = appAtomRegistry.get(environmentSidebarSyncStateAtom);
  const clientSettings = getClientSettings();
  return mergeSyncedSidebarThreadKeys(
    field === "todo" ? syncState.todoByEnv : syncState.projectPinnedByEnv,
    field === "todo"
      ? clientSettings.sidebarTodoThreadKeys
      : clientSettings.sidebarProjectPinnedThreadKeys,
    activeOptimisticMap(field),
  );
}

function readEnvironmentThreadIds(
  field: SidebarSyncField,
  environmentId: EnvironmentId,
): ReadonlyArray<string> {
  const optimistic = optimisticEntries[field].get(environmentId);
  if (optimistic) return optimistic.ids;

  const settings = appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
  const serverIds =
    settings === null
      ? []
      : field === "todo"
        ? settings.sidebarTodoThreadIds
        : settings.sidebarProjectPinnedThreadIds;
  const localKeys =
    field === "todo"
      ? getClientSettings().sidebarTodoThreadKeys
      : getClientSettings().sidebarProjectPinnedThreadKeys;

  const merged: Array<string> = [...serverIds];
  const seen = new Set(serverIds);
  for (const key of localKeys) {
    const parsed = parseScopedThreadKey(key);
    if (!parsed || parsed.environmentId !== environmentId) continue;
    if (seen.has(parsed.threadId)) continue;
    seen.add(parsed.threadId);
    merged.push(parsed.threadId);
  }
  return merged;
}

function replaceLocalKeysForEnvironment(
  field: SidebarSyncField,
  environmentId: EnvironmentId,
  nextThreadIds: ReadonlyArray<string>,
): void {
  const nextKeysForEnv = nextThreadIds.map((id) =>
    scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id))),
  );
  void persistClientSettingsUpdate((current) => {
    const currentKeys =
      field === "todo" ? current.sidebarTodoThreadKeys : current.sidebarProjectPinnedThreadKeys;
    const otherKeys = currentKeys.filter(
      (key) => parseScopedThreadKey(key)?.environmentId !== environmentId,
    );
    const nextKeys = [...nextKeysForEnv, ...otherKeys];
    if (arraysEqual(currentKeys, nextKeys)) return current;
    return field === "todo"
      ? { ...current, sidebarTodoThreadKeys: nextKeys }
      : { ...current, sidebarProjectPinnedThreadKeys: nextKeys };
  });
}

function clearLocalKeysForEnvironment(field: SidebarSyncField, environmentId: EnvironmentId): void {
  void persistClientSettingsUpdate((current) => {
    const currentKeys =
      field === "todo" ? current.sidebarTodoThreadKeys : current.sidebarProjectPinnedThreadKeys;
    const nextKeys = currentKeys.filter(
      (key) => parseScopedThreadKey(key)?.environmentId !== environmentId,
    );
    if (nextKeys.length === currentKeys.length) return current;
    return field === "todo"
      ? { ...current, sidebarTodoThreadKeys: nextKeys }
      : { ...current, sidebarProjectPinnedThreadKeys: nextKeys };
  });
}

function commitEnvironmentThreadIds(
  field: SidebarSyncField,
  environmentId: EnvironmentId,
  nextThreadIds: ReadonlyArray<string>,
): void {
  ensureOptimisticReconcileSubscribed();
  const dedupedIds = [...new Set(nextThreadIds)];
  const currentSettings = appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
  const canWriteServer =
    currentSettings !== null && readEnvironmentScope(environmentId, AuthSettingsWriteScope);

  if (!canWriteServer) {
    replaceLocalKeysForEnvironment(field, environmentId, dedupedIds);
    return;
  }

  const baseServerIds =
    field === "todo"
      ? currentSettings.sidebarTodoThreadIds
      : currentSettings.sidebarProjectPinnedThreadIds;
  const entry: OptimisticEntry = {
    ids: dedupedIds,
    base: baseServerIds,
    pending: true,
  };
  optimisticEntries[field].set(environmentId, entry);
  emitOptimisticChange();

  const patch: ServerSettingsPatch =
    field === "todo"
      ? { sidebarTodoThreadIds: dedupedIds }
      : { sidebarProjectPinnedThreadIds: dedupedIds };

  void runAtomCommand(
    appAtomRegistry,
    serverEnvironment.updateSettings,
    { environmentId, input: { patch } },
    { reportFailure: false },
  ).then((result) => {
    if (optimisticEntries[field].get(environmentId) !== entry) return;
    if (AsyncResult.isSuccess(result)) {
      const persistedIds =
        field === "todo"
          ? result.value.sidebarTodoThreadIds
          : result.value.sidebarProjectPinnedThreadIds;
      if (arraysEqual(persistedIds, dedupedIds)) {
        entry.pending = false;
        clearLocalKeysForEnvironment(field, environmentId);
        const latestSettings = appAtomRegistry.get(
          serverEnvironment.settingsValueAtom(environmentId),
        );
        const latestIds =
          latestSettings === null
            ? undefined
            : field === "todo"
              ? latestSettings.sidebarTodoThreadIds
              : latestSettings.sidebarProjectPinnedThreadIds;
        if (latestIds !== undefined && arraysEqual(latestIds, dedupedIds)) {
          optimisticEntries[field].delete(environmentId);
          emitOptimisticChange();
        }
        return;
      }
    }
    // Older/stock servers strip unknown fields or reject writes; fall back to client storage.
    optimisticEntries[field].delete(environmentId);
    emitOptimisticChange();
    replaceLocalKeysForEnvironment(field, environmentId, dedupedIds);
  });
}

export function useSidebarTodoThreadKeys(): ReadonlyArray<string> {
  const syncState = useAtomValue(environmentSidebarSyncStateAtom);
  const localKeys = useClientSettings((settings) => settings.sidebarTodoThreadKeys);
  useSyncExternalStore(subscribeOptimistic, getOptimisticVersion, getOptimisticVersion);
  return mergeSyncedSidebarThreadKeys(syncState.todoByEnv, localKeys, activeOptimisticMap("todo"));
}

export function useSidebarProjectPinnedThreadKeys(): ReadonlyArray<string> {
  const syncState = useAtomValue(environmentSidebarSyncStateAtom);
  const localKeys = useClientSettings((settings) => settings.sidebarProjectPinnedThreadKeys);
  useSyncExternalStore(subscribeOptimistic, getOptimisticVersion, getOptimisticVersion);
  return mergeSyncedSidebarThreadKeys(
    syncState.projectPinnedByEnv,
    localKeys,
    activeOptimisticMap("projectPinned"),
  );
}

export function isSidebarTodoThread(threadKey: string): boolean {
  return readMergedKeys("todo").includes(threadKey);
}

export function isSidebarProjectPinnedThread(threadKey: string): boolean {
  return readMergedKeys("projectPinned").includes(threadKey);
}

export function toggleSidebarTodoThread(threadKey: string): boolean {
  const parsed = parseScopedThreadKey(threadKey);
  if (!parsed) return false;
  const current = readEnvironmentThreadIds("todo", parsed.environmentId);
  if (current.includes(parsed.threadId)) {
    commitEnvironmentThreadIds(
      "todo",
      parsed.environmentId,
      current.filter((id) => id !== parsed.threadId),
    );
    return false;
  }
  commitEnvironmentThreadIds("todo", parsed.environmentId, [parsed.threadId, ...current]);
  return true;
}

export function removeSidebarTodoThread(threadKey: string): void {
  const parsed = parseScopedThreadKey(threadKey);
  if (!parsed) return;
  const current = readEnvironmentThreadIds("todo", parsed.environmentId);
  if (!current.includes(parsed.threadId)) return;
  commitEnvironmentThreadIds(
    "todo",
    parsed.environmentId,
    current.filter((id) => id !== parsed.threadId),
  );
}

export function pinSidebarProjectThread(threadKey: string): void {
  const parsed = parseScopedThreadKey(threadKey);
  if (!parsed) return;
  const current = readEnvironmentThreadIds("projectPinned", parsed.environmentId);
  const next = [parsed.threadId, ...current.filter((id) => id !== parsed.threadId)];
  commitEnvironmentThreadIds("projectPinned", parsed.environmentId, next);
}

export function unpinSidebarProjectThread(threadKey: string): void {
  const parsed = parseScopedThreadKey(threadKey);
  if (!parsed) return;
  const current = readEnvironmentThreadIds("projectPinned", parsed.environmentId);
  if (!current.includes(parsed.threadId)) return;
  commitEnvironmentThreadIds(
    "projectPinned",
    parsed.environmentId,
    current.filter((id) => id !== parsed.threadId),
  );
}

export function setSidebarProjectPinnedThreadKeys(nextPinnedKeys: ReadonlyArray<string>): void {
  const grouped = new Map<EnvironmentId, Array<string>>();
  const envIds = new Set<EnvironmentId>([
    ...appAtomRegistry.get(environmentSidebarSyncStateAtom).projectPinnedByEnv.keys(),
    ...optimisticEntries.projectPinned.keys(),
  ]);
  for (const key of getClientSettings().sidebarProjectPinnedThreadKeys) {
    const parsed = parseScopedThreadKey(key);
    if (parsed) envIds.add(parsed.environmentId);
  }
  for (const key of nextPinnedKeys) {
    const parsed = parseScopedThreadKey(key);
    if (!parsed) continue;
    envIds.add(parsed.environmentId);
    const list = grouped.get(parsed.environmentId) ?? [];
    list.push(parsed.threadId);
    grouped.set(parsed.environmentId, list);
  }
  for (const environmentId of envIds) {
    const nextIds = grouped.get(environmentId) ?? [];
    const currentIds = readEnvironmentThreadIds("projectPinned", environmentId);
    if (arraysEqual(currentIds, nextIds)) continue;
    commitEnvironmentThreadIds("projectPinned", environmentId, nextIds);
  }
}

const attemptedSidebarMigrationGenerations = new Map<EnvironmentId, number>();

const sidebarSyncMigrationTargetsAtom = Atom.make((get) =>
  [...get(environmentCatalog.catalogValueAtom).entries.keys()].flatMap((environmentId) => {
    const generation = Option.match(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      {
        onNone: () => null,
        onSome: (connection) => (connection.phase === "connected" ? connection.generation : null),
      },
    );
    const settings = get(serverEnvironment.settingsValueAtom(environmentId));
    return generation === null || settings === null
      ? []
      : [{ environmentId, generation, settings }];
  }),
).pipe(Atom.withLabel("web-sidebar-sync-migration-targets"));

function migrateLocalSidebarLists(): void {
  if (!isClientSettingsHydrated()) return;
  const clientSettings = getClientSettings();
  if (
    clientSettings.sidebarTodoThreadKeys.length === 0 &&
    clientSettings.sidebarProjectPinnedThreadKeys.length === 0
  ) {
    return;
  }

  for (const { environmentId, generation, settings } of appAtomRegistry.get(
    sidebarSyncMigrationTargetsAtom,
  )) {
    if (attemptedSidebarMigrationGenerations.get(environmentId) === generation) continue;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) continue;

    const localTodoIds = clientSettings.sidebarTodoThreadKeys.flatMap((key) => {
      const parsed = parseScopedThreadKey(key);
      return parsed && parsed.environmentId === environmentId ? [parsed.threadId] : [];
    });
    const localProjectPinnedIds = clientSettings.sidebarProjectPinnedThreadKeys.flatMap((key) => {
      const parsed = parseScopedThreadKey(key);
      return parsed && parsed.environmentId === environmentId ? [parsed.threadId] : [];
    });
    if (localTodoIds.length === 0 && localProjectPinnedIds.length === 0) continue;

    attemptedSidebarMigrationGenerations.set(environmentId, generation);
    const mergedTodoIds = [
      ...settings.sidebarTodoThreadIds,
      ...localTodoIds.filter((id) => !settings.sidebarTodoThreadIds.includes(id)),
    ];
    const mergedProjectPinnedIds = [
      ...settings.sidebarProjectPinnedThreadIds,
      ...localProjectPinnedIds.filter((id) => !settings.sidebarProjectPinnedThreadIds.includes(id)),
    ];
    const patch: ServerSettingsPatch = {
      ...(localTodoIds.length > 0 ? { sidebarTodoThreadIds: mergedTodoIds } : {}),
      ...(localProjectPinnedIds.length > 0
        ? { sidebarProjectPinnedThreadIds: mergedProjectPinnedIds }
        : {}),
    };

    void runAtomCommand(
      appAtomRegistry,
      serverEnvironment.updateSettings,
      { environmentId, input: { patch } },
      { reportFailure: false },
    ).then((result) => {
      if (!AsyncResult.isSuccess(result)) return;
      const persistedTodo = result.value.sidebarTodoThreadIds;
      const persistedProjectPinned = result.value.sidebarProjectPinnedThreadIds;
      const todoMigrated =
        localTodoIds.length > 0 && localTodoIds.every((id) => persistedTodo.includes(id));
      const projectPinnedMigrated =
        localProjectPinnedIds.length > 0 &&
        localProjectPinnedIds.every((id) => persistedProjectPinned.includes(id));
      if (!todoMigrated && !projectPinnedMigrated) return;

      void persistClientSettingsUpdate((current) => ({
        ...current,
        ...(todoMigrated
          ? {
              sidebarTodoThreadKeys: current.sidebarTodoThreadKeys.filter(
                (key) => parseScopedThreadKey(key)?.environmentId !== environmentId,
              ),
            }
          : {}),
        ...(projectPinnedMigrated
          ? {
              sidebarProjectPinnedThreadKeys: current.sidebarProjectPinnedThreadKeys.filter(
                (key) => parseScopedThreadKey(key)?.environmentId !== environmentId,
              ),
            }
          : {}),
      }));
    });
  }
}

export function startSidebarSyncMigration(): () => void {
  ensureOptimisticReconcileSubscribed();
  const unsubscribes = [
    appAtomRegistry.subscribe(sidebarSyncMigrationTargetsAtom, migrateLocalSidebarLists),
    subscribeClientSettings(migrateLocalSidebarLists),
    subscribeClientSettingsHydration(migrateLocalSidebarLists),
  ];
  migrateLocalSidebarLists();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
