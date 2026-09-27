/** A TokTracker SQL error that knows the line it happened on. */
export class SqlError extends Error {
  // A class field defines `name` on the instance; assigning it would fail
  // once the sandbox has frozen Error.prototype.
  override readonly name = "SqlError";
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}
