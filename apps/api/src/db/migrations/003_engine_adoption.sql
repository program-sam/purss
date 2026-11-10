-- A replacement engine's identity waits here until its reconciliation queue is reviewed.
ALTER TABLE sync_checkpoints ADD COLUMN pending_engine_identity TEXT;
