/**
 * Generate the one-line installer, from the manifest, on the server.
 *
 * A `curl … | sh` runs on a machine where nothing is installed yet — including
 * `jq`. An installer that fetches the manifest and parses it therefore fails on
 * exactly the machines it exists for. Generating the script *from* the manifest,
 * with the URL and the digest already substituted, removes the dependency: the
 * script downloads one file, checks one digest and renames it into place.
 */
import type { CliBuildAsset, CliBuildManifest } from './cli-manifest';

export interface CliInstallerConfig {
  manifest: CliBuildManifest;
  /** The asset this script installs — one script per target. */
  asset: CliBuildAsset;
  /** The name the binary takes on the PATH; defaults to the manifest name. */
  binaryName?: string;
  /** Default install directory; overridable by `INSTALL_DIR` at run time. */
  installDir?: string;
}

/** Single-quote a value for POSIX sh — the script is generated, never guessed. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Render the installer for one asset.
 *
 * The three properties that matter, in the script rather than in a comment:
 * no JSON parsing, the digest is checked against the **decompressed** bytes, and
 * the final step is a rename — an interrupted download leaves a temporary file,
 * never a half-written executable on someone's PATH.
 */
export function renderCliInstaller(config: CliInstallerConfig): string {
  const binary = config.binaryName ?? config.manifest.name;
  const installDir = config.installDir ?? '$HOME/.local/bin';
  const decompress =
    config.asset.compression === 'gzip'
      ? '  gzip -dc "$tmp/download" > "$tmp/binary"\n'
      : '  mv "$tmp/download" "$tmp/binary"\n';
  return `#!/bin/sh
# ${binary} ${config.manifest.version} (${config.manifest.commit})
# Generated from the build manifest — it parses no JSON and needs no jq.
set -eu

url=${shellQuote(config.asset.url)}
sha256=${shellQuote(config.asset.sha256)}
size=${shellQuote(String(config.asset.size))}
binary=${shellQuote(binary)}
dir="\${INSTALL_DIR:-${installDir}}"

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2"
  else
    echo "need curl or wget" >&2
    exit 1
  fi
}

digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "need sha256sum, shasum or openssl" >&2
    exit 1
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch "$url" "$tmp/download"
${decompress}
actual="$(digest "$tmp/binary")"
if [ "$actual" != "$sha256" ]; then
  echo "checksum mismatch: expected $sha256, got $actual" >&2
  exit 1
fi

actual_size="$(wc -c < "$tmp/binary" | tr -d ' ')"
if [ "$actual_size" != "$size" ]; then
  echo "size mismatch: expected $size bytes, got $actual_size" >&2
  exit 1
fi

mkdir -p "$dir"
chmod 755 "$tmp/binary"
# A rename, never a write over the file in place: anything else can leave a
# half-written executable where a working one used to be.
mv "$tmp/binary" "$dir/$binary"

echo "installed $binary ${config.manifest.version} to $dir/$binary"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "note: $dir is not on your PATH" >&2 ;;
esac
`;
}
