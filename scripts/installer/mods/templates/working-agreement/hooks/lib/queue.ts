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
