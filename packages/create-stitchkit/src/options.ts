export interface CliOptions {
  destination: string;
  install: boolean;
}

const HELP = `Create a production-shaped Stitchkit application.

Usage:
  bun create stitchkit <directory> [--no-install]

Options:
  --no-install  Generate files without installing dependencies
  --help        Show this help
`;

export function helpText(): string {
  return HELP;
}

export function parseOptions(args: string[]): CliOptions | 'help' {
  if (args.includes('--help') || args.includes('-h')) return 'help';

  const unknown = args.filter((arg) => arg.startsWith('-') && arg !== '--no-install');
  if (unknown.length > 0) {
    throw new Error(`Unknown option: ${unknown[0]}`);
  }

  const positionals = args.filter((arg) => !arg.startsWith('-'));
  if (positionals.length !== 1) {
    throw new Error('Exactly one destination directory is required');
  }
  const destination = positionals[0];
  if (destination === undefined) throw new Error('Destination directory is required');

  return {
    destination,
    install: !args.includes('--no-install'),
  };
}
