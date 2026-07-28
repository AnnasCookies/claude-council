export {};

const stdin = await Bun.stdin.text();
process.stdout.write(`${JSON.stringify({ stdin, cwd: process.cwd() })}\n`);
