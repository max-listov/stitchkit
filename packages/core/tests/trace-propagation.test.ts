import { describe, expect, test } from 'bun:test';
import { createTraceContext, resolvePropagationContext } from '../src/observability/trace';

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
