import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        respire: {
            kind: 'respire';
        };
    }
}
export declare const name = "respire";
export declare const inject: string[];
export interface Config {
    enabled?: boolean;
    rsrsPath?: string;
    recallLimit?: number;
    recallThreshold?: number;
    budgetChars?: number;
    minPromptChars?: number;
    storeNudgeEvery?: number;
    timeoutMs?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, options?: Config): void;
