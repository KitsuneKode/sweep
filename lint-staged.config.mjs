export default {
  "*.{ts,mts,cts}": ["oxfmt --write", "oxlint --fix"],
  "*.{json,md}": ["oxfmt --write"],
  "*.rs": () => "cargo fmt --all",
};
