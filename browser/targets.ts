import { AgentId, KindId } from "../core/agent.js";
import {
  CONFIG_DIRS, placement, Placement, RootState, SHARED_CONFIG_DIR, targets,
} from "../core/placement.js";
import { rootState } from "./fs.js";

export type TargetOption = {
  readonly agent: AgentId;
  readonly where: Placement;
  readonly state: RootState;
};

export type TargetSet = {
  readonly options: TargetOption[];
  readonly shared: boolean;
};

export async function targetSet(kind: KindId, name: string): Promise<TargetSet> {
  const pairs = await Promise.all(
    CONFIG_DIRS.map(async configDir => [configDir, await rootState(configDir)] as const),
  );
  const roots = new Map(pairs);
  const stateOf = (configDir: string): RootState =>
    roots.get(configDir) ?? { kind: "unset" };
  const shared = stateOf(SHARED_CONFIG_DIR).kind === "ok";
  const options: TargetOption[] = [];

  for (const agent of targets(kind)) {
    const where = placement(agent, kind, name, shared);
    if (where === null) continue;
    options.push({ agent, where, state: stateOf(where.configDir) });
  }
  return { options, shared };
}
