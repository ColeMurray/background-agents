-- Slack channel associations for environments (design §7.5, Slack Phase A).
--
-- Mirrors repo_metadata.channel_associations (0002): a JSON array of Slack
-- channel ids, consulted by the slack-bot classifier's channel-association
-- stage so a channel can route to an environment the same way it routes to a
-- repository. NULL means the environment has no channel associations.
--
-- Additive and dark until the environments routes read/write it; rollback =
-- stop reading the column, leave it inert.
ALTER TABLE environments ADD COLUMN channel_associations TEXT;
