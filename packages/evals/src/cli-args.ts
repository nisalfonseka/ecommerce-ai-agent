export interface CliArgs {
  models: string[] | null;
  /** Case language, tag or id prefix. Named --only because pnpm reserves --filter. */
  only: string | null;
  out: string | null;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { models: null, only: null, out: null };
  const tokens = argv.filter((token) => token !== "--");
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--models")
      args.models = value
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
    else if (flag === "--only") args.only = value;
    else if (flag === "--out") args.out = value;
    else throw new Error(`Unknown flag ${flag}. Use --models, --only, --out.`);
  }
  return args;
}
