import { z } from 'zod';

export const AgentRecordVersionSchema = z.int().nonnegative();
export const AgentTimestampSchema = z.iso.datetime({ offset: true });
export const AgentJsonObjectSchema = z.record(z.string(), z.json());
