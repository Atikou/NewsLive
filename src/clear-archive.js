import { clearNewsArchive } from "./persistence.js";

async function main() {
  await clearNewsArchive();
  // eslint-disable-next-line no-console
  console.log("All archived news cleared.");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Clear archive failed", error);
  process.exit(1);
});
