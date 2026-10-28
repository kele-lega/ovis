import type { BootstrapOS } from "../shared/bootstrap.ts";

export interface BootstrapAsset { url: string; sha256: string }
/** Exact LF bytes validated from scripts/bootstrap; never use an unpinned branch URL. */
export const BOOTSTRAP_ASSETS: Record<BootstrapOS, BootstrapAsset> = {
  linux: { url: "https://github.com/kele-lega/ovis/releases/download/bootstrap-v1/ovis-bootstrap.sh", sha256: "a7006996c6654c81a13f876da728512aa84ea195855e69823513e4046f4fd5a9" },
  darwin: { url: "https://github.com/kele-lega/ovis/releases/download/bootstrap-v1/ovis-bootstrap.sh", sha256: "a7006996c6654c81a13f876da728512aa84ea195855e69823513e4046f4fd5a9" },
  windows: { url: "https://github.com/kele-lega/ovis/releases/download/bootstrap-v1/ovis-bootstrap.ps1", sha256: "273ce0f34134cb21018561e3316d99b328c8fa9d90458d987cfa218ca05dd8fa" },
};
