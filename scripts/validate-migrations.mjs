import { readdir, readFile } from "node:fs/promises";

const files = (await readdir("migrations")).filter((file) => file.endsWith(".sql")).sort();
if (files.length === 0) throw new Error("No migrations found");
for (const [index, file] of files.entries()) {
  const expected = String(index + 1).padStart(4, "0");
  if (!file.startsWith(`${expected}_`))
    throw new Error(`Expected migration ${expected}, found ${file}`);
  const sql = await readFile(`migrations/${file}`, "utf8");
  if (!sql.trim()) throw new Error(`Migration ${file} is empty`);
  if (/DROP\s+TABLE/i.test(sql)) throw new Error(`Destructive DROP TABLE found in ${file}`);
}
console.log(`Validated ${files.length} immutable migration(s).`);
