import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const output = join(root, "dist");
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();

if (!supabaseUrl || !publishableKey) {
  throw new Error("Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in the Vercel project environment variables.");
}
if (!/^https:\/\/.+\.supabase\.co\/?$/.test(supabaseUrl)) {
  throw new Error("SUPABASE_URL must be the HTTPS Project URL from Supabase → Settings → API.");
}
if (!publishableKey.startsWith("sb_publishable_") && !publishableKey.startsWith("eyJ")) {
  throw new Error("SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key (sb_publishable_...) or legacy anon key.");
}

await mkdir(output, { recursive: true });
for (const directory of ["assets", "gate", "p", "vendor", "images"]) {
  await cp(join(root, directory), join(output, directory), { recursive: true, force: true });
}
for (const file of ["index.html", "README.md", "schema.sql", ".nojekyll"]) {
  await cp(join(root, file), join(output, file), { force: true });
}

const browserConfig = {
  supabaseUrl,
  supabasePublishableKey: publishableKey,
  emailSignIn: false,
  googleSignIn: true,
};
await writeFile(join(output, "config.js"), `window.GATEPASS = ${JSON.stringify(browserConfig, null, 2)};\n`);
console.log("Built static site with Vercel Supabase environment variables.");
