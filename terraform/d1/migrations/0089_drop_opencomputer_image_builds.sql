-- Drop image builds left behind by the removed OpenComputer sandbox provider.
--
-- OpenComputer shut down its sandbox offering, so every artifact and session
-- these rows point at is already gone provider-side. The control plane no
-- longer has an adapter for them: status reads would skip them and the reaper
-- could never clean them up, so they would otherwise remain forever.

DELETE FROM image_builds WHERE provider = 'opencomputer';
