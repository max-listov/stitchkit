export {};

const [packageName, expectedVersion] = Bun.argv.slice(2);

if (!packageName || !expectedVersion) {
  throw new Error('Usage: bun scripts/wait-for-npm-publication.ts <package> <version>');
}

function isPackageManifest(value: unknown): value is { name: string; version: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'version' in value &&
    typeof value.version === 'string'
  );
}

// npm may accept a trusted publish well before the public registry serves that
// exact version: 0.96.0, 0.100.0 and 0.100.1 each took eight to eleven minutes
// (2026-09-24 and 2026-09-28), past the five minutes this used to wait, and each
// cost a manual rerun of a publish that had succeeded. Twenty minutes keeps the
// job alive across that processing instead of turning it into a false failure.
const attempts = 240;
const retryDelayMs = 5_000;
let lastFailure = 'the registry returned no response';

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const packagePath = `${encodeURIComponent(packageName)}/${encodeURIComponent(expectedVersion)}`;
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${packagePath}?attempt=${attempt}`,
      {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (response.ok) {
      const manifest: unknown = await response.json();
      if (
        isPackageManifest(manifest) &&
        manifest.name === packageName &&
        manifest.version === expectedVersion
      ) {
        console.log(
          `${packageName}@${expectedVersion} is available from the public npm registry`,
        );
        process.exit(0);
      }

      lastFailure = isPackageManifest(manifest)
        ? `the registry returned ${manifest.name}@${manifest.version}`
        : 'the registry returned invalid package metadata';
    } else {
      lastFailure = `the registry returned HTTP ${response.status}`;
    }
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error);
  }

  if (attempt < attempts) {
    console.warn(
      `Waiting for ${packageName}@${expectedVersion} (${attempt}/${attempts}): ${lastFailure}`,
    );
    await Bun.sleep(retryDelayMs);
  }
}

throw new Error(
  `${packageName}@${expectedVersion} did not become available from the public npm registry: ${lastFailure}`,
);
