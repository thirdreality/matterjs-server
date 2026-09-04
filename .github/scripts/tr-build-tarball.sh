#!/bin/bash
# Build the ThirdReality matter-server release tarball (matter-server + bundled
# @matter-server/* workspace packages). Used by tr-release.yml; also runs locally.
#
# Usage: .github/scripts/tr-build-tarball.sh <version> [out-dir]
#   e.g. .github/scripts/tr-build-tarball.sh 1.4.0-tr.1
#
# Expects to run from the repo root with dependencies installed and dist built
# (`npm ci` does both via the prepare script).
#
# Note: `npm pack` ignores bundleDependencies for workspace symlinks (npm 9-11),
# so the bundled packages are packed individually and assembled by hand.
set -euo pipefail

VER="${1:?usage: tr-build-tarball.sh <version> [out-dir]}"
OUT="${2:-dist-release}"
BUNDLED=(custom-clusters ws-client ws-controller dashboard ble-proxy mqtt-bridge)

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

echo "[1] apply version $VER to workspace packages"
echo -n "$VER" > version.txt
node - "$VER" <<'EOF'
const fs = require("fs");
const ver = process.argv[2];
const pkgs = ["custom-clusters", "ws-controller", "ws-client", "dashboard", "ble-proxy", "mqtt-bridge", "matter-server"];
for (const p of pkgs) {
    const path = `packages/${p}/package.json`;
    const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
    pkg.version = ver;
    for (const section of ["dependencies", "devDependencies"]) {
        for (const dep of Object.keys(pkg[section] ?? {})) {
            if (dep.startsWith("@matter-server/")) pkg[section][dep] = ver;
        }
    }
    fs.writeFileSync(path, JSON.stringify(pkg, null, 4) + "\n");
}
EOF

echo "[2] hoist external deps of bundled packages into matter-server"
node - <<'EOF'
const fs = require("fs");
const bundled = ["custom-clusters", "ws-client", "ws-controller", "dashboard", "ble-proxy", "mqtt-bridge"];
const mainPath = "packages/matter-server/package.json";
const main = JSON.parse(fs.readFileSync(mainPath, "utf8"));
for (const p of bundled) {
    const deps = JSON.parse(fs.readFileSync(`packages/${p}/package.json`, "utf8")).dependencies ?? {};
    for (const [name, range] of Object.entries(deps)) {
        if (name.startsWith("@matter-server/")) continue;
        if (main.dependencies[name] === undefined) {
            main.dependencies[name] = range;
            console.log(`  + ${name}@${range} (from ${p})`);
        }
    }
}
main.dependencies = Object.fromEntries(Object.entries(main.dependencies).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(mainPath, JSON.stringify(main, null, 4) + "\n");
EOF

echo "[3] pack workspace packages"
rm -f "$OUT"/matter-server-*.tgz "$OUT"/matter-server-*.sha256
npm pack -w matter-server --pack-destination "$OUT" >/dev/null
for p in "${BUNDLED[@]}"; do
    npm pack -w "@matter-server/$p" --pack-destination "$OUT" >/dev/null
done

echo "[4] assemble the bundled tarball"
cd "$OUT"
rm -rf assemble && mkdir assemble && cd assemble
tar -xzf "../matter-server-$VER.tgz"
mkdir -p package/node_modules/@matter-server
for p in "${BUNDLED[@]}"; do
    mkdir -p "package/node_modules/@matter-server/$p"
    tar -xzf "../matter-server-$p-$VER.tgz" -C "package/node_modules/@matter-server/$p" --strip-components=1
done
tar -czf "../matter-server-$VER.tgz" package
cd .. && rm -rf assemble
for p in "${BUNDLED[@]}"; do rm -f "matter-server-$p-$VER.tgz"; done

echo "[5] smoke-verify the tarball"
for p in "${BUNDLED[@]}"; do
    tar -tzf "matter-server-$VER.tgz" "package/node_modules/@matter-server/$p/package.json" >/dev/null
done
verify_dir=$(mktemp -d)
(
    cd "$verify_dir"
    npm install --omit=dev --no-audit --no-fund "$OUT/matter-server-$VER.tgz" >/dev/null 2>&1
    installed=$(node -p "require('./node_modules/matter-server/package.json').version")
    [[ "$installed" == "$VER" ]] || { echo "FATAL: installed version $installed != $VER"; exit 1; }
    node node_modules/matter-server/dist/esm/MatterServer.js --help 2>/dev/null | grep -q "mqtt-url" \
        || { echo "FATAL: --help lacks mqtt-url"; exit 1; }
)
rm -rf "$verify_dir"

echo "[6] checksum"
sha256sum "matter-server-$VER.tgz" > "matter-server-$VER.tgz.sha256"
sha256sum -c "matter-server-$VER.tgz.sha256"

echo "DONE: $OUT/matter-server-$VER.tgz"
