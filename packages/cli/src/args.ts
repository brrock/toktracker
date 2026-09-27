import { didYouMean, usageError } from "./ui";

export interface FlagSpec {
  booleans?: readonly string[];
  values?: readonly string[];
}

export interface ParsedArgs {
  booleans: Set<string>;
  positionals: string[];
  values: Map<string, string>;
}

/**
 * Splits command arguments into positionals and known flags. Unknown flags
 * fail fast with a suggestion rather than being silently ignored.
 */
export const parseArgs = (
  args: readonly string[],
  spec: FlagSpec,
  helpCommand: string
): ParsedArgs => {
  const booleanFlags = spec.booleans ?? [];
  const valueFlags = spec.values ?? [];
  const parsed: ParsedArgs = {
    booleans: new Set(),
    positionals: [],
    values: new Map(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!argument.startsWith("-") || argument === "-") {
      parsed.positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue =
      separator === -1 ? undefined : argument.slice(separator + 1);
    if (booleanFlags.includes(flag) && inlineValue === undefined) {
      parsed.booleans.add(flag);
      continue;
    }
    if (valueFlags.includes(flag)) {
      const value = inlineValue ?? args[index + 1];
      if (
        value === undefined ||
        (inlineValue === undefined && value.startsWith("--"))
      ) {
        throw usageError(
          `${flag} requires a value`,
          `Run ${helpCommand} --help for usage.`
        );
      }
      parsed.values.set(flag, value);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    const known = [...booleanFlags, ...valueFlags];
    throw usageError(
      `Unknown option ${flag}`,
      didYouMean(flag, known) ?? `Run ${helpCommand} --help for usage.`
    );
  }
  return parsed;
};
