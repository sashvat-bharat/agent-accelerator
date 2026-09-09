export const fail = (err: any): never => {
  console.error(`\n\u2716 ${err?.message ?? err}\n`);
  process.exit(1);
};
