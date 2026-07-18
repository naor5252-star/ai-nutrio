import { readFile, writeFile } from "node:fs/promises";

const required = ["D1_DATABASE_ID", "R2_BUCKET_NAME", "APP_BASE_URL", "EMAIL_FROM"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing GitHub repository variable: ${key}`);
}
const input = await readFile("wrangler.jsonc", "utf8");
const output = input
  .replace("00000000-0000-0000-0000-000000000000", process.env.D1_DATABASE_ID)
  .replace("ai-nutrition-advisor-media", process.env.R2_BUCKET_NAME)
  .replace("https://example.com", process.env.APP_BASE_URL)
  .replace("noreply@example.com", process.env.EMAIL_FROM);
await writeFile("wrangler.deploy.jsonc", output);
