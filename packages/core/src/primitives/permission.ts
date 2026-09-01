export type PermissionGrantMatrix<TRole extends string, TOperation extends string> = Readonly<
  Record<TRole, Readonly<Record<TOperation, boolean>>>
>;

export type PermissionCheckResult =
  | { readonly outcome: 'allowed' }
  | { readonly outcome: 'denied' }
  | { readonly outcome: 'unknown_role'; readonly role: string }
  | { readonly outcome: 'unknown_operation'; readonly operation: string };

/** Declare every role × operation decision once for authorization and capability projection. */
export function definePermissionMatrix<
  const TRole extends string,
  const TOperation extends string,
>(config: {
  readonly roles: readonly TRole[];
  readonly operations: readonly TOperation[];
  readonly grants: PermissionGrantMatrix<TRole, TOperation>;
}) {
  if (new Set(config.roles).size !== config.roles.length) {
    throw new Error('[stitchkit] permission matrix roles must be unique');
  }
  if (new Set(config.operations).size !== config.operations.length) {
    throw new Error('[stitchkit] permission matrix operations must be unique');
  }
  for (const role of config.roles) {
    const declared = Object.keys(config.grants[role]).sort();
    const expected = [...config.operations].sort();
    if (
      declared.length !== expected.length ||
      declared.some((value, index) => value !== expected[index])
    ) {
      throw new Error(
        `[stitchkit] permission matrix role "${role}" must decide every operation`,
      );
    }
  }
  const roleSet: ReadonlySet<string> = new Set(config.roles);
  const operationSet: ReadonlySet<string> = new Set(config.operations);
  const decisions = new Map<string, boolean>();
  for (const role of config.roles) {
    for (const operation of config.operations) {
      decisions.set(`${role}\0${operation}`, config.grants[role][operation]);
    }
  }
  return Object.freeze({
    definition: config,
    allows(role: TRole, operation: TOperation): boolean {
      return config.grants[role][operation];
    },
    capabilities(role: TRole): readonly TOperation[] {
      return config.operations.filter((operation) => config.grants[role][operation]);
    },
    check(role: string, operation: string): PermissionCheckResult {
      if (!roleSet.has(role)) return { outcome: 'unknown_role', role };
      if (!operationSet.has(operation)) return { outcome: 'unknown_operation', operation };
      return decisions.get(`${role}\0${operation}`)
        ? { outcome: 'allowed' }
        : { outcome: 'denied' };
    },
  });
}
