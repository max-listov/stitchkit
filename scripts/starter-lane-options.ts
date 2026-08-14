export type StarterLaneMode = 'target' | 'head';
export type StarterLaneVariant = 'blank' | 'repository';

export interface StarterLaneOptions {
  mode: StarterLaneMode;
  variant: StarterLaneVariant;
}

function readNamedArgument(args: string[], name: string): string {
  const prefix = `--${name}=`;
  const matches = args.filter((argument) => argument.startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${prefix}<value> argument`);
  }
  const value = matches[0]?.slice(prefix.length);
  if (!value) throw new Error(`${prefix}<value> cannot be empty`);
  return value;
}

export function parseStarterLaneOptions(args: string[]): StarterLaneOptions {
  const unknown = args.filter(
    (argument) => !argument.startsWith('--mode=') && !argument.startsWith('--variant='),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown starter lane arguments: ${unknown.join(', ')}`);
  }

  const mode = readNamedArgument(args, 'mode');
  const variant = readNamedArgument(args, 'variant');
  if (mode !== 'target' && mode !== 'head') {
    throw new Error(`Unknown starter lane mode: ${mode}`);
  }
  if (variant !== 'blank' && variant !== 'repository') {
    throw new Error(`Unknown starter lane variant: ${variant}`);
  }
  return { mode, variant };
}
