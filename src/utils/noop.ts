/** A function that does nothing, for callbacks that must exist but have nothing to do (`promise.catch(noop)` swallows a rejection on purpose). */
export function noop(): void {
  // why: doing nothing is the point.
}
