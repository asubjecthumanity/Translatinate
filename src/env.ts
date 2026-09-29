// Imported first by server.ts so .env is loaded before any module reads
// process.env (imports are evaluated before the importing module's body).
try {
  process.loadEnvFile(); // .env in the working directory, if there is one
} catch {
  // No .env file: rely on the real environment.
}
