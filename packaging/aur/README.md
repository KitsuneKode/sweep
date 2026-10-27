# AUR packaging

`sweep-cli-bin/` is the source of truth for the AUR package
[`sweep-cli-bin`](https://aur.archlinux.org/packages/sweep-cli-bin). It installs
the released Linux binary (x86_64, aarch64) as `/usr/bin/sweep`, checked
against the release's SHA-256 sidecars. The names `sweep` and `sweep-bin` were
taken by other software, which is why it conflicts with both.

Each AUR package is its own git repository on aur.archlinux.org, pushed over
SSH with a key registered on the maintainer's AUR account.

## One-time setup

1. Create an account at <https://aur.archlinux.org/register>.
2. Make a key used only for the AUR, so it can be revoked on its own:

   ```sh
   ssh-keygen -t ed25519 -C "aur" -f ~/.ssh/aur
   ```

3. Paste `~/.ssh/aur.pub` into **My Account → SSH Public Key** on the AUR.
4. Tell SSH to use it for the AUR, in `~/.ssh/config`:

   ```
   Host aur.archlinux.org
     IdentityFile ~/.ssh/aur
     User aur
   ```

5. For automatic updates, add the private key `~/.ssh/aur` as the repository
   secret `AUR_SSH_PRIVATE_KEY` (Settings → Secrets and variables → Actions).
   Until it exists, the release workflow skips the AUR step with a notice.

## First publish

```sh
packaging/aur/sweep-cli-bin/update.sh 0.5.2        # the released version
cd packaging/aur/sweep-cli-bin && makepkg -f        # builds; does not install
git clone ssh://aur@aur.archlinux.org/sweep-cli-bin.git /tmp/aur-sweep
cp PKGBUILD .SRCINFO /tmp/aur-sweep/
cd /tmp/aur-sweep && git add PKGBUILD .SRCINFO && git commit -m "Initial import" && git push
```

Cloning a name that does not exist yet gives an empty repository; the first
push creates the package.

## Every release

`cli-binaries.yml` runs `update.sh <version>` after the binaries are attached,
then commits `PKGBUILD` and `.SRCINFO` to the AUR. `update.sh` writes
`.SRCINFO` itself, in makepkg's format, so it runs on the Ubuntu runner.

## Chaotic-AUR

[Chaotic-AUR](https://aur.chaotic.cx) builds selected AUR packages and serves
them prebuilt, so its users get `pacman -S sweep-cli-bin`. Request inclusion
with an issue on [chaotic-aur/packages](https://github.com/chaotic-aur/packages)
once the AUR package has a few releases and votes.
