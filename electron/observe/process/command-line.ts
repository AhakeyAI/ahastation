/** Split quoted CLI arguments without evaluating shell syntax. Backslashes in paths survive. */
export function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === '\\' && command[i + 1] === '"' && quote !== "'") {
      token += '"'; i++; started = true;
    } else if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? '' : char; started = true;
    } else if (/\s/.test(char) && !quote) {
      if (started) tokens.push(token);
      token = ''; started = false;
    } else { token += char; started = true; }
  }
  if (quote) return []; // Incomplete quoting is not evidence of identity or cwd.
  if (started) tokens.push(token);
  return tokens;
}
