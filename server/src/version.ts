import pkg from "../package.json";

/** Release version, bumped together with apple/project.yml by scripts/release.sh. */
export const APP_VERSION: string = pkg.version;
