#!/usr/bin/env bash
#
# pi-browser install script
# Makes the pi-browser CLI available on PATH by creating a symlink
# or wrapper script in ~/.local/bin (macOS/Linux).
#
# This script is called by the Pi Coding Agent desktop app during startup
# if pi-browser is not found on PATH. It can also be run manually.

set -euo pipefail

# Resolve the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_SOURCE="${SCRIPT_DIR}/bin/pi-browser.mjs"

INSTALL_DIR="${HOME}/.local/bin"
INSTALL_TARGET="${INSTALL_DIR}/pi-browser"

# Check that the source exists
if [ ! -f "${BIN_SOURCE}" ]; then
  echo "[pi-browser] Source not found: ${BIN_SOURCE}" >&2
  exit 1
fi

# Ensure the source is executable
chmod +x "${BIN_SOURCE}"

# Create install directory
mkdir -p "${INSTALL_DIR}"

# Remove existing installation if present
if [ -f "${INSTALL_TARGET}" ] || [ -L "${INSTALL_TARGET}" ]; then
  rm -f "${INSTALL_TARGET}"
fi

# Create a wrapper script that runs the .mjs file with node
cat > "${INSTALL_TARGET}" << 'WRAPPER'
#!/usr/bin/env bash
exec node "$(dirname "$0")/../pi-browser-src/pi-browser.mjs" "$@"
WRAPPER

# Actually, simpler: just symlink directly
rm -f "${INSTALL_TARGET}"
ln -s "${BIN_SOURCE}" "${INSTALL_TARGET}"
chmod +x "${INSTALL_TARGET}"

echo "[pi-browser] Installed to ${INSTALL_TARGET}"

# Check if ~/.local/bin is on PATH
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*)
    # Already on PATH
    if command -v pi-browser >/dev/null 2>&1; then
      echo "[pi-browser] Ready: $(command -v pi-browser)"
    fi
    ;;
  *)
    echo "[pi-browser] WARNING: ${INSTALL_DIR} is not on your PATH"
    echo "[pi-browser] Add this to your shell profile (~/.zshrc or ~/.bashrc):"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac
