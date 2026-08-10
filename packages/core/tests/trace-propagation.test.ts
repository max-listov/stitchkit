import { describe, expect, test } from 'bun:test';
import {
  createTraceContext,
  formatTraceparent,
  parseTraceparent,
  resolvePropagationContext,
} from '../src/observability/trace';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const PARENT_SPAN_ID = '0123456789abcdef';
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;

describe('MCP trace propagation values', () => {
  test('continues valid metadata and preserves bounded propagation fields', () => {
    const trace = resolvePropagationContext({
      traceparent: TRACEPARENT,
      tracestate: 'vendor=opaque',
      baggage: 'tenant=opaque,region=eu',
    });

    expect(trace).toMatchObject({
      traceId: TRACE_ID,
      parentSpanId: PARENT_SPAN_ID,
      tracestate: 'vendor=opaque',
      baggage: 'tenant=opaque,region=eu',
    });
    expect(trace.spanId).toHaveLength(16);
  });

  test('preserves an unsampled trace flag when forwarding the trace', () => {
    const trace = parseTraceparent(`00-${TRACE_ID}-${PARENT_SPAN_ID}-00`);
    if (!trace) throw new Error('valid unsampled traceparent was rejected');

    expect(trace.traceFlags).toBe('00');
    expect(formatTraceparent(trace)).toEndWith('-00');
  });

  test('accepts a forward-compatible version with well-formed extension data', () => {
    const trace = parseTraceparent(`01-${TRACE_ID}-${PARENT_SPAN_ID}-03-abcd`);
    if (!trace) throw new Error('valid future traceparent was rejected');

    expect(trace.traceFlags).toBe('03');
  });

  test('rejects forbidden versions and malformed future-version suffixes', () => {
    expect(parseTraceparent(`ff-${TRACE_ID}-${PARENT_SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_SPAN_ID}-01-b`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${PARENT_SPAN_ID}-01-extra`)).toBeNull();
  });

  test('uses ambient trace only when traceparent is absent', () => {
    const ambient = createTraceContext();
    const inherited = resolvePropagationContext({ baggage: 'key=value' }, ambient);
    const rejected = resolvePropagationContext(
      { traceparent: '00-00000000000000000000000000000000-0000000000000000-01' },
      ambient,
    );

    expect(inherited).toMatchObject({
      traceId: ambient.traceId,
      spanId: ambient.spanId,
      baggage: 'key=value',
    });
    expect(rejected.traceId).not.toBe(ambient.traceId);
    expect(rejected.parentSpanId).toBeUndefined();
  });

  test('drops oversized, malformed and over-member propagation values', () => {
    const trace = resolvePropagationContext({
      traceparent: TRACEPARENT,
      tracestate: Array.from({ length: 33 }, (_, index) => `v${index}=x`).join(','),
      baggage: 'unsafe=one\ntwo',
    });
    const oversized = resolvePropagationContext({
      traceparent: TRACEPARENT,
      tracestate: `vendor=${'x'.repeat(506)}`,
      baggage: `key=${'x'.repeat(8_189)}`,
    });

    expect(trace.tracestate).toBeUndefined();
    expect(trace.baggage).toBeUndefined();
    expect(oversized.tracestate).toBeUndefined();
    expect(oversized.baggage).toBeUndefined();
  });
});
