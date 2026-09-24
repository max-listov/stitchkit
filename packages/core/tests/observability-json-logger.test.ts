import { describe, expect, test } from 'bun:test';
import { createJsonLogger, JSON_LOG_LEVELS } from '../src/observability/json-logger';

/*
 * The journal line is a contract with whatever reads it: a supervisor that
 * treats `"level":50` as an error, a developer piping it through pino-pretty,
 * and an operator who needs the cause of a startup failure without
 * reproducing it by hand.
 */

function capture(options: Parameters<typeof createJsonLogger>[0] = {}) {
  const lines: string[] = [];
  const logger = createJsonLogger({
    now: () => 1_700_000_000_000,
    write: (line) => lines.push(line),
    ...options,
  });
  return { logger, lines, records: () => lines.map((line) => JSON.parse(line)) };
}

describe('createJsonLogger', () => {
  test('one JSON object per line in pino shape: numeric level, epoch time, msg', () => {
    const { logger, lines, records } = capture({ fields: { service: 'bot' } });
    logger.info('polling started', { username: 'fixture_bot' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(records()[0]).toEqual({
      level: 30,
      time: 1_700_000_000_000,
      msg: 'polling started',
      service: 'bot',
      username: 'fixture_bot',
    });
    expect(JSON_LOG_LEVELS).toEqual({ debug: 20, info: 30, warn: 40, error: 50 });
  });

  test('an Error in any field is written with its name, message, stack and cause', () => {
    const { logger, records } = capture();
    const cause = new TypeError('socket closed');
    const failure = new Error('startup failed', { cause });
    logger.error('Application startup failed', {
      error: failure,
      nested: { err: new RangeError('bad port') },
    });
    const [record] = records();
    expect(record.level).toBe(50);
    expect(record.error).toMatchObject({ name: 'Error', message: 'startup failed' });
    expect(record.error.stack).toContain('startup failed');
    expect(record.error.cause).toMatchObject({ name: 'TypeError', message: 'socket closed' });
    expect(record.nested.err).toMatchObject({ name: 'RangeError', message: 'bad port' });
  });

  test('a call cannot rewrite the contract fields', () => {
    const { logger, records } = capture();
    logger.error('real', { level: 30, msg: 'fake', time: 1 });
    expect(records()[0]).toMatchObject({ level: 50, msg: 'real', time: 1_700_000_000_000 });
  });

  test('secrets are masked, including a pattern the application names', () => {
    const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    const { logger, lines } = capture({ sensitiveUrlPatterns: [/\d{6,}:[\w-]{30,}/] });
    logger.warn(`request to https://api.telegram.org/bot${token}/getMe failed`, {
      password: 'hunter2',
      error: new Error(`fetch https://api.telegram.org/bot${token}/getUpdates`),
    });
    expect(lines[0]).not.toContain(token);
    expect(lines[0]).not.toContain('hunter2');
  });

  test('lines below the level are not written', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.debug('noise');
    logger.info('noise');
    logger.warn('kept');
    expect(lines.map((line) => JSON.parse(line).msg)).toEqual(['kept']);
  });
});
