import type { Context } from '@deepseek-ai/cordis';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        respire: {
            kind: 'respire';
        } & ContextFormed;
    }
}
export declare const name = "respire";
export declare const inject: string[];
export type GoalRecall = 'off' | 'first' | 'every';
export type RulesLocale = 'en' | 'zh' | 'bilingual';
export interface Config {
    enabled?: boolean;
    rsrsPath?: string;
    recallLimit?: number;
    recallThreshold?: number;
    budgetChars?: number;
    minPromptChars?: number;
    storeNudgeEvery?: number;
    goalRecall?: GoalRecall;
    goalRecallEvery?: number;
    goalNudgeEvery?: number;
    rulesLocale?: RulesLocale;
    timeoutMs?: number;
    obstacleRecall?: boolean;
    obstacleWindowSec?: number;
    obstacleRepeat?: number;
    obstacleHoldWrites?: boolean;
    obstacleHoldAfter?: number;
    obstacleHoldTtlSec?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, options?: Config): void;
