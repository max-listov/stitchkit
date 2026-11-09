interface GlobState {
  epsilon: number[];
  edges: { kind: 'literal' | 'segment' | 'dot'; value?: string; next: number }[];
}

/** One finite automaton for full matches and directory-prefix reachability. */
export function compileWorkspaceGlob(pattern: string, check?: () => void) {
  let operations = 0;
  const checkpoint = () => {
    if (++operations % 128 === 0) check?.();
  };
  const states: GlobState[] = [{ epsilon: [], edges: [] }];
  const add = () => {
    states.push({ epsilon: [], edges: [] });
    return states.length - 1;
  };
  let current = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    checkpoint();
    const state = states[current];
    if (!state) throw new Error('Missing glob state');
    const character = pattern[index];
    const next = add();
    if (character === '*' && pattern[index + 1] === '*') {
      state.epsilon.push(next);
      if (pattern[index + 2] === '/') {
        const segment = add();
        state.edges.push({ kind: 'segment', next: segment });
        states[segment]?.edges.push(
          { kind: 'segment', next: segment },
          { kind: 'literal', value: '/', next: current },
        );
        index += 2;
      } else {
        state.edges.push({ kind: 'dot', next: current });
        index += 1;
      }
    } else if (character === '*') {
      state.epsilon.push(next);
      state.edges.push({ kind: 'segment', next: current });
    } else {
      state.edges.push(
        character === '?'
          ? { kind: 'segment', next }
          : { kind: 'literal', value: character, next },
      );
    }
    current = next;
  }
  const accepting = current;
  const closure = (initial: Iterable<number>): Set<number> => {
    const reached = new Set(initial);
    for (const index of reached) {
      checkpoint();
      for (const next of states[index]?.epsilon ?? []) reached.add(next);
    }
    return reached;
  };
  const advance = (active: Set<number>, character: string): Set<number> => {
    const next = new Set<number>();
    for (const index of active) {
      checkpoint();
      for (const edge of states[index]?.edges ?? []) {
        if (
          edge.kind === 'literal'
            ? character === edge.value
            : edge.kind === 'segment'
              ? character !== '/'
              : !'\n\r\u2028\u2029'.includes(character)
        ) {
          next.add(edge.next);
        }
      }
    }
    return closure(next);
  };
  const consume = (value: string): Set<number> => {
    let active = closure([0]);
    // The glob language operates on UTF-16 units, like a RegExp without `u`.
    for (let index = 0; index < value.length && active.size > 0; index += 1) {
      active = advance(active, value.charAt(index));
    }
    return active;
  };
  return {
    test: (value: string): boolean => consume(value).has(accepting),
    mayContain: (directory: string): boolean => {
      const active = consume(`${directory}/`);
      // A descendant starts with a nonempty entry name. Every constructed state can
      // reach acceptance; retaining extra viable prefixes is safe, pruning one is not.
      return [...active].some((index) =>
        states[index]?.edges.some((edge) => edge.kind !== 'literal' || edge.value !== '/'),
      );
    },
  };
}
