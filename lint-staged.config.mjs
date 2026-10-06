export default {
  "*.{ts,tsx,mts,cts,js,mjs,cjs}": ["oxfmt --write", "oxlint --fix"],
  "*.{json,md,mdx}": ["oxfmt --write"],
  "*.rs": () => "cargo fmt --all",
};
