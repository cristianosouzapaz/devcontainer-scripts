interface Queue { <T>(work: () => Promise<T>): Promise<T> }

/**
 * Creates an independent serial queue that forwards each result and survives rejections.
 * @returns The function that queues one asynchronous operation.
 */
export function createQueue(): Queue {
  const state = { tail: Promise.resolve<unknown>(undefined) }
  return <T>(work: () => Promise<T>): Promise<T> => {
    const queued = state.tail.then(work)
    // A failed caller must not prevent the next operation from running.
    state.tail = queued.then(() => undefined, () => undefined)
    return queued
  }
}

/**
 * Creates a limiter that runs at most this many operations at once, starting the others in arrival order as earlier
 * ones settle.
 * @param limit - How many operations may run at once.
 * @returns The function that runs one asynchronous operation under the limit.
 */
export function createLimiter(limit: number): Queue {
  const state = { active: 0, waiting: [] as (() => void)[] }
  return async <T>(work: () => Promise<T>): Promise<T> => {
    // A settling operation hands its slot straight to the next waiter, so a newcomer never takes it first.
    if (state.active >= limit) await new Promise<void>(resolve => { state.waiting.push(resolve) })
    else state.active += 1
    try {
      return await work()
    } finally {
      const next = state.waiting.shift()
      if (next) next()
      else state.active -= 1
    }
  }
}
