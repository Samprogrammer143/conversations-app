// Requests that reach the primary instance while it is still starting up (a
// second instance started from a shortcut, or a button on a notification). They
// are kept and replayed once start-up is done, so none of them makes a window
// of its own before the main window exists.

export class StartupQueue<T> {
  private done = false;
  private queued: T[] = [];

  constructor(private handle: (item: T) => void) {}

  /** Handles the item now, or keeps it until start-up is done. */
  push(item: T) {
    if (this.done) this.handle(item);
    else this.queued.push(item);
  }

  /** Start-up is done: everything kept so far is handled, in order, and anything later at once. */
  finish() {
    this.done = true;
    for (const item of this.queued.splice(0)) this.handle(item);
  }

  get pending() {
    return this.queued.length;
  }
}
