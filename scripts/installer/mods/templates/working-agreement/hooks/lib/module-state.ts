/** One holder of module state and how a fresh evaluation of its module builds it. */
interface Holder { state: object; create: () => object }

/** The contents of every holder at one moment, in declaration order. */
export type ModuleSnapshot = readonly object[]

const holders: Holder[] = []

/**
 * Declares state a module keeps for the life of one load, which a reload of the mod builds again; declaring it here is what lets a
 * reload simulation start it over or hand it back to the module the reload replaced.
 * @param create - Builds the state as a fresh evaluation of the module does.
 * @returns The state, one object the module keeps and mutates.
 */
export function moduleState<T extends object>(create: () => T): T {
  const state = create()
  holders.push({ state, create })
  return state
}

/**
 * Starts every declared holder over, as a reload evaluates the modules again; the mod never calls it, while the reload tests do,
 * since the plugin test kit cannot evaluate a module a second time.
 * @returns What the holders held before, for the module the reload replaced.
 */
export function renewModuleState(): ModuleSnapshot {
  return replaceModuleState(holders.map(holder => holder.create()))
}

/**
 * Puts a snapshot's contents back into the holders.
 * @param snapshot - The contents, in declaration order.
 * @returns What the holders held before.
 */
export function replaceModuleState(snapshot: ModuleSnapshot): ModuleSnapshot {
  return holders.map((holder, index) => {
    const before = { ...holder.state }
    for (const key of Object.keys(holder.state)) Reflect.deleteProperty(holder.state, key)
    Object.assign(holder.state, snapshot[index])
    return before
  })
}
