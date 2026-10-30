import type { BootstrapOS } from "../shared/bootstrap.ts";

export interface BootstrapAsset { url: string; sha256: string }
/** Exact LF bytes validated from scripts/bootstrap; never use an unpinned branch URL. */
export const BOOTSTRAP_ASSETS: Record<BootstrapOS, BootstrapAsset> = {
  linux: { url: "https://github.com/kele-lega/ovis/releases/download/bootstrap-v1/ovis-bootstrap.sh", sha256: "a7006996c6654c81a13f876da728512aa84ea195855e69823513e4046f4fd5a9" },
  darwin: { url: "https://github.com/kele-lega/ovis/releases/download/bootstrap-v1/ovis-bootstrap.sh", sha256: "a7006996c6654c81a13f876da728512aa84ea195855e69823513e4046f4fd5a9" },
  windows: { url: "https://github.com/kele-lega/ovis/releases/download/bootstrap-v1/ovis-bootstrap.ps1", sha256: "76f75d2ad674927897c3023a73c17cb4de267741a9bbef4c79c3da917b82b45e" },
};
