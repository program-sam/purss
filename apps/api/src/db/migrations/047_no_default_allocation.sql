-- Hosted accounts have no storage limit unless an administrator sets one. Accounts that got the old
-- automatic 2 GiB lose it, and a pause it caused ends; any other allocation an administrator chose stays.
UPDATE storage_accounts SET allocation_bytes = NULL WHERE allocation_bytes = 2147483648;
UPDATE storage_accounts SET paused_reason = NULL WHERE paused_reason = 'quota' AND allocation_bytes IS NULL;
