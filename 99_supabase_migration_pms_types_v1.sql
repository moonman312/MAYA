-- MAYA PMS Types v1 Migration
-- Adds 'think' to the pms_type enum so Think Reservations connections can be
-- created alongside existing 'mews' and 'cloudbeds'.
--
-- Run AFTER 02_supabase_schema.sql on existing databases. Fresh 02 loads
-- already include 'think' in the enum definition.
--
-- NOTE: `alter type ... add value` cannot run inside a wrapping transaction on
-- some Postgres versions. Run this file as a single statement in the Supabase
-- SQL Editor (the editor sends each top-level statement without a wrapping
-- BEGIN/COMMIT). If the ADD VALUE errors with "cannot run inside a transaction
-- block", disconnect any open transaction and rerun.

alter type public.pms_type add value if not exists 'think';
