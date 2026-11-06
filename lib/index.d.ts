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
    timeoutMs?: number;
}
export declare const Config: z<Config>;
interface GoalMessageSource {
    kind: 'goal';
    goalId: string;
    revision: number;
    round: number;
}
interface TurnState {
    turn: number;
    processed: Set<string>;
    hadUser: boolean;
    hadGoal: boolean;
    goalRound: number;
    goalNudged: boolean;
    stored: boolean;
    reminded: boolean;
}
interface AgentState {
    checked: boolean;
    ready: boolean;
    rounds: number;
    goalKey?: string;
    statusRetryRound?: number;
    turn?: TurnState;
}
export declare function shouldRecallGoal(state: AgentState, source: GoalMessageSource, goalRecall: GoalRecall, every: number): boolean;
export declare function resolveConfig(options?: Config): {
    enabled: boolean;
    rsrsPath: string;
    recallLimit: number;
    recallThreshold: number;
    budgetChars: number;
    minPromptChars: number;
    storeNudgeEvery: number;
    goalRecall: GoalRecall;
    goalRecallEvery: number;
    goalNudgeEvery: number;
    timeoutMs: number;
};
export declare function apply(ctx: Context, options?: Config): void;
export {};
