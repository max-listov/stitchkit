import { Component, type ReactNode } from 'react';

let instance: ErrorBoundary | null = null;

export function resetErrorBoundary() {
  if (instance?.state.error) instance.setState({ error: null });
}

// biome-ignore lint/style/useReactFunctionComponents: error boundaries have no hook equivalent — getDerivedStateFromError requires a class
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };
  override componentDidMount() {
    instance = this;
  }
  override componentWillUnmount() {
    instance = null;
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;

    const stack = this.state.error.stack ?? '';
    const source =
      stack
        .split('\n')
        .find((l) => l.includes('src/'))
        ?.trim() ?? '';
    const component = source.match(/at (\w+)/)?.[1] ?? 'unknown';

    return (
      <div
        style={{
          padding: 40,
          fontFamily: 'monospace',
          background: '#111',
          color: '#ff6b6b',
          height: '100vh',
        }}
      >
        <div style={{ fontSize: 11, color: '#444', marginBottom: 16 }}>
          render error in <span style={{ color: '#ff6b6b' }}>{component}</span>
        </div>
        <pre
          style={{ fontSize: 15, color: '#ff9b9b', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}
        >
          {this.state.error.message}
        </pre>
        <div style={{ marginTop: 32, fontSize: 11, color: '#333' }}>
          save fix → auto recovery
        </div>
      </div>
    );
  }
}
