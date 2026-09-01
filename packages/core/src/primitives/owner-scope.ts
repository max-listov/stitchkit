const ownerScopeBrand: unique symbol = Symbol('stitchkit.owner.scope');

export type OwnerScope<TOwner extends string = string> =
  | {
      readonly kind: 'owner';
      readonly ownerId: TOwner;
      readonly [ownerScopeBrand]: true;
    }
  | {
      readonly kind: 'all';
      readonly permission: 'acrossAllOwners';
      readonly [ownerScopeBrand]: true;
    };

export type OwnerScopeResolution<TOwner extends string> =
  | { readonly outcome: 'resolved'; readonly scope: OwnerScope<TOwner> }
  | { readonly outcome: 'owner_missing' }
  | { readonly outcome: 'across_all_forbidden' };

export interface OwnerScopeDefinition<TIdentity, TOwner extends string> {
  readonly ownerId: (identity: TIdentity) => TOwner | undefined;
  readonly canAccessAll: (identity: TIdentity) => boolean;
}

function scopedOwner<TOwner extends string>(ownerId: TOwner): OwnerScope<TOwner> {
  const scope: OwnerScope<TOwner> = { kind: 'owner', ownerId, [ownerScopeBrand]: true };
  return Object.freeze(scope);
}

function allOwners<TOwner extends string>(): OwnerScope<TOwner> {
  const scope: OwnerScope<TOwner> = {
    kind: 'all',
    permission: 'acrossAllOwners',
    [ownerScopeBrand]: true,
  };
  return Object.freeze(scope);
}

/** Resolve an owner boundary from authenticated identity, never from handler input. */
export function defineOwnerScope<TIdentity, TOwner extends string>(
  definition: OwnerScopeDefinition<TIdentity, TOwner>,
) {
  return Object.freeze({
    definition,
    forIdentity(identity: TIdentity): OwnerScopeResolution<TOwner> {
      const ownerId = definition.ownerId(identity);
      return ownerId
        ? { outcome: 'resolved', scope: scopedOwner(ownerId) }
        : { outcome: 'owner_missing' };
    },
    acrossAllOwners(identity: TIdentity): OwnerScopeResolution<TOwner> {
      return definition.canAccessAll(identity)
        ? { outcome: 'resolved', scope: allOwners() }
        : { outcome: 'across_all_forbidden' };
    },
  });
}
