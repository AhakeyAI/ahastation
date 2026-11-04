import type { Writable } from 'node:stream';

function isBrokenPipe(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPIPE';
}

/** A detached desktop app may outlive its launcher's stdout/stderr reader.
 * Diagnostic writes must not terminate the app after that reader closes.
 * This deliberately does not catch unrelated I/O or application errors. */
export function guardDiagnosticStream(stream: Writable): void {
  const write = stream.write;
  let brokenPipe: NodeJS.ErrnoException | undefined;
  stream.on('error', (error: Error) => {
    if (!isBrokenPipe(error)) throw error;
    brokenPipe = error;
  });
  stream.write = ((...args: unknown[]): boolean => {
    const failWrite = (error: NodeJS.ErrnoException): false => {
      brokenPipe = error;
      const callback = args.at(-1);
      if (typeof callback === 'function') process.nextTick(() => callback(error));
      return false;
    };
    if (brokenPipe) return failWrite(brokenPipe);
    try {
      return Reflect.apply(write, stream, args) as boolean;
    } catch (error) {
      if (isBrokenPipe(error)) return failWrite(error);
      throw error;
    }
  }) as typeof stream.write;
}

guardDiagnosticStream(process.stdout);
guardDiagnosticStream(process.stderr);
