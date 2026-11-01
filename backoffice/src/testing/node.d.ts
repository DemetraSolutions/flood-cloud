/**
 * Minimal ambient typings for the Node.js APIs used by source-scanning specs.
 * Declared locally so that `@types/node` (not an approved dependency) is not needed.
 */
declare module 'node:fs' {
  export function readdirSync(
    path: string,
    options: { withFileTypes: true; recursive: true },
  ): {
    name: string;
    parentPath: string;
    isFile(): boolean;
  }[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
declare const process: { cwd(): string };
