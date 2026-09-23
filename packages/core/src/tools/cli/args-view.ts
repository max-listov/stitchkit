/**
 * `--count-by`, `--sum`, `--by`, `--top`, `--table`, `--sort`, `--ascending`:
 * the flags that ask for an aggregate or a table instead of the raw result,
 * resolved to one view or refused as a combination before the command runs.
 */
import { CliArgumentError } from './argument-error';

/**
 * A requested aggregate view over the result.
 *
 * `--by` always names the grouping field, in every form it appears in, so the
 * grammar has one meaning rather than two: `--top 5 --by status` is the five
 * largest groups of `status`, exactly as `--count-by status --top 5` is.
 */
export type CliResultView =
  | { kind: 'count'; field: string; top?: number }
  | { kind: 'sum'; field: string; by?: string; top?: number }
  | {
      kind: 'records';
      sort?: string;
      ascending?: boolean;
      top?: number;
      table?: readonly string[];
    };

/**
 * Turn the raw view flags into one view, or refuse the combination.
 *
 * Refusing here rather than at emission time is the point: a caller who asked
 * for two aggregates at once, or for `--by` with nothing to group, gets the
 * message before the command runs, not a shape they did not ask for after it.
 */
export function resolveCliView(
  flags: ReadonlyMap<string, string>,
  ascending: boolean,
): CliResultView | undefined {
  if (flags.size === 0) {
    if (ascending) {
      throw new CliArgumentError('--ascending orders a record view; pass --sort with it');
    }
    return undefined;
  }
  const countBy = flags.get('count-by');
  const sum = flags.get('sum');
  const table = flags.get('table');
  const by = flags.get('by');
  const rawTop = flags.get('top');

  const named = [
    ['--count-by', countBy],
    ['--sum', sum],
  ].filter(([, value]) => value !== undefined);
  if (named.length > 1) {
    throw new CliArgumentError(
      `${named.map(([flag]) => flag).join(' and ')} ask for different shapes — pass one`,
    );
  }

  let top: number | undefined;
  if (rawTop !== undefined) {
    top = Number(rawTop);
    if (!Number.isInteger(top) || top <= 0) {
      throw new CliArgumentError('--top must be a positive whole number');
    }
  }

  const sort = flags.get('sort');

  // `--table` and `--sort` describe the same view — the records themselves — so
  // they compose. `--top` keeps the single meaning it has everywhere: the n
  // leading entries of whatever view was asked for, groups or records.
  if (table !== undefined || sort !== undefined) {
    if (countBy !== undefined || sum !== undefined) {
      throw new CliArgumentError(
        `${table !== undefined ? '--table' : '--sort'} lists records; --count-by and --sum aggregate them — pass one`,
      );
    }
    if (by !== undefined) {
      throw new CliArgumentError('--by groups a view; a record view orders with --sort');
    }
    if (top !== undefined && sort === undefined) {
      throw new CliArgumentError(
        '--top needs --sort here: unordered records have no n largest',
      );
    }
    let fields: string[] | undefined;
    if (table !== undefined) {
      fields = table
        .split(',')
        .map((field) => field.trim())
        .filter(Boolean);
      if (fields.length === 0) throw new CliArgumentError('--table needs at least one field');
    }
    return {
      kind: 'records',
      ...(sort !== undefined && { sort }),
      ...(ascending && { ascending }),
      ...(top !== undefined && { top }),
      ...(fields && { table: fields }),
    };
  }

  if (ascending) {
    throw new CliArgumentError('--ascending orders a record view; pass --sort with it');
  }

  if (sum !== undefined) {
    if (top !== undefined && by === undefined) {
      throw new CliArgumentError('--top needs --by: a single sum has nothing to rank');
    }
    return {
      kind: 'sum',
      field: sum,
      ...(by !== undefined && { by }),
      ...(top !== undefined && { top }),
    };
  }

  if (countBy !== undefined) {
    if (by !== undefined) {
      throw new CliArgumentError('--count-by already names the grouping field; drop --by');
    }
    return { kind: 'count', field: countBy, ...(top !== undefined && { top }) };
  }

  if (by !== undefined) {
    if (top === undefined) {
      throw new CliArgumentError(
        '--by groups a view; pass --count-by, --sum or --top with it',
      );
    }
    return { kind: 'count', field: by, top };
  }
  throw new CliArgumentError('--top needs --sort, --by, --count-by or --sum to rank');
}
