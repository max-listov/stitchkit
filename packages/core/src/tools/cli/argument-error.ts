/** A command line that cannot be read: an unknown option, a missing value, a value of the wrong kind. */
export class CliArgumentError extends Error {
  override name = 'CliArgumentError';
}
