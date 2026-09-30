# Install AHJ Atlas on Windows

## Requirements

- A Windows 10 or 11 x64 computer and a standard Windows user account. This package is not an ARM64 build.
- Internet access and an Anthropic API key for research and project chat. Configure the key in **API & spending** after launch. Research may incur API charges.
- Edge or Chrome is **not** needed for ordinary search or reading public web pages and PDFs. The optional JavaScript page renderer currently requires an installed Edge or Chrome browser. It is used only when a public page needs JavaScript to show its text.

The installer includes the app runtime. You do not need to install Node.js or run `npm`.

## Download and check the installer

1. Open the project's [GitHub Releases](https://github.com/Abe-Borg/ahj-atlas/releases) page and choose a published Windows release.
2. Download `AHJ-Atlas-<version>-Windows-x64-Setup.exe` and `SHA256SUMS.txt` from the same release into one folder.
3. In PowerShell, change to that folder and run `Get-FileHash -Algorithm SHA256 -LiteralPath '.\AHJ-Atlas-<version>-Windows-x64-Setup.exe'`. Replace `<version>` with the release version.
4. Compare the 64-character hash with the hash on the matching filename line in `SHA256SUMS.txt`. If they differ, do not run the installer; download the files again from the release.

The installer and app are unsigned. Windows may show **Unknown publisher** or a SmartScreen warning. Check the source and checksum before deciding whether to proceed. Your organization may prevent unsigned software from running. Do not disable Windows security protections.

## Install, launch, and update

Run the installer under your normal Windows account. It first shows the AHJ Atlas license; read it and choose **I Agree** to continue. It installs for the current user, adds **AHJ Atlas** to the Start menu, and registers an uninstall entry in **Installed Apps**. Launch it from the Start menu. It opens its own desktop window; there is no `.cmd` launcher for installed users.

The installed app checks for a newer published Windows release when it opens and at most once every 24 hours while it remains open. Open **API & spending → App updates → Check for updates** to check again at any time. Checking never downloads or installs anything.

When an update is available, a banner offers **Download update** (the same button is under **App updates**). The app downloads the installer from the GitHub Release into `%LOCALAPPDATA%\AHJ Atlas\updates` and compares its SHA-256 with the release's `SHA256SUMS.txt` (and with GitHub's own asset digest when available). A mismatch deletes the file and nothing is installed. When the download is verified, choose **Restart and install**. The app closes, the installer upgrades it in place without showing its pages again (the license was accepted at first install), and AHJ Atlas reopens on the new version. Your workspace and remembered key are kept. The next launch tells you whether the update finished; if it did not, choose **Restart and install** again or install manually.

**Restart and install** waits until no research or chat reply is running. A submitted batch keeps running at Anthropic and is picked up again when the app reopens. Back up your data before an update.

The checksum shows the installer is the one published in that release; it does not prove who built it, because the installer is unsigned. To update manually instead, download the newer installer and checksum from the release page, verify the checksum as described above, close AHJ Atlas, and run the installer under the same Windows account.

## Data, backup, and removal

Projects, sources, chat, settings, and diagnostics are stored under `%LOCALAPPDATA%\AHJ Atlas\data`. A remembered API key is encrypted for the current Windows user in `%LOCALAPPDATA%\AHJ Atlas\credential.bin`. A normal uninstall leaves this folder intact, so reinstalling as the same user can reopen the workspace.

For a backup, close AHJ Atlas, then copy the entire `%LOCALAPPDATA%\AHJ Atlas` folder to a secure location. Keep the backup private: it contains project data and the protected credential. The encrypted key may not be usable from a different Windows account or computer; re-enter it there if needed.

To remove the app, use Windows **Settings → Apps → Installed Apps → AHJ Atlas → Uninstall**. To remove saved data too, first make any backup you want, then delete `%LOCALAPPDATA%\AHJ Atlas` manually after uninstall. Deleting that folder permanently removes the workspace and remembered key.

For source development instead of the installer, see the [README](../README.md#source-development).
