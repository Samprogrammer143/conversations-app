// Types for scripts/dev-sandbox.mjs, for the tests that import it.
export declare const sandboxEnv: Record<string, string>;
export declare function collectE2eTranscripts(cwd: string, opts?: { claudeHome?: string; into?: string }): string[];
export declare function launchEnv(extra?: Record<string, string>): Record<string, string | undefined>;
