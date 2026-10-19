import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
export interface Envelope {
    status: string;
    summary?: Record<string, unknown>;
    details?: unknown;
    items?: unknown[];
}
export declare class RsrsError extends Error {
    readonly code: 'unavailable' | 'timeout' | 'cancelled' | 'failed' | 'invalid-output';
    constructor(code: 'unavailable' | 'timeout' | 'cancelled' | 'failed' | 'invalid-output');
}
export declare function runRsrs(subprocess: SubprocessRuntime, executable: string, args: string[], cwd: string, signal: AbortSignal, timeoutMs: number): Promise<Envelope>;
