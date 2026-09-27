// Small terminal presentation layer shared by every CLI command. Colors are
// only emitted to interactive terminals and honor NO_COLOR / FORCE_COLOR.

type Stream = NodeJS.WriteStream;

const ESCAPE = String.fromCodePoint(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "gu");
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const colorEnabled = (stream: Stream): boolean => {
  if (process.env.NO_COLOR) {
    return false;
  }
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") {
    return true;
  }
  return Boolean(stream.isTTY) && process.env.TERM !== "dumb";
};

const paint =
  (open: number, close: number) =>
  (value: string, stream: Stream = process.stdout): string =>
    colorEnabled(stream)
      ? `${ESCAPE}[${open}m${value}${ESCAPE}[${close}m`
      : value;

export const bold = paint(1, 22);
export const dim = paint(2, 22);
export const red = paint(31, 39);
export const green = paint(32, 39);
export const yellow = paint(33, 39);
export const cyan = paint(36, 39);

const unicode = process.platform !== "win32" || Boolean(process.env.WT_SESSION);
export const symbols = {
  arrow: unicode ? "›" : ">",
  bullet: unicode ? "•" : "*",
  error: unicode ? "✖" : "x",
  info: unicode ? "ℹ" : "i",
  success: unicode ? "✔" : "v",
  warning: unicode ? "⚠" : "!",
} as const;

export const visibleLength = (value: string): number =>
  value.replaceAll(ANSI_PATTERN, "").length;

const padEnd = (value: string, width: number): string =>
  `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;

/** Aligns rows into columns separated by two spaces. */
export const formatTable = (rows: string[][], indent = ""): string => {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [index, cell] of row.entries()) {
      widths[index] = Math.max(widths[index] ?? 0, visibleLength(cell));
    }
  }
  return rows
    .map((row) =>
      `${indent}${row
        .map((cell, index) =>
          index === row.length - 1 ? cell : padEnd(cell, widths[index] ?? 0)
        )
        .join("  ")}`.trimEnd()
    )
    .join("\n");
};

export const printSuccess = (message: string): void => {
  console.log(`${green(symbols.success)} ${message}`);
};
export const printInfo = (message: string): void => {
  console.log(`${cyan(symbols.info)} ${message}`);
};
export const printStep = (message: string): void => {
  console.log(`${dim(symbols.arrow)} ${message}`);
};
export const printWarning = (message: string): void => {
  console.warn(
    `${yellow(symbols.warning, process.stderr)} ${yellow(message, process.stderr)}`
  );
};

/** An expected failure: printed without a stack trace. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(
    message: string,
    hint?: string,
    exitCode = EXIT_FAILURE,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CliError";
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

/** Invalid invocation: exits with status 2, like most Unix tools. */
export const usageError = (message: string, hint?: string): CliError =>
  new CliError(message, hint, EXIT_USAGE);

const editDistance = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [leftIndex, leftCharacter] of [...left].entries()) {
    const current = [leftIndex + 1];
    for (const [rightIndex, rightCharacter] of [...right].entries()) {
      current.push(
        Math.min(
          (current[rightIndex] ?? 0) + 1,
          (previous[rightIndex + 1] ?? 0) + 1,
          (previous[rightIndex] ?? 0) +
            (leftCharacter === rightCharacter ? 0 : 1)
        )
      );
    }
    previous = current;
  }
  return previous[right.length] ?? Number.POSITIVE_INFINITY;
};

/** Returns the closest candidate when it is plausibly a typo of the input. */
export const closestMatch = (
  input: string,
  candidates: readonly string[]
): string | undefined => {
  const normalized = input.toLowerCase();
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = candidate.startsWith(normalized)
      ? 0
      : editDistance(normalized, candidate);
    if (!best || distance < best.distance) {
      best = { candidate, distance };
    }
  }
  const threshold = Math.max(2, Math.floor(normalized.length / 3));
  return best && best.distance <= threshold ? best.candidate : undefined;
};

export const didYouMean = (
  input: string,
  candidates: readonly string[]
): string | undefined => {
  const match = closestMatch(input, candidates);
  return match ? `Did you mean ${bold(match, process.stderr)}?` : undefined;
};

const networkHint = (error: Error): string | undefined => {
  const code = "code" in error ? String(error.code) : "";
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") {
    return "Nothing is listening at that address. Is the service running?";
  }
  if (error.name === "TimeoutError") {
    return "The request timed out. Check the address and your network.";
  }
  return undefined;
};

/** Prints an error the way a user expects: one line, a cause, and a hint. */
export const reportError = (error: Error): number => {
  const stream = process.stderr;
  console.error(red(`${symbols.error} ${error.message}`, stream));
  let { cause } = error;
  let rootCause = error;
  while (cause !== undefined) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(dim(`  caused by: ${message}`, stream));
    if (!(cause instanceof Error)) {
      break;
    }
    rootCause = cause;
    ({ cause } = cause);
  }
  const hint = error instanceof CliError ? error.hint : networkHint(rootCause);
  if (hint) {
    console.error(`\n${hint}`);
  }
  if (process.env.TOKTRACKER_DEBUG && error.stack) {
    console.error(dim(`\n${error.stack}`, stream));
  } else if (!(error instanceof CliError)) {
    console.error(dim("\nSet TOKTRACKER_DEBUG=1 for a stack trace.", stream));
  }
  return error instanceof CliError ? error.exitCode : EXIT_FAILURE;
};
