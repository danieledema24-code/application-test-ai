/** "1 page", "3 pages"; pass the plural when it isn't just +s. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
