// Intentionally wrong: the task is to fix this so `npm test` passes
// without touching anything under test/.
export function sum(values) {
  let total = 0;
  for (let i = 1; i < values.length; i += 1) {
    total += values[i];
  }
  return total;
}
