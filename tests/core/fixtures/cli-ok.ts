export {};

const stdin = await Bun.stdin.text();
const files = Object.fromEntries(
  await Promise.all(
    process.argv.slice(2).map(async (path) => [path, await Bun.file(path).text()] as const),
  ),
);
process.stdout.write(
  `${JSON.stringify({
    stdin,
    cwd: process.cwd(),
    files,
    workingDirectoryEnv: process.env.TEST_WORKING_DIRECTORY,
  })}\n`,
);
