export interface CliOptions {
  destination: string;
  install: boolean;
  example?: 'repository';
  displayName?: string;
}

const HELP = `Create a production-shaped Stitchkit application.

Usage:
  bun create stitchkit <directory> [--display-name "Product Name"] [--example repository] [--no-install]

Options:
  --no-install  Generate files without installing dependencies
  --example     Add an isolated runnable example (supported: repository)
  --display-name  Set the initial public application name
  --help        Show this help
`;

export function helpText(): string {
  return HELP;
}

export function parseOptions(args: string[]): CliOptions | 'help' {
  if (args.includes('--help') || args.includes('-h')) return 'help';

  const unknown = args.filter(
    (arg) =>
      arg.startsWith('-') &&
      arg !== '--no-install' &&
      arg !== '--example' &&
      arg !== '--display-name',
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown option: ${unknown[0]}`);
  }

  const exampleFlagIndex = args.indexOf('--example');
  const example = exampleFlagIndex === -1 ? undefined : args[exampleFlagIndex + 1];
  if (exampleFlagIndex !== -1 && example === undefined) {
    throw new Error('--example requires a value');
  }
  if (example !== undefined && example !== 'repository') {
    throw new Error(`Unknown example: ${example}`);
  }

  const displayNameFlagIndex = args.indexOf('--display-name');
  const displayName = displayNameFlagIndex === -1 ? undefined : args[displayNameFlagIndex + 1];
  if (displayNameFlagIndex !== -1 && displayName === undefined) {
    throw new Error('--display-name requires a value');
  }

  const consumedExampleIndex = exampleFlagIndex === -1 ? -1 : exampleFlagIndex + 1;
  const consumedDisplayNameIndex = displayNameFlagIndex === -1 ? -1 : displayNameFlagIndex + 1;
  const positionals = args.filter(
    (arg, index) =>
      !arg.startsWith('-') &&
      index !== consumedExampleIndex &&
      index !== consumedDisplayNameIndex,
  );
  if (positionals.length !== 1) {
    throw new Error('Exactly one destination directory is required');
  }
  const destination = positionals[0];
  if (destination === undefined) throw new Error('Destination directory is required');

  return {
    destination,
    install: !args.includes('--no-install'),
    ...(example && { example }),
    ...(displayName && { displayName }),
  };
}
