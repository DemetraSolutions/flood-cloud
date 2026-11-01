import { main } from './main.ts';

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  loadEnvFile: () => process.loadEnvFile('.env'),
  info: (line) => console.log(line),
  error: (line) => console.error(line),
});
