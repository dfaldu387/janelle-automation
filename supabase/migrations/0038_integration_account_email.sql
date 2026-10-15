-- The Google account an integration is actually connected to.
--
-- "Open in Gmail" links hardcoded /u/0/ — the FIRST account signed into
-- whatever Chrome profile is open, which is not the account that holds the
-- message. In a profile where the studio mailbox is the second or third
-- account, the link opened the wrong inbox. Targeting the account by its
-- email (?authuser=<address>) instead needs that address stored; the tokens
-- table never kept it. Captured on connect and on every ingest (the mailbox
-- reports its own address via the Gmail profile), so existing connections
-- backfill themselves on their next read.
alter table integrations
  add column if not exists account_email text;
