{
  description = "sweep — Safe, fast artifact cleanup CLI for any project tree";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun
            nodejs_20
            rustc
            cargo
            clippy
            rustfmt
          ];
        };

        packages.default = pkgs.stdenv.mkDerivation {
          pname = "sweep";
          version = "0.2.0";
          src = ./.;
          buildInputs = [ pkgs.bun ];
          buildPhase = ''
            bun install --frozen-lockfile
            bun run build
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp apps/cli/dist/sweep.js $out/bin/sweep
            chmod +x $out/bin/sweep
          '';
        };
      }
    );
}
