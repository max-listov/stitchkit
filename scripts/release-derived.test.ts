import { expect, test } from 'bun:test';
import { promoteMigrationHeading } from './release-derived';

test('the release metadata commit promotes one pending migration heading', () => {
  for (const pending of ['Upcoming', 'Unreleased']) {
    expect(
      promoteMigrationHeading(`# Guide\n\n## ${pending} migration: 0.103.4\n`, '0.103.4'),
    ).toBe('# Guide\n\n## Released migration: 0.103.4\n');
  }
  const released = '# Guide\n\n## Released migration: 0.103.4\n';
  // A second run and a guide with nothing pending are both left as they are.
  expect(promoteMigrationHeading(released, '0.103.4')).toBe(released);
  expect(promoteMigrationHeading('# Guide\n', '0.103.4')).toBe('# Guide\n');
  expect(() =>
    promoteMigrationHeading(
      '## Upcoming migration: 0.103.4\n## Unreleased migration: 0.103.4\n',
      '0.103.4',
    ),
  ).toThrow('one kind of pending migration heading');
});

test('slug migrations become subsections of the one released heading', () => {
  expect(
    promoteMigrationHeading(
      '# Guide\n\n## Unreleased migration: first\n\nA.\n\n## Unreleased migration: second\n\nB.\n',
      '0.103.4',
    ),
  ).toBe('# Guide\n\n## Released migration: 0.103.4\n\n### first\n\nA.\n\n### second\n\nB.\n');
  expect(() =>
    promoteMigrationHeading(
      '## Upcoming migration: 0.103.4\n## Unreleased migration: other\n',
      '0.103.4',
    ),
  ).toThrow('one kind of pending migration heading');
});

test('a slug whose section opens with its own ### heading leaves no empty subsection', () => {
  expect(
    promoteMigrationHeading(
      '# Guide\n\n## Unreleased migration: bun-floor\n\n### Bun floor\n\nA.\n\n## Unreleased migration: second\n\n### Second step\n\nB.\n\n## Unreleased migration: third\n\nC.\n\n## Released migration: 0.4.0\n',
      '0.5.0',
    ),
  ).toBe(
    '# Guide\n\n## Released migration: 0.5.0\n\n### Bun floor\n\nA.\n\n### Second step\n\nB.\n\n### third\n\nC.\n\n## Released migration: 0.4.0\n',
  );
});
