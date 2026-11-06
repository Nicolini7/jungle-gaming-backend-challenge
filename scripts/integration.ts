export {};

if (!process.env.DATABASE_URL || !process.env.SQS_ENDPOINT) {
  console.error("Set DATABASE_URL and SQS_ENDPOINT for real PostgreSQL and LocalStack/MiniStack.");
  process.exit(1);
}
const child = Bun.spawn([process.execPath, "test", "tests/integration", "--timeout", "60000"], {
  env: { ...process.env, RUN_INTEGRATION: "1" }, stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
