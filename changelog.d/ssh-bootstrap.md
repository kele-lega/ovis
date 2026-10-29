### Added
- Generate a verified, per-PC first-time SSH authorization command from Tailscale discovery,
  then connect with a dedicated key while retaining fingerprint and installation approval.
  Expired attempts discard only pending local credentials; explicit cleanup and optional remote
  revocation remove the corresponding public key without stopping SSH or herdr.
