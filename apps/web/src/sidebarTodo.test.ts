import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { mergeSyncedSidebarThreadKeys } from "./sidebarTodo";

const envWin = EnvironmentId.make("env-win");
const envMac = EnvironmentId.make("env-mac");

function key(env: EnvironmentId, id: string): string {
  return scopedThreadKey(scopeThreadRef(env, ThreadId.make(id)));
}

describe("mergeSyncedSidebarThreadKeys", () => {
  it("combines server ids across environments and preserves order without duplicates", () => {
    const serverByEnv = new Map<EnvironmentId, ReadonlyArray<string>>([
      [envWin, ["t1", "t2"]],
      [envMac, ["t3"]],
    ]);

    expect(
      mergeSyncedSidebarThreadKeys(serverByEnv, [key(envWin, "t2"), key(envWin, "t4")]),
    ).toEqual([key(envWin, "t1"), key(envWin, "t2"), key(envMac, "t3"), key(envWin, "t4")]);
  });

  it("lets optimistic entries supersede both server and unmigrated local keys for that environment", () => {
    const serverByEnv = new Map<EnvironmentId, ReadonlyArray<string>>([
      [envWin, ["t1", "t2"]],
      [envMac, ["t3"]],
    ]);
    const optimisticByEnv = new Map<EnvironmentId, ReadonlyArray<string>>([[envWin, ["t1"]]]);

    expect(
      mergeSyncedSidebarThreadKeys(
        serverByEnv,
        [key(envWin, "t2"), key(envMac, "t4")],
        optimisticByEnv,
      ),
    ).toEqual([key(envWin, "t1"), key(envMac, "t3"), key(envMac, "t4")]);
  });
});
