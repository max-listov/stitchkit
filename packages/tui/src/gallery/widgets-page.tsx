import { useEffect, useState } from 'react';
import {
  appendTerminalSample,
  createTerminalTimeSeries,
  type TerminalTimeSeries,
} from '../core/chart';
import { TerminalSpinnerKindSchema } from '../core/progress';
import { TerminalToneSchema } from '../core/theme';
import { TerminalChart, TerminalSparkline } from '../widgets/chart';
import { TerminalDetails, TerminalProgressBar, TerminalSpinner } from '../widgets/feedback';
import { TerminalPanel } from '../widgets/layout';
import { TerminalMeter } from '../widgets/meter';
import { useTerminalPalette } from '../widgets/theme';

/** Every small widget at once, moving on the clock, so a reader sees them live. */
export function WidgetsDemo({
  width,
  clock,
  startedAt,
}: {
  width: number;
  clock: () => number;
  startedAt: number;
}) {
  const palette = useTerminalPalette();
  const [now, setNow] = useState(clock);
  const [series, setSeries] = useState<TerminalTimeSeries>(() =>
    createTerminalTimeSeries({ windowMs: 30_000 }),
  );
  useEffect(() => {
    const timer = setInterval(() => {
      const at = clock();
      setNow(at);
      setSeries((current) =>
        appendTerminalSample(current, { at, value: 50 + 40 * Math.sin(at / 2500) }),
      );
    }, 250);
    return () => clearInterval(timer);
  }, [clock]);
  const half = Math.max(20, Math.floor((width - 2) / 2));
  const elapsed = now - startedAt;
  const load = (offset: number) => 50 + 50 * Math.sin(elapsed / 1700 + offset);
  return (
    <box style={{ flexDirection: 'row', gap: 2 }}>
      <box style={{ flexDirection: 'column', width: half }}>
        <TerminalPanel title='Progress' width={half}>
          <TerminalProgressBar
            label='upload'
            done={(elapsed / 40) % 1000}
            total={1000}
            startedAt={startedAt}
            now={now}
            width={half - 4}
            unit='kB'
          />
          <TerminalProgressBar
            label='sync'
            done={null}
            total={null}
            startedAt={startedAt}
            now={now}
            width={half - 4}
          />
          {TerminalSpinnerKindSchema.options.map((kind) => (
            <TerminalSpinner
              key={kind}
              kind={kind}
              label={`spinner ${kind}`}
              startedAt={startedAt}
              clock={clock}
            />
          ))}
        </TerminalPanel>
        <TerminalPanel title='Meters' width={half}>
          {['cpu', 'mem', 'swap', 'disk'].map((label, index) => (
            <TerminalMeter
              key={label}
              label={label}
              value={label === 'swap' ? null : load(index)}
              max={100}
              width={half - 4}
              labelWidth={4}
            />
          ))}
        </TerminalPanel>
      </box>
      <box style={{ flexDirection: 'column', width: half }}>
        <TerminalPanel title='Chart' badge='30s' width={half}>
          <TerminalChart
            series={[{ data: series, tone: 'accent' }]}
            now={now}
            width={half - 4}
            height={4}
            min={0}
            max={100}
            fill
          />
          <TerminalSparkline
            data={series}
            now={now}
            width={half - 4}
            tone='success'
            min={0}
            max={100}
          />
        </TerminalPanel>
        <TerminalPanel title='Details' width={half}>
          <TerminalDetails
            width={half - 4}
            pairs={[
              { key: 'status', value: 'running', tone: 'success' },
              { key: 'uptime', value: `${Math.floor(elapsed / 1000)}s` },
              {
                key: 'endpoint',
                value: 'https://example.invalid/a/very/long/path/that/is/cut',
              },
              { key: 'error', value: 'none', tone: 'muted' },
            ]}
          />
        </TerminalPanel>
        <TerminalPanel title='Palette' width={half}>
          {[TerminalToneSchema.options.slice(0, 3), TerminalToneSchema.options.slice(3)].map(
            (tones) => (
              <text key={tones.join()} wrapMode='none'>
                {tones.map((tone) => (
                  <span key={tone} fg={palette[tone]}>{`■ ${tone.padEnd(9)}`}</span>
                ))}
              </text>
            ),
          )}
        </TerminalPanel>
      </box>
    </box>
  );
}
