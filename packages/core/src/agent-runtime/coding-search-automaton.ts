import {
  type RegexAssertion,
  type RegexNode,
  type UnitAtom,
  UnsupportedRegexSyntax,
} from './coding-search-regex-syntax';
import { Ahead, classify, unitClasses } from './coding-search-unit-classes';

/** Unrolled counted repetition and alternation stay below this many automaton states. */
export const MAX_REGEX_STATES = 16_384;
/** Construction steps, counted separately: an empty body repeated adds work, not states. */
const MAX_BUILD_STEPS = 4 * MAX_REGEX_STATES;
/** Cached deterministic states and transitions; the cache is flushed, never grown, past either. */
const MAX_CACHED_STATES = 4_096;
const MAX_CACHED_TRANSITIONS = 65_536;

type State =
  | { kind: 'unit'; atom: UnitAtom; next: number }
  | { kind: 'split'; next: number[] }
  | { kind: 'assert'; at: RegexAssertion; next: number }
  | { kind: 'accept' };

export function buildAutomaton(
  tree: RegexNode,
  check: () => void,
): { states: State[]; start: number } {
  const states: State[] = [{ kind: 'accept' }];
  let steps = 0;
  const add = (state: State): number => {
    if (states.length >= MAX_REGEX_STATES) {
      throw new UnsupportedRegexSyntax(`more than ${MAX_REGEX_STATES} matcher states`);
    }
    states.push(state);
    return states.length - 1;
  };
  // Continuation-passing Thompson construction: each node is built in front of `next`.
  const build = (node: RegexNode, next: number): number => {
    if (++steps > MAX_BUILD_STEPS) {
      throw new UnsupportedRegexSyntax(`more than ${MAX_BUILD_STEPS} construction steps`);
    }
    if (steps % 128 === 0) check();
    switch (node.kind) {
      case 'empty':
        return next;
      case 'unit':
        return add({ kind: 'unit', atom: node.atom, next });
      case 'assert':
        return add({ kind: 'assert', at: node.at, next });
      case 'sequence':
        return node.items.reduceRight((after, item) => build(item, after), next);
      case 'alternation':
        return add({ kind: 'split', next: node.options.map((option) => build(option, next)) });
      case 'repeat': {
        let tail = next;
        if (node.max === Number.POSITIVE_INFINITY) {
          const loop: State = { kind: 'split', next: [] };
          tail = add(loop);
          loop.next.push(build(node.body, tail), next);
        } else {
          for (let optional = node.min; optional < node.max; optional += 1) {
            tail = add({ kind: 'split', next: [build(node.body, tail), next] });
          }
        }
        for (let required = 0; required < node.min; required += 1)
          tail = build(node.body, tail);
        return tail;
      }
    }
  };
  return { states, start: build(tree, 0) };
}

/**
 * The closure of the start state in one assertion context. Every position restarts the
 * unanchored search there, so it is kept apart from the deterministic states: a pattern whose
 * start fans out to thousands of atoms does not copy that fan-out into every state.
 */
interface StartClosure {
  /** Equal closures in different contexts are one object with one id. */
  id: number;
  units: number[];
  accepts: boolean;
  byAtom: Map<UnitAtom, number[]>;
}

/** One deterministic state: the unit states reached at a position beyond the restart. */
interface Deterministic {
  start: StartClosure;
  own: number[];
  accepts: boolean;
  next: Map<number, Deterministic>;
}

/**
 * A compiled search expression. Matching walks the line once; each step is a cached
 * transition of the lazily built deterministic automaton, keyed by the unit's class. A cache
 * miss costs the state's own units plus the start atoms matching that class, so a line costs at
 * most states × UTF-16 units, the cache stays within its state and transition ceilings, and
 * every step can observe the caller's deadline.
 */
export interface SearchRegex {
  test(text: string): boolean;
}

const holds = (at: RegexAssertion, atStart: boolean, behind: Ahead, ahead: Ahead) => {
  switch (at) {
    case 'start':
      return atStart;
    case 'end':
      return ahead === Ahead.End;
    case 'line-start':
      return atStart || behind === Ahead.LineTerminator;
    case 'line-end':
      return ahead === Ahead.End || ahead === Ahead.LineTerminator;
    case 'word':
      return (behind === Ahead.Word) !== (ahead === Ahead.Word);
    case 'not-word':
      return (behind === Ahead.Word) === (ahead === Ahead.Word);
  }
};

/** Start-of-line flag, the unit behind and the unit ahead: everything an assertion reads. */
const KINDS: readonly Ahead[] = [Ahead.End, Ahead.Word, Ahead.LineTerminator, Ahead.Other];
const contextOf = (atStart: boolean, behind: Ahead, ahead: Ahead) =>
  (atStart ? 16 : 0) + behind * 4 + ahead;

export function lazyMatcher(
  { states, start }: { states: State[]; start: number },
  check: () => void,
): SearchRegex {
  let interned = new Map<string, Deterministic>();
  const initial = new Map<Ahead, Deterministic>();
  const starts = new Map<number, StartClosure>();
  const startsByUnits = new Map<string, StartClosure>();
  let startKernels = new Map<number, Map<number, number[]>>();
  let transitions = 0;
  let operations = 0;
  // Two capacity flushes mean the reachable state sets do not repeat (a counted gap after a
  // frequent unit makes one per subset of gap positions): caching costs more than it saves,
  // and the matcher simulates the automaton directly from then on.
  let flushes = 0;
  let simulating = false;
  const flush = () => {
    interned = new Map();
    initial.clear();
    startKernels = new Map();
    transitions = 0;
    if (++flushes >= 2) simulating = true;
  };
  const classes = unitClasses(
    states.flatMap((state) => (state.kind === 'unit' ? [state.atom] : [])),
    check,
  );
  // Visit marks for closures: a generation per call instead of a set per call.
  const seen = new Int32Array(states.length);
  let generation = 0;
  const closure = (kernel: number[], context: number) => {
    const atStart = context >= 16;
    const behind = KINDS[(context >> 2) & 3] ?? Ahead.Other;
    const ahead = KINDS[context & 3] ?? Ahead.Other;
    generation += 1;
    const units: number[] = [];
    let accepts = false;
    const pending = [...kernel];
    for (let index = pending.pop(); index !== undefined; index = pending.pop()) {
      if (seen[index] === generation) continue;
      seen[index] = generation;
      if (++operations % 128 === 0) check();
      const state = states[index];
      if (state?.kind === 'unit') units.push(index);
      else if (state?.kind === 'accept') accepts = true;
      else if (state?.kind === 'split') pending.push(...state.next);
      else if (state && holds(state.at, atStart, behind, ahead)) pending.push(state.next);
    }
    return { units, accepts };
  };
  const sorted = (units: number[]) => units.sort((left, right) => left - right);
  const startOf = (context: number): StartClosure => {
    let found = starts.get(context);
    if (!found) {
      const { units, accepts } = closure([start], context);
      sorted(units);
      const key = `${accepts ? 1 : 0}:${units.join(',')}`;
      found = startsByUnits.get(key);
      if (!found) {
        const byAtom = new Map<UnitAtom, number[]>();
        for (const index of units) {
          const state = states[index];
          if (state?.kind !== 'unit') continue;
          const next = byAtom.get(state.atom) ?? [];
          next.push(state.next);
          byAtom.set(state.atom, next);
        }
        found = { id: startsByUnits.size, units, accepts, byAtom };
        startsByUnits.set(key, found);
      }
      starts.set(context, found);
    }
    return found;
  };
  const enter = (kernel: number[], context: number): Deterministic => {
    const own = closure(kernel, context);
    sorted(own.units);
    const opening = startOf(context);
    const accepts = own.accepts || opening.accepts;
    const key = `${opening.id}:${accepts ? 1 : 0}:${own.units.join(',')}`;
    let found = interned.get(key);
    if (!found) {
      if (interned.size >= MAX_CACHED_STATES) flush();
      found = { start: opening, own: own.units, accepts, next: new Map() };
      interned.set(key, found);
    }
    return found;
  };
  const begin = (ahead: Ahead) => {
    let found = initial.get(ahead);
    if (!found) {
      found = enter([], contextOf(true, Ahead.End, ahead));
      initial.set(ahead, found);
    }
    return found;
  };
  /** Next states of the start closure's atoms that accept a unit of this class. */
  const startKernel = (opening: StartClosure, unitClass: number): number[] => {
    let byClass = startKernels.get(opening.id);
    if (!byClass) {
      byClass = new Map();
      startKernels.set(opening.id, byClass);
    }
    let found = byClass.get(unitClass);
    if (!found) {
      const matching = classes.atomsOf(unitClass);
      found = [];
      if (matching.length < opening.byAtom.size) {
        for (const atom of matching) found.push(...(opening.byAtom.get(atom) ?? []));
      } else {
        for (const [atom, next] of opening.byAtom) {
          if (++operations % 128 === 0) check();
          if (classes.matches(atom, unitClass)) found.push(...next);
        }
      }
      byClass.set(unitClass, found);
      transitions += 1;
    }
    return found;
  };
  /** The unit states after `own` and the restart read a unit of this class. */
  const advance = (opening: StartClosure, own: number[], unitClass: number): number[] => {
    const kernel = [...startKernel(opening, unitClass)];
    for (const index of own) {
      const state = states[index];
      if (state?.kind === 'unit' && classes.matches(state.atom, unitClass))
        kernel.push(state.next);
    }
    return kernel;
  };
  /** A cache miss: `unitClass` was just computed for `from`'s next unit. */
  const step = (from: Deterministic, unitClass: number, ahead: Ahead): Deterministic => {
    const key = unitClass * 4 + ahead;
    const kernel = advance(from.start, from.own, unitClass);
    const reached = enter(kernel, contextOf(false, classes.kindOf(unitClass), ahead));
    if (++transitions > MAX_CACHED_TRANSITIONS) flush();
    from.next.set(key, reached);
    return reached;
  };
  const { classOf } = classes;
  /** The same walk without interning: per unit, only the states active at that position. */
  const simulate = (text: string): boolean => {
    const length = text.length;
    let context = contextOf(
      true,
      Ahead.End,
      length === 0 ? Ahead.End : classify(text.charCodeAt(0)),
    );
    let own: number[] = [];
    let accepts = startOf(context).accepts;
    for (let position = 0; ; position += 1) {
      if (accepts) return true;
      if (position === length) return false;
      if ((position & 4_095) === 4_095) check();
      const after = position + 1;
      const ahead = after === length ? Ahead.End : classify(text.charCodeAt(after));
      const unitClass = classOf(text.charCodeAt(position));
      const kernel = advance(startOf(context), own, unitClass);
      context = contextOf(false, classes.kindOf(unitClass), ahead);
      const reached = closure(kernel, context);
      own = reached.units;
      accepts = reached.accepts || startOf(context).accepts;
    }
  };
  return {
    test(text) {
      if (simulating) return simulate(text);
      const length = text.length;
      let current = begin(length === 0 ? Ahead.End : classify(text.charCodeAt(0)));
      for (let position = 0; ; position += 1) {
        if (current.accepts) return true;
        if (position === length) return false;
        if ((position & 4_095) === 4_095) check();
        const after = position + 1;
        const ahead = after === length ? Ahead.End : classify(text.charCodeAt(after));
        const unitClass = classOf(text.charCodeAt(position));
        current = current.next.get(unitClass * 4 + ahead) ?? step(current, unitClass, ahead);
      }
    },
  };
}
