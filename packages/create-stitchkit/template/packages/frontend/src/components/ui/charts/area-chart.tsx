'use client';

import type { Locale } from 'date-fns';
import { format } from 'date-fns';
import type { ReactNode } from 'react';
import {
  Area,
  AreaChart as RechartsAreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from 'recharts';

// =============================================================================
// Types
// =============================================================================

export interface AreaConfig {
  key: string;
  label: string;
  color: string;
  gradientOpacity?: { start: number; end: number };
}

export interface AreaChartDataPoint {
  day: string;
  [key: string]: string | number;
}

export interface AreaChartProps {
  data: AreaChartDataPoint[];
  areas: AreaConfig[];
  height?: number;
  dateLocale: Locale;
  dateFormat?: string;
  tooltipDateFormat?: string;
  renderTooltip?: (props: TooltipRenderProps) => ReactNode;
}

export interface TooltipRenderProps {
  date: string;
  values: { key: string; label: string; value: number; color: string }[];
}

// =============================================================================
// Constants
// =============================================================================

const TOOLTIP_CLASS =
  'bg-card border border-border rounded-lg p-3 shadow-lg animate-in fade-in duration-150';

// =============================================================================
// Component
// =============================================================================

export function AreaChart({
  data,
  areas,
  height = 280,
  dateLocale,
  dateFormat = 'd MMM',
  tooltipDateFormat = 'd MMMM yyyy',
  renderTooltip,
}: AreaChartProps) {
  return (
    <div className='w-full **:outline-none'>
      <ResponsiveContainer width='100%' height={height}>
        <RechartsAreaChart data={data} margin={{ top: 10, right: 0, left: 0, bottom: 20 }}>
          <defs>
            {areas.map((area) => (
              <linearGradient
                key={area.key}
                id={`gradient-${area.key}`}
                x1='0'
                y1='0'
                x2='0'
                y2='1'
              >
                <stop
                  offset='0%'
                  stopColor={area.color}
                  stopOpacity={area.gradientOpacity?.start ?? 0.4}
                />
                <stop
                  offset='100%'
                  stopColor={area.color}
                  stopOpacity={area.gradientOpacity?.end ?? 0.05}
                />
              </linearGradient>
            ))}
          </defs>

          <XAxis
            dataKey='day'
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
            dy={5}
            tickFormatter={(value) =>
              format(new Date(value), dateFormat, { locale: dateLocale })
            }
          />

          <Tooltip
            cursor={false}
            isAnimationActive={false}
            offset={20}
            wrapperStyle={{ zIndex: 10, outline: 'none' }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;

              const labelValue =
                typeof label === 'string' || typeof label === 'number' ? label : '';
              const formattedDate = format(new Date(labelValue), tooltipDateFormat, {
                locale: dateLocale,
              });

              const values = areas.map((area) => ({
                key: area.key,
                label: area.label,
                value: (() => {
                  const value = payload.find((point) => point.dataKey === area.key)?.value;
                  return typeof value === 'number' ? value : 0;
                })(),
                color: area.color,
              }));

              if (renderTooltip) {
                return renderTooltip({ date: formattedDate, values });
              }

              return (
                <div className={TOOLTIP_CLASS}>
                  <p className='font-medium text-sm mb-2'>{formattedDate}</p>
                  <div className='space-y-1 text-xs'>
                    {values.map(({ key, label, value, color }) => (
                      <div key={key} className='flex items-center gap-2'>
                        <div
                          className='w-2.5 h-2.5 rounded-full'
                          style={{ backgroundColor: color }}
                        />
                        <span className='text-muted-foreground'>{label}:</span>
                        <span className='font-medium'>{value.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            }}
          />

          {areas.map((area) => (
            <Area
              key={area.key}
              type='monotone'
              dataKey={area.key}
              stroke={area.color}
              strokeWidth={2}
              fill={`url(#gradient-${area.key})`}
              name={area.label}
            />
          ))}
        </RechartsAreaChart>
      </ResponsiveContainer>
    </div>
  );
}
